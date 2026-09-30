import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";

const router = express.Router();

/** Fallback when there is no settings row yet, and the ceiling on any setting. */
const QUEUE_LIMIT_DEFAULT = 10000;
const QUEUE_LIMIT_MIN = 100;
const QUEUE_LIMIT_MAX = 100000;

/** Cached for a minute: this is read on every queue write. */
let cachedLimit: { value: number; at: number } | null = null;

/** The operator's queue length limit, clamped on read in case the stored value was edited by hand. */
async function queueLimit(): Promise<number> {
    if (cachedLimit && Date.now() - cachedLimit.at < 60_000) return cachedLimit.value;
    let value = QUEUE_LIMIT_DEFAULT;
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { maxQueueLength: true },
        });
        if (settings?.maxQueueLength) value = settings.maxQueueLength;
    } catch {
        // A settings read that fails must not stop somebody's queue saving.
    }
    value = Math.min(QUEUE_LIMIT_MAX, Math.max(QUEUE_LIMIT_MIN, Math.floor(value)));
    cachedLimit = { value, at: Date.now() };
    return value;
}

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", requireAuth, async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        const playbackState = await prisma.playbackState.findUnique({
            where: { userId },
        });

        if (!playbackState) {
            return res.json(null);
        }

        res.json(playbackState);
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            playbackType,
            trackId,
            audiobookId,
            podcastId,
            queue,
            currentIndex,
            isShuffle,
        } = req.body;

        // Validate required field
        if (!playbackType) {
            return res.status(400).json({ error: "playbackType is required" });
        }

        // Validate playback type
        const validPlaybackTypes = ["track", "audiobook", "podcast"];
        if (!validPlaybackTypes.includes(playbackType)) {
            logger.warn(`[PlaybackState] Invalid playbackType: ${playbackType}`);
            return res.status(400).json({ error: "Invalid playbackType" });
        }

        // Limit queue size and sanitize queue items to prevent database issues
        let safeQueue: any[] | null = null;
        if (Array.isArray(queue) && queue.length > 0) {
            // Only keep essential fields from each queue item to reduce JSON size
            // Filter out any invalid items first
            try {
                safeQueue = queue
                    .slice(0, await queueLimit())
                    .filter((item: any) => item && item.id) // Must have at least an ID
                    .map((item: any) => ({
                        id: String(item.id || ""),
                        title: String(item.title || "Unknown").substring(0, 500), // Limit title length
                        duration: Number(item.duration) || 0,
                        artist: item.artist ? {
                            id: String(item.artist.id || ""),
                            name: String(item.artist.name || "Unknown").substring(0, 200),
                        } : null,
                        album: item.album ? {
                            id: String(item.album.id || ""),
                            title: String(item.album.title || "Unknown").substring(0, 500),
                            coverArt: item.album.coverArt ? String(item.album.coverArt).substring(0, 1000) : null,
                        } : null,
                    }));
                
                // If sanitization removed all items, set to null
                if (safeQueue.length === 0) {
                    safeQueue = null;
                }
            } catch (sanitizeError: any) {
                logger.error("[PlaybackState] Queue sanitization failed:", sanitizeError?.message);
                safeQueue = null; // Fall back to null queue
            }
        }
        
        // A request without a `queue` is a partial update — a shuffle toggle, or a
        // track change within the queue the client already has. It must NOT clear
        // the stored queue: only an explicit array replaces it. Same for the fields
        // below; an omitted field is left alone rather than reset to its default.
        const queueProvided = Array.isArray(queue);

        const safeCurrentIndex = queueProvided
            ? Math.min(
                  Math.max(0, currentIndex || 0),
                  safeQueue?.length ? safeQueue.length - 1 : 0
              )
            : Math.max(0, currentIndex || 0);

        const queueUpdate = queueProvided
            ? {
                  queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                  currentIndex: safeCurrentIndex,
              }
            : typeof currentIndex === "number"
              ? { currentIndex: safeCurrentIndex }
              : {};

        const playbackState = await prisma.playbackState.upsert({
            where: { userId },
            update: {
                playbackType,
                // Omitted fields are left alone: native clients send partial updates.
                ...(trackId !== undefined ? { trackId: trackId || null } : {}),
                ...(audiobookId !== undefined ? { audiobookId: audiobookId || null } : {}),
                ...(podcastId !== undefined ? { podcastId: podcastId || null } : {}),
                ...queueUpdate,
                ...(typeof isShuffle === "boolean" ? { isShuffle } : {}),
            },
            create: {
                userId,
                playbackType,
                trackId: trackId || null,
                audiobookId: audiobookId || null,
                podcastId: podcastId || null,
                queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                currentIndex: safeCurrentIndex,
                isShuffle: isShuffle || false,
            },
        });

        res.json(playbackState);
    } catch (error: any) {
        logger.error("[PlaybackState] Error saving state:", error?.message || error);
        logger.error("[PlaybackState] Full error:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        if (error?.code) {
            logger.error("[PlaybackState] Error code:", error.code);
        }
        if (error?.meta) {
            logger.error("[PlaybackState] Prisma meta:", error.meta);
        }
        // Return more specific error for debugging
        res.status(500).json({ 
            error: "Internal server error",
            details: error?.message || "Unknown error"
        });
    }
});

// Clear playback state (when user stops playback completely)
router.delete("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        // deleteMany, so clearing state that is already gone succeeds; clients call
        // this to recover from state pointing at something deleted.
        const removed = await prisma.playbackState.deleteMany({
            where: { userId },
        });

        res.json({ success: true, cleared: removed.count });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
