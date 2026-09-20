/**
 * Last.fm rate-limit nudge — retired 2026-09-19.
 *
 * Kima no longer calls Last.fm (shared key dead; all sources replaced by
 * ListenBrainz / MusicBrainz / local centroid similarity). The route stays
 * mounted so any stale frontend build gets a clean 200 instead of a 404,
 * but there is nothing left to nudge about.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

router.get("/status", (_req: Request, res: Response) => {
    res.json({ ready: false });
});

router.post("/ack", (_req: Request, res: Response) => {
    res.json({ acknowledged: true });
});

export default router;
