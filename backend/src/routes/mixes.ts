import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
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

router.post("/mood", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const params = req.body;

        // Validate parameters
        const validKeys = [
            // Basic audio features
            "valence",
            "energy",
            "danceability",
            "acousticness",
            "instrumentalness",
            "arousal",
            "bpm",
            "keyScale",
            // Moods (bucket pool) and legacy head names
            "mood",
            "moodHappy",
            "moodSad",
            "moodRelaxed",
            "moodAggressive",
            "moodParty",
            // Other
            "limit",
        ];
        for (const key of Object.keys(params)) {
            if (!validKeys.includes(key)) {
                return res
                    .status(400)
                    .json({ error: `Invalid parameter: ${key}` });
            }
        }

        const mix = await programmaticPlaylistService.generateMoodOnDemand(
            userId,
            params
        );

        if (!mix) {
            return res.status(400).json({
                error: "Not enough tracks matching your criteria",
                suggestion:
                    "Try widening your parameters or wait for more tracks to be analyzed",
            });
        }

        // Load full track details
        const tracks = await prisma.track.findMany({
            where: {
                id: { in: mix.trackIds },
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

        logger.debug(
            `[MIXES] Generated mood-on-demand mix with ${mix.trackCount} tracks`
        );

        res.json({
            ...mix,
            tracks: orderedTracks,
        });
    } catch (error) {
        logger.error("Generate mood mix error:", error);
        res.status(500).json({ error: "Failed to generate mood mix" });
    }
});

/**
 * Available mood presets for the UI
 */
router.get("/mood/presets", asyncHandler(async (_req, res) => {
    // Each preset names a mood (the bucket pool: the head verdict, no score
    // cutoffs) plus non-mood seasoning (energy, tempo, scale).
    const presets = [
        {
            id: "happy",
            name: "Upbeat",
            color: "from-yellow-400 to-orange-500",
            params: { mood: "happy", energy: { min: 0.4 } },
        },
        {
            id: "sad",
            name: "Melancholic",
            color: "from-blue-600 to-indigo-700",
            params: { mood: "sad", keyScale: "minor" },
        },
        {
            id: "chill",
            name: "Calm",
            color: "from-teal-400 to-cyan-500",
            params: { mood: "chill", energy: { max: 0.55 } },
        },
        {
            id: "energetic",
            name: "High Energy",
            color: "from-red-500 to-orange-600",
            params: { arousal: { min: 0.6 }, energy: { min: 0.65 } },
        },
        {
            id: "focus",
            name: "Focus Mode",
            color: "from-purple-600 to-violet-700",
            params: {
                mood: "chill",
                instrumentalness: { min: 0.5 },
                energy: { min: 0.2, max: 0.6 },
            },
        },
        {
            id: "dance",
            name: "Energetic",
            color: "from-pink-500 to-rose-600",
            params: {
                mood: "party",
                danceability: { min: 0.6 },
                energy: { min: 0.5 },
            },
        },
        {
            id: "acoustic",
            name: "Acoustic Vibes",
            color: "from-amber-500 to-yellow-600",
            // CLAP's acousticness: acoustic vs electronic is not a mood.
            params: {
                acousticness: { min: 0.6 },
            },
        },
        {
            id: "dark",
            name: "Dark & Moody",
            color: "from-gray-700 to-slate-800",
            params: { mood: "aggressive", keyScale: "minor" },
        },
        {
            id: "romantic",
            name: "Romantic",
            color: "from-rose-500 to-pink-600",
            params: {
                mood: "chill",
                acousticness: { min: 0.3 },
                energy: { max: 0.6 },
            },
        },
        {
            id: "workout",
            name: "Workout Beast",
            color: "from-green-500 to-emerald-600",
            params: {
                arousal: { min: 0.6 },
                energy: { min: 0.7 },
                bpm: { min: 110 },
            },
        },
        {
            id: "sleepy",
            name: "Sleep & Unwind",
            color: "from-indigo-400 to-purple-500",
            params: { mood: "chill", energy: { max: 0.35 } },
        },
        {
            id: "confident",
            name: "Confidence Boost",
            color: "from-amber-400 to-orange-500",
            params: {
                mood: "happy",
                energy: { min: 0.5 },
                danceability: { min: 0.5 },
            },
        },
    ];

    res.json(presets);
}));

/**
 * Save user's mood mix preferences
 * These preferences are used to generate "Your Mood Mix" in the mix rotation
 */
router.post("/mood/save-preferences", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const params = req.body;

        // Validate that at least some params are provided
        if (!params || Object.keys(params).length === 0) {
            return res
                .status(400)
                .json({ error: "No mood parameters provided" });
        }

        // Save to user record
        await prisma.user.update({
            where: { id: userId },
            data: { moodMixParams: params },
        });

        // Invalidate mix cache so the new mood mix appears
        const cacheKey = `mixes:${userId}`;
        await redisClient.del(cacheKey);

        logger.debug(`[MIXES] Saved mood mix preferences for user ${userId}`);

        res.json({ success: true, message: "Mood preferences saved" });
    } catch (error) {
        logger.error("Save mood preferences error:", error);
        res.status(500).json({ error: "Failed to save mood preferences" });
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
