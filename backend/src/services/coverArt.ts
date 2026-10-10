import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";

class CoverArtService {
    private readonly baseUrl = "https://coverartarchive.org";

    private async cacheResult(cacheKey: string, ttlSeconds: number, value: string): Promise<void> {
        try {
            await redisClient.setex(cacheKey, ttlSeconds, value);
        } catch (err) {
            logger.warn("Redis set error:", err);
        }
    }

    async getCoverArt(rgMbid: string): Promise<string | null> {
        const cacheKey = `caa:${rgMbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") return null; // Cached negative result
            if (cached) return cached;
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            // Use rate limiter to prevent overwhelming Cover Art Archive
            const response = await rateLimiter.execute("coverart", () =>
                axios.get(`${this.baseUrl}/release-group/${rgMbid}`, {
                    // The Cover Art Archive is slow; cold responses often exceed axios's default.
                    timeout: 15000,
                })
            );

            const images = response.data.images || [];
            const frontImage =
                images.find((img: any) => img.front) || images[0];

            if (frontImage) {
                const coverUrl =
                    frontImage.thumbnails?.large || frontImage.image;

                await this.cacheResult(cacheKey, 2592000, coverUrl); // 30 days
                return coverUrl;
            }

            await this.cacheResult(cacheKey, 604800, "NOT_FOUND"); // 7 days
        } catch (error: any) {
            if (error.response?.status === 404) {
                await this.cacheResult(cacheKey, 604800, "NOT_FOUND"); // 7 days
                return null;
            }
            // Anything but a 404 is a failed request, not "no cover".
            logger.warn(`Cover art error for ${rgMbid}:`, error.message);
            throw error;
        }

        return null;
    }
}

export const coverArtService = new CoverArtService();
