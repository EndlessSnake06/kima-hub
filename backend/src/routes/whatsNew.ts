/**
 * The release window's endpoints.
 *
 * Mounted at /api/whats-new rather than /api/releases — that path already
 * belongs to the Release Radar, which is about music coming out, not about this
 * application changing.
 *
 * The server decides what is pending and what a dismissal means. A client can
 * report a decision and can close a window; it cannot assert that a release was
 * already seen, because that would be a way to suppress a consent prompt.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { dismissRelease, findRelease, pendingReleases, setChoice } from "../services/releases";
import { analysePlayHistory, repairPlayHistory } from "../services/playHistoryRepair";

const router = Router();
router.use(requireAuth);

/** GET /whats-new/pending — what this user still needs shown, oldest first. */
router.get("/pending", async (req, res) => {
    try {
        res.json({ releases: await pendingReleases(req.user!.id) });
    } catch (error) {
        logger.error("[WhatsNew] pending failed:", error);
        res.status(500).json({ error: "Failed to load releases" });
    }
});

const choiceSchema = z.object({ key: z.string().min(1), enabled: z.boolean() });

/** POST /whats-new/:version/choice — record an explicit answer. */
router.post("/:version/choice", async (req, res) => {
    try {
        const { version } = req.params;
        if (!findRelease(version)) return res.status(404).json({ error: "Unknown release" });

        const { key, enabled } = choiceSchema.parse(req.body);
        await setChoice({ userId: req.user!.id, version, key, enabled });
        res.json({ key, enabled, decidedBy: "EXPLICIT" });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        logger.error("[WhatsNew] choice failed:", error);
        res.status(500).json({ error: "Failed to record choice" });
    }
});

/**
 * POST /whats-new/:version/dismiss — close it.
 *
 * Anything unanswered is settled here at its default. The response names the
 * keys that covered, so the client can show what was just decided on the user's
 * behalf rather than hiding it.
 */
router.post("/:version/dismiss", async (req, res) => {
    try {
        const { version } = req.params;
        if (!findRelease(version)) return res.status(404).json({ error: "Unknown release" });

        const { recordedDefaults } = await dismissRelease(req.user!.id, version);
        res.json({ version, dismissed: true, recordedDefaults });
    } catch (error) {
        logger.error("[WhatsNew] dismiss failed:", error);
        res.status(500).json({ error: "Failed to dismiss release" });
    }
});

// ── The play-history repair, the first `action` a release offers ─────────────
//
// Two endpoints on purpose. Nobody should be able to trigger a delete by
// following a link: you look first, then you agree to what you saw.

/** GET /whats-new/actions/play-history — read-only. Nothing is modified. */
router.get("/actions/play-history", async (req, res) => {
    try {
        res.json(await analysePlayHistory(req.user!.id));
    } catch (error) {
        logger.error("[PlayRepair] analysis failed:", error);
        res.status(500).json({ error: "Failed to analyse play history" });
    }
});

/**
 * POST /whats-new/actions/play-history/repair — do it.
 *
 * Verdicts are re-derived here rather than taken from the request, so what is
 * deleted is decided against the data as it stands, not against whatever a
 * browser tab computed some minutes ago.
 */
router.post("/actions/play-history/repair", async (req, res) => {
    try {
        res.json(await repairPlayHistory(req.user!.id));
    } catch (error) {
        logger.error("[PlayRepair] repair failed:", error);
        res.status(500).json({ error: "Failed to repair play history" });
    }
});

export default router;
