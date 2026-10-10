import crypto from "crypto";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { logger } from "../utils/logger";
import { isMbid } from "./artistIdentity";
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

    /**
     * The artist's Wikipedia summary and Wikidata image, `{}` when Wikidata has
     * no entry or the entry has neither; null when a source failed to answer, so
     * the caller keeps what it has and asks again later. Only answers are cached.
     */
    async getArtistInfo(
        artistName: string,
        mbid: string,
        opts: { interactive?: boolean } = {}
    ): Promise<WikidataResult | null> {
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
            const wikidataId = await this.getWikidataIdFromMBID(mbid, priority);

            let result: WikidataResult = {};
            if (wikidataId) {
                // One EntityData fetch answers both: the sitelink title feeds the
                // Wikipedia summary, the P18 claim the image.
                const entity = await this.getEntity(wikidataId, priority);
                const summary = await this.getSummaryFromEntity(entity, priority);
                const heroUrl = this.getImageFromEntity(wikidataId, entity);
                result = { summary, heroUrl };
            } else {
                logger.debug(`No Wikidata entry found for ${artistName}`);
            }

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
            logger.warn(`Wikidata fetch failed for ${artistName}; asked again later: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private async getWikidataIdFromMBID(
        mbid: string,
        priority = 0
    ): Promise<string | null> {
        // Only an id of MusicBrainz's own shape goes into the query text.
        if (!isMbid(mbid)) return null;
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

    private async getEntity(wikidataId: string, priority = 0): Promise<any | null> {
        const response = await this.wikidataGet(
            `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`,
            undefined,
            priority
        );
        return response.data.entities?.[wikidataId] ?? null;
    }

    /** The English Wikipedia summary; undefined when the entry has no English article. */
    private async getSummaryFromEntity(entity: any | null, priority = 0): Promise<string | undefined> {
        const enWikiTitle = entity?.sitelinks?.enwiki?.title;
        if (!enWikiTitle) return undefined;
        try {
            const summaryResponse = await this.wikidataGet(
                "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(enWikiTitle),
                undefined,
                priority
            );
            return summaryResponse.data.extract;
        } catch (error: any) {
            if (error?.response?.status === 404) return undefined;
            throw error;
        }
    }

    private getImageFromEntity(
        wikidataId: string,
        entity: any | null
    ): string | undefined {
        try {
            // P18 is "image". A preferred-rank claim is the one Wikidata recommends;
            // a deprecated one is known to be wrong.
            const claims: any[] = (entity?.claims?.P18 ?? []).filter((c: any) => c?.rank !== "deprecated");
            const claim = claims.find((c) => c?.rank === "preferred") ?? claims[0];
            const imageName = claim?.mainsnak?.datavalue?.value;
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
