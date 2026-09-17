/**
 * One-time-rate-limit nudge for the shared default Last.fm key.
 *
 * Mounted at /api/lastfm/nudge
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { notificationService } from "../services/notificationService";
import { lastFmService, LastFmService } from "../services/lastfm";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/lastfm/nudge/status
 * Whether the rate-limit nudge is currently ready to be surfaced to the
 * authenticated user.
 */
router.get("/status", async (req: Request, res: Response) => {
    try {
        res.json({ ready: LastFmService.needsNudge() });
    } catch (error: any) {
        logger.error("[LastFmNudge] status failed:", error);
        res.status(500).json({ error: "Failed to check nudge status" });
    }
});

/**
 * POST /api/lastfm/nudge/ack
 * Acknowledge the nudge: create a one-time notification for the user (so it
 * also appears in the notification bell) and reset the pending nudge flag so
 * it does not re-fire until the default key is rate-limited 3 more times.
 */
router.post("/ack", async (req: Request, res: Response) => {
    try {
        const userId = req.user!.id;

        await notificationService.notifySystem(
            userId,
            "Last.fm default key rate-limited",
            "The shared default Last.fm API key is exhausted. Add your own free API key in Settings > AI Services (registration is free at last.fm/api)."
        );

        LastFmService.acknowledgeNudge();

        res.json({ acknowledged: true });
    } catch (error: any) {
        logger.error("[LastFmNudge] ack failed:", error);
        res.status(500).json({ error: "Failed to acknowledge nudge" });
    }
});

export default router;
