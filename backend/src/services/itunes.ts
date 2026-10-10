import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";

interface ItunesPodcast {
    collectionId: number;
    collectionName: string;
    artistName: string;
    artworkUrl600?: string;
    artworkUrl100?: string;
    feedUrl: string;
    genres: string[];
    trackCount?: number;
    country?: string;
    primaryGenreName?: string;
    contentAdvisoryRating?: string;
    collectionViewUrl?: string;
}

class ItunesService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: "https://itunes.apple.com",
            timeout: 10000,
        });
    }

    private async cachedRequest<T>(
        cacheKey: string,
        requestFn: () => Promise<T>,
        ttlSeconds = 604800 // 7 days default
    ): Promise<T> {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        const data = await rateLimiter.execute("itunes", requestFn);

        try {
            await redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(data));
        } catch (err) {
            logger.warn("Redis set error:", err);
        }

        return data;
    }

    /**
     * Search for podcasts by term
     */
    async searchPodcasts(
        term: string,
        limit = 20
    ): Promise<ItunesPodcast[]> {
        const cacheKey = `itunes:search:${term}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/search", {
                    params: {
                        term,
                        media: "podcast",
                        entity: "podcast",
                        limit,
                    },
                });

                return response.data.results || [];
            },
            2592000 // 30 days - podcast catalog changes slowly
        );
    }

    /**
     * Extract primary keywords from podcast title/description for "similar podcasts" search
     */
    extractSearchKeywords(
        title: string,
        description?: string,
        author?: string
    ): string[] {
        const commonWords = new Set([
            "the",
            "a",
            "an",
            "and",
            "or",
            "but",
            "in",
            "on",
            "at",
            "to",
            "for",
            "of",
            "with",
            "by",
            "from",
            "up",
            "about",
            "into",
            "through",
            "during",
            "before",
            "after",
            "above",
            "below",
            "between",
            "under",
            "again",
            "further",
            "then",
            "once",
            "here",
            "there",
            "when",
            "where",
            "why",
            "how",
            "all",
            "both",
            "each",
            "few",
            "more",
            "most",
            "other",
            "some",
            "such",
            "no",
            "nor",
            "not",
            "only",
            "own",
            "same",
            "so",
            "than",
            "too",
            "very",
            "can",
            "will",
            "just",
            "should",
            "now",
            "podcast",
            "show",
            "episode",
            "episodes",
        ]);

        // Combine title and description
        const text = [title, description || "", author || ""]
            .join(" ")
            .toLowerCase()
            .replace(/[^\w\s]/g, " "); // Remove punctuation

        // Extract words, filter common words, and count occurrences
        const words = text.split(/\s+/).filter((word) => {
            return (
                word.length > 3 &&
                !commonWords.has(word) &&
                !/^\d+$/.test(word) // Remove pure numbers
            );
        });

        // Count word frequency
        const wordCount = new Map<string, number>();
        words.forEach((word) => {
            wordCount.set(word, (wordCount.get(word) || 0) + 1);
        });

        // Sort by frequency and take top 5
        const topWords = Array.from(wordCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);

        return topWords;
    }

    /**
     * Similar podcasts, by keywords from the title and description.
     */
    async getSimilarPodcasts(
        title: string,
        description?: string,
        author?: string,
        limit = 10
    ): Promise<ItunesPodcast[]> {
        const keywords = this.extractSearchKeywords(title, description, author);

        if (keywords.length === 0) {
            logger.debug(
                "No keywords extracted for similar podcast search, falling back to title"
            );
            return this.searchPodcasts(title, limit);
        }

        logger.debug(
            ` Searching for similar podcasts using keywords: ${keywords.join(", ")}`
        );

        // searchPodcasts holds the iTunes limiter slot and caches the search, so
        // it must not run inside another cachedRequest: the limiter runs one
        // request at a time and the nested call would wait on its own caller.
        const results = await this.searchPodcasts(keywords[0], limit * 2);

        // Drop the original podcast (titles that share its opening).
        const titleLower = title.toLowerCase();
        return results
            .filter(
                (podcast) =>
                    !podcast.collectionName.toLowerCase().includes(titleLower.slice(0, 20))
            )
            .slice(0, limit);
    }
}

export const itunesService = new ItunesService();
