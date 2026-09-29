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
import { UnknownChoiceError, dismissRelease, findRelease, GPU_CHOICE_KEY, pendingReleases, setChoice } from "../services/releases";
import { setGpuEnabled } from "../services/gpuRuntime";
import {
    MoodMixCannotKeepError,
    MoodMixNotFoundError,
    decideMoodMixes,
    moodMixState,
    saveMoodMixAsPlaylist,
} from "../services/releases/moodMixes";

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

/**
 * The 1.11 mood-mix question (see services/releases/moodMixes.ts). Registered
 * before the `/:version/...` routes so "mood-mixes" is never read as a version.
 */

/** GET /whats-new/mood-mixes — the user's saved mix, and what they decided. */
router.get("/mood-mixes", async (req, res) => {
    try {
        res.json(await moodMixState(req.user!.id));
    } catch (error) {
        logger.error("[WhatsNew] mood-mix state failed:", error);
        res.status(500).json({ error: "Failed to load your mood mix" });
    }
});

const moodMixDecisionSchema = z.object({ decision: z.enum(["rebuild", "keep", "remove"]) });

/**
 * POST /whats-new/mood-mixes/decision — rebuild or remove (both clear the saved
 * mix), or keep. Keep is refused for a mix under a removed mood.
 */
router.post("/mood-mixes/decision", async (req, res) => {
    try {
        const { decision } = moodMixDecisionSchema.parse(req.body);
        res.json(await decideMoodMixes(req.user!.id, decision));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        if (error instanceof MoodMixCannotKeepError) {
            return res.status(400).json({
                error: "This mood mix can't be shown any more. Save it as a playlist or remove it.",
            });
        }
        logger.error("[WhatsNew] mood-mix decision failed:", error);
        res.status(500).json({ error: "Failed to record your choice" });
    }
});

const moodMixSaveSchema = z.object({ mixId: z.string().min(1) });

/** POST /whats-new/mood-mixes/save — copy the saved mix into a playlist. */
router.post("/mood-mixes/save", async (req, res) => {
    try {
        const { mixId } = moodMixSaveSchema.parse(req.body);
        res.json(await saveMoodMixAsPlaylist(req.user!.id, mixId));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        if (error instanceof MoodMixNotFoundError) {
            return res.status(404).json({ error: "Mood mix not found" });
        }
        logger.error("[WhatsNew] mood-mix save failed:", error);
        res.status(500).json({ error: "Failed to save your mood mix" });
    }
});

const choiceSchema = z.object({ key: z.string().min(1), enabled: z.boolean() });

/** POST /whats-new/:version/choice — record an explicit answer. */
router.post("/:version/choice", async (req, res) => {
    try {
        const { version } = req.params;
        if (!findRelease(version)) return res.status(404).json({ error: "Unknown release" });

        const { key, enabled } = choiceSchema.parse(req.body);
        // The GPU choice writes a system setting, so it is applied through the
        // same service the Settings toggle uses — and only for an admin. The
        // window hides the question from everyone else; this route must not let
        // a forged POST smuggle a system change through a per-user endpoint.
        // The apply happens before the record: if the apply fails, nothing is
        // on the books that did not happen, and the client can retry cleanly.
        if (key === GPU_CHOICE_KEY) {
            if (req.user!.role !== "admin") {
                return res.status(403).json({ error: "Only admins can change GPU acceleration" });
            }
            await setGpuEnabled(enabled);
        }
        await setChoice({ userId: req.user!.id, version, key, enabled });
        res.json({ key, enabled, decidedBy: "EXPLICIT" });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        if (error instanceof UnknownChoiceError) {
            return res.status(400).json({ error: "Unknown choice" });
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
