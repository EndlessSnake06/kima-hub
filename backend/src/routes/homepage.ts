import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";

const router = Router();

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

/**
 * GET /homepage/top-podcasts
 * Get top podcasts (most subscribed or most recent episodes)
 */
router.get("/top-podcasts", async (req, res) => {
    try {
        const { limit = "6" } = req.query; // Get top 6 podcasts by default
        const limitNum = parseInt(limit as string, 10);

        // Check Redis cache first (cache for 24 hours)
        const cacheKey = `homepage:top-podcasts:${limitNum}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[HOMEPAGE] Cache HIT for top podcasts`);
                return res.json(JSON.parse(cached));
            }
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache read error:", cacheError);
        }

        logger.debug(
            `[HOMEPAGE] ✗ Cache MISS for top podcasts, fetching from database...`
        );

        // Get podcasts with episode counts
        const podcasts = await prisma.podcast.findMany({
            take: limitNum,
            orderBy: { createdAt: "desc" }, // Most recently added
            select: {
                id: true,
                title: true,
                author: true,
                description: true,
                imageUrl: true,
                _count: {
                    select: { episodes: true },
                },
            },
        });

        const result = podcasts.map((podcast) => ({
            id: podcast.id,
            title: podcast.title,
            author: podcast.author,
            description: podcast.description?.substring(0, 150) + "...",
            coverArt: podcast.imageUrl,
            episodeCount: podcast._count.episodes,
        }));

        // Cache for 24 hours
        try {
            await redisClient.setex(
                cacheKey,
                24 * 60 * 60,
                JSON.stringify(result)
            );
            logger.debug(`[HOMEPAGE] Cached top podcasts for 24 hours`);
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache write error:", cacheError);
        }

        res.json(result);
    } catch (error) {
        logger.error("Get top podcasts error:", error);
        res.status(500).json({ error: "Failed to fetch top podcasts" });
    }
});

export default router;
