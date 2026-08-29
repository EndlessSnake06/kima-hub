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

// Release `action` items do not run anything from here. The one that exists —
// the play-history audit — lives on the stats page and owns its own endpoints,
// because a maintenance tool people will want again should not be reachable
// only through a dialogue that appears once.

export default router;
