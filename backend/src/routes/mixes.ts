import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken, requireAdmin } from "../middleware/auth";
import { programmaticPlaylistService } from "../services/mixes";
import {
    moodBucketService,
    VALID_MOODS,
    MoodType,
} from "../services/moodBucketService";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { MOOD_MIX_LIMIT, validateSaveTrackIds } from "./mixesValidation";
import { rankForPosition } from "../utils/lexoRank";

const router = Router();

router.use(requireAuthOrToken);

const getRequestUserId = (req: any): string | null => {
    return req.user?.id || req.session?.userId || null;
};

router.get("/", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Check cache first (mixes are expensive to compute)
        const cacheKey = `mixes:${userId}`;
        const cached = await redisClient.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // Generate all mixes
        const mixes = await programmaticPlaylistService.generateAllMixes(
            userId
        );

        // Cache for 1 hour
        await redisClient.setex(cacheKey, 3600, JSON.stringify(mixes));

        res.json(mixes);
    } catch (error) {
        logger.error("Get mixes error:", error);
        res.status(500).json({ error: "Failed to get mixes" });
    }
});

router.get("/mood/buckets/presets", async (_req, res) => {
    try {
        const presets = await moodBucketService.getMoodPresets();
        res.json(presets);
    } catch (error) {
        logger.error("Get mood presets error:", error);
        res.status(500).json({ error: "Failed to get mood presets" });
    }
});

router.get("/mood/buckets/:mood", async (req, res) => {
    try {
        const mood = req.params.mood as MoodType;

        if (!VALID_MOODS.includes(mood)) {
            return res.status(400).json({
                error: `Invalid mood: ${mood}`,
                validMoods: VALID_MOODS,
            });
        }

        // Skip what this user was already served, then remember the ids this
        // mix actually went out with, so the next one doesn't repeat them.
        const userId = getRequestUserId(req);
        const remembered = userId
            ? await moodBucketService.getRememberedTrackIds(userId, mood)
            : [];

        const mix = await moodBucketService.getMoodMix(
            mood,
            MOOD_MIX_LIMIT,
            remembered
        );

        if (!mix) {
            return res.status(400).json({
                error: `Not enough tracks for mood: ${mood}`,
                suggestion: "Wait for more tracks to be analyzed",
            });
        }

        if (userId) {
            await moodBucketService.recordServedTracks(userId, mood, mix.trackIds);
        }

        // Load full track details
        const tracks = await prisma.track.findMany({
            where: { id: { in: mix.trackIds } },
            include: {
                album: {
                    include: {
                        artist: {
                            select: { id: true, name: true, mbid: true },
                        },
                    },
                },
            },
        });

        // Preserve mix order
        const orderedTracks = mix.trackIds
            .map((id: string) => tracks.find((t) => t.id === id))
            .filter((t: any) => t !== undefined);

        res.json({
            ...mix,
            tracks: orderedTracks,
        });
    } catch (error) {
        logger.error("Get mood bucket mix error:", error);
        res.status(500).json({ error: "Failed to get mood mix" });
    }
});

router.post("/mood/buckets/:mood/save", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const mood = req.params.mood as MoodType;

        if (!VALID_MOODS.includes(mood)) {
            return res.status(400).json({
                error: `Invalid mood: ${mood}`,
                validMoods: VALID_MOODS,
            });
        }

        // Validate optional trackIds from request body (pure helper — see tests).
        const validation = validateSaveTrackIds(req.body.trackIds, MOOD_MIX_LIMIT);
        if ("error" in validation) {
            return res.status(400).json({ error: validation.error });
        }
        const trackIds = validation.trackIds;

        const savedMix = await moodBucketService.saveUserMoodMix(
            userId,
            mood,
            MOOD_MIX_LIMIT,
            trackIds
        );

        if (!savedMix) {
            return res.status(400).json({
                error: `Not enough tracks for mood: ${mood}`,
                suggestion: "Wait for more tracks to be analyzed",
            });
        }

        // Invalidate mixes cache so home page refetches
        const cacheKey = `mixes:${userId}`;
        await redisClient.del(cacheKey);

        // Load full track details for immediate playback
        const tracks = await prisma.track.findMany({
            where: { id: { in: savedMix.trackIds } },
            include: {
                album: {
                    include: {
                        artist: {
                            select: { id: true, name: true, mbid: true },
                        },
                    },
                },
            },
        });

        // Preserve mix order
        const orderedTracks = savedMix.trackIds
            .map((id: string) => tracks.find((t) => t.id === id))
            .filter((t: any) => t !== undefined);

        logger.debug(
            `[MIXES] Saved mood bucket mix for user ${userId}: ${mood} (${savedMix.trackCount} tracks)`
        );

        res.json({
            success: true,
            mix: {
                ...savedMix,
                tracks: orderedTracks,
            },
        });
    } catch (error) {
        logger.error("Save mood bucket mix error:", error);
        res.status(500).json({ error: "Failed to save mood mix" });
    }
});

router.post("/mood/buckets/backfill", requireAdmin, async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        logger.debug(
            `[MIXES] Starting mood bucket backfill requested by user ${userId}`
        );

        const result = await moodBucketService.backfillAllTracks();

        res.json({
            success: true,
            processed: result.processed,
            assigned: result.assigned,
        });
    } catch (error) {
        logger.error("Backfill mood buckets error:", error);
        res.status(500).json({ error: "Failed to backfill mood buckets" });
    }
});

router.post("/refresh", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Clear cache
        const cacheKey = `mixes:${userId}`;
        await redisClient.del(cacheKey);

        // Regenerate mixes with random selection (not date-based)
        const mixes = await programmaticPlaylistService.generateAllMixes(
            userId,
            true
        );

        // Cache for 1 hour
        await redisClient.setex(cacheKey, 3600, JSON.stringify(mixes));

        res.json({ message: "Mixes refreshed", mixes });
    } catch (error) {
        logger.error("Refresh mixes error:", error);
        res.status(500).json({ error: "Failed to refresh mixes" });
    }
});

router.post("/:id/save", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const mixId = req.params.id;
        const customName = req.body.name;

        // Get the mix with track details
        const cacheKey = `mixes:${userId}`;
        let mixes;

        const cached = await redisClient.get(cacheKey);
        if (cached) {
            mixes = JSON.parse(cached);
        } else {
            mixes = await programmaticPlaylistService.generateAllMixes(userId);
            await redisClient.setex(cacheKey, 3600, JSON.stringify(mixes));
        }

        const mix = mixes.find((m: any) => m.id === mixId);

        if (!mix) {
            return res.status(404).json({ error: "Mix not found" });
        }

        const existingPlaylist = await prisma.playlist.findFirst({
            where: {
                userId,
                mixId: mix.id,
            },
            select: {
                id: true,
                name: true,
            },
        });

        if (existingPlaylist) {
            return res.status(409).json({
                error: "Mix already saved as playlist",
                playlistId: existingPlaylist.id,
                name: existingPlaylist.name,
            });
        }

        // Create playlist
        const playlist = await prisma.playlist.create({
            data: {
                userId,
                mixId: mix.id,
                name: customName || mix.name,
                isPublic: false,
            },
        });

        // `rank` is unique per playlist, so every item needs its own; the playlist
        // was just created empty, so positional ranks are correct.
        const playlistItems = mix.trackIds.map(
            (trackId: string, index: number) => ({
                playlistId: playlist.id,
                trackId,
                sort: index,
                rank: rankForPosition(index),
            })
        );

        await prisma.playlistItem.createMany({
            data: playlistItems,
        });

        logger.debug(
            `[MIXES] Saved mix ${mixId} as playlist ${playlist.id} (${mix.trackIds.length} tracks)`
        );

        res.json({
            id: playlist.id,
            name: playlist.name,
            trackCount: mix.trackIds.length,
        });
    } catch (error) {
        logger.error("Save mix as playlist error:", error);
        res.status(500).json({ error: "Failed to save mix as playlist" });
    }
});

router.get("/:id", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const mixId = req.params.id;

        // Get all mixes (from cache if available)
        const cacheKey = `mixes:${userId}`;
        let mixes;

        const cached = await redisClient.get(cacheKey);
        if (cached) {
            mixes = JSON.parse(cached);
        } else {
            mixes = await programmaticPlaylistService.generateAllMixes(userId);
            await redisClient.setex(cacheKey, 3600, JSON.stringify(mixes));
        }

        // Find the specific mix
        const mix = mixes.find((m: any) => m.id === mixId);

        if (!mix) {
            return res.status(404).json({ error: "Mix not found" });
        }

        // Load full track details
        const tracks = await prisma.track.findMany({
            where: {
                id: {
                    in: mix.trackIds,
                },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                                mbid: true,
                            },
                        },
                    },
                },
            },
        });

        // Preserve mix order
        const orderedTracks = mix.trackIds
            .map((id: string) => tracks.find((t) => t.id === id))
            .filter((t: any) => t !== undefined);

        res.json({
            ...mix,
            tracks: orderedTracks,
        });
    } catch (error) {
        logger.error("Get mix error:", error);
        res.status(500).json({ error: "Failed to get mix" });
    }
});

export default router;
