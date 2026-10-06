import crypto from "crypto";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { USER_AGENT } from "../config";
import { INTERACTIVE_PRIORITY, rateLimiter } from "./rateLimiter";

interface WikidataResult {
    summary?: string;
    heroUrl?: string;
}

class WikidataService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * Rate-limited Wikidata/Wikipedia GET. Routes every request through the
     * global rate limiter (service key "wikidata") instead of calling the
     * axios instance directly.
     */
    private wikidataGet(
        url: string,
        config?: AxiosRequestConfig,
        priority = 0
    ): Promise<AxiosResponse> {
        return rateLimiter.execute("wikidata", () => this.client.get(url, config), {
            priority,
        });
    }

    async getArtistInfo(
        artistName: string,
        mbid: string,
        opts: { interactive?: boolean } = {}
    ): Promise<WikidataResult> {
        const priority = opts.interactive ? INTERACTIVE_PRIORITY : 0;
        const cacheKey = `wikidata:${mbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            // Step 1: Query Wikidata for the MusicBrainz ID
            const wikidataId = await this.getWikidataIdFromMBID(mbid, priority);

            if (!wikidataId) {
                logger.debug(`No Wikidata entry found for ${artistName}`);
                return {};
            }

            // Step 2: one EntityData fetch answers both — the sitelink
            // title feeds the Wikipedia summary, the P18 claim the image.
            const entity = await this.getEntity(wikidataId, priority);
            const summary = await this.getSummaryFromEntity(
                wikidataId,
                entity,
                priority
            );
            const heroUrl = this.getImageFromEntity(wikidataId, entity);

            const result: WikidataResult = { summary, heroUrl };

            // Cache for 30 days
            try {
                await redisClient.setex(
                    cacheKey,
                    2592000,
                    JSON.stringify(result)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return result;
        } catch (error) {
            logger.error(`Wikidata fetch failed for ${artistName}:`, error);
            return {};
        }
    }

    private async getWikidataIdFromMBID(
        mbid: string,
        priority = 0
    ): Promise<string | null> {
        const sparqlQuery = `
      SELECT ?item WHERE {
        ?item wdt:P434 "${mbid}" .
      }
      LIMIT 1
    `;

        const response = await this.wikidataGet(
            "https://query.wikidata.org/sparql",
            {
                params: {
                    query: sparqlQuery,
                    format: "json",
                },
            },
            priority
        );

        const bindings = response.data.results?.bindings || [];
        if (bindings.length === 0) return null;

        const itemUrl = bindings[0].item.value;
        return itemUrl.split("/").pop() || null;
    }

    private async getEntity(
        wikidataId: string,
        priority = 0
    ): Promise<any | null> {
        try {
            const response = await this.wikidataGet(
                `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
                undefined,
                priority
            );
            return response.data.entities?.[wikidataId] ?? null;
        } catch (error) {
            logger.error(
                `Failed to fetch Wikidata entity ${wikidataId}:`,
                error
            );
            return null;
        }
    }

    private async getSummaryFromEntity(
        wikidataId: string,
        entity: any | null,
        priority = 0
    ): Promise<string | undefined> {
        try {
            const enWikiTitle = entity?.sitelinks?.enwiki?.title;

            if (!enWikiTitle) return undefined;

            // Get article summary from Wikipedia API
            const summaryResponse = await this.wikidataGet(
                "https://en.wikipedia.org/api/rest_v1/page/summary/" +
                    encodeURIComponent(enWikiTitle),
                undefined,
                priority
            );

            return summaryResponse.data.extract;
        } catch (error) {
            logger.error(
                `Failed to get Wikipedia summary for ${wikidataId}:`,
                error
            );
            return undefined;
        }
    }

    private getImageFromEntity(
        wikidataId: string,
        entity: any | null
    ): string | undefined {
        try {
            const imageProperty = entity?.claims?.P18; // P18 is "image"

            if (!imageProperty || imageProperty.length === 0) return undefined;

            const imageName = imageProperty[0].mainsnak?.datavalue?.value;
            if (!imageName) return undefined;

            // Convert to Wikimedia Commons URL
            const fileName = imageName.replace(/ /g, "_");
            const md5 = crypto
                .createHash("md5")
                .update(fileName)
                .digest("hex");
            const url = `https://upload.wikimedia.org/wikipedia/commons/${
                md5[0]
            }/${md5[0]}${md5[1]}/${encodeURIComponent(fileName)}`;

            return url;
        } catch (error) {
            logger.error(
                `Failed to get Wikidata image for ${wikidataId}:`,
                error
            );
            return undefined;
        }
    }
}

export const wikidataService = new WikidataService();
