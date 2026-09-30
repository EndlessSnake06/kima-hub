/**
 * ListenBrainz: similar artists (the artist–artist similarity dataset via
 * /1/lb-radio/artist/<mbid>, which requires pop_begin/pop_end), sitewide top
 * artists, and listen submission with the user's token. LB asks for at most
 * 1 request/s; the 'listenbrainz' rate limiter allows one per 1.1 s.
 */

import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import { USER_AGENT } from "../config";
import { prisma } from "../utils/db";
import { decrypt, isEncryptedFormat } from "../utils/encryption";

export interface SimilarArtist {
    name: string;
    mbid?: string;
    match: number; // 0-1 similarity score
    url: string;
}

export interface ChartArtist {
    type: "music";
    id: string;
    name: string;
    listeners: number;
    playCount: number;
    url: string;
    mbid: string;
}

const LB_BASE = process.env.LISTENBRAINZ_API_URL || "https://api.listenbrainz.org";
/** 7 days: similarity data changes slowly. */
const SIMILAR_TTL = 604800;

class ListenBrainzService {
    private client = axios.create({
        baseURL: LB_BASE,
        timeout: 10000,
        headers: { "User-Agent": USER_AGENT },
    });

    /**
     * The playing user's own LB token, or null when they have not saved
     * one. Scrobbling is per-user — there is no server-wide token; rows
     * that are not valid ciphertext (bad key, hand-edited value) fail
     * closed to null, same policy as `utils/encryption`.
     */
    async getUserToken(userId: string): Promise<string | null> {
        const row = await prisma.userSettings.findUnique({
            where: { userId },
            select: { listenbrainzToken: true },
        });
        const stored = row?.listenbrainzToken;
        if (!stored) return null;
        if (!isEncryptedFormat(stored)) {
            logger.warn(
                `[ListenBrainz] Unencrypted token stored for ${userId} — treating as not configured`
            );
            return null;
        }
        try {
            const token = decrypt(stored);
            return token.length > 0 ? token : null;
        } catch (err) {
            logger.warn(
                `[ListenBrainz] Token for ${userId} cannot be decrypted — scrobbles skip`
            );
            return null;
        }
    }

    private async rateLimitedGet<T = any>(
        path: string,
        params: Record<string, unknown>,
        token?: string | null
    ): Promise<T> {
        return rateLimiter.execute("listenbrainz", async () => {
            const res = await this.client.get<T>(path, {
                params,
                ...(token ? { headers: { Authorization: `Token ${token}` } } : {}),
            });
            return res.data;
        });
    }

    /**
     * Similar artists from LB's similarity dataset. The dataset publishes listen
     * counts, not scores, so `match` is the log-scaled count against the batch's
     * strongest, spread over 0.5–0.95 for the discover-weekly tiers. [] when the
     * seed has no data; never throws.
     */
    async getSimilarArtists(
        artistMbid: string,
        artistName: string,
        limit = 30
    ): Promise<SimilarArtist[]> {
        const cacheKey = `lb:similar:${artistMbid || artistName}:${limit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached) as SimilarArtist[];
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.rateLimitedGet<Record<string, any>>(
                `/1/lb-radio/artist/${artistMbid}`,
                {
                    mode: "medium",
                    max_similar_artists: Math.max(8, Math.ceil(limit / 2)),
                    max_recordings_per_artist: 2,
                    pop_begin: 0,
                    pop_end: 100,
                }
            );

            if (!data || typeof data !== "object" || "error" in data) {
                return [];
            }

            // Group by similar artist; keep the strongest connection per artist.
            const byArtist = new Map<string, { name: string; mbid: string; count: number }>();
            for (const entries of Object.values(data)) {
                if (!Array.isArray(entries)) continue;
                for (const e of entries) {
                    const mbid: string = e?.similar_artist_mbid;
                    const name: string = e?.similar_artist_name;
                    const count: number = Number(e?.total_listen_count) || 0;
                    if (!mbid || !name) continue;
                    if (mbid === artistMbid) continue; // exclude self
                    const existing = byArtist.get(mbid);
                    if (!existing || count > existing.count) {
                        byArtist.set(mbid, { name, mbid, count });
                    }
                }
            }

            const sorted = [...byArtist.values()]
                .sort((a, b) => b.count - a.count)
                .slice(0, limit);
            if (sorted.length === 0) return [];

            const maxLog = Math.log1p(sorted[0].count) || 1;
            const results: SimilarArtist[] = sorted.map((a) => ({
                name: a.name,
                mbid: a.mbid,
                match: Math.min(0.95, Math.max(0.5, 0.5 + (0.45 * Math.log1p(a.count)) / maxLog)),
                url: `https://listenbrainz.org/artist/${a.mbid}`,
            }));

            if (results.length > 0) {
                try {
                    await redisClient.setex(cacheKey, SIMILAR_TTL, JSON.stringify(results));
                } catch (err) {
                    logger.warn("Redis set error:", err);
                }
            }
            return results;
        } catch (error) {
            // Errors are NOT cached: a failure must not poison 7 days of cache.
            logger.warn(
                `ListenBrainz similar-artists error for ${artistName} (${artistMbid}):`,
                error
            );
            return [];
        }
    }

    /**
     * Sitewide top artists (replaces chart.getTopArtists). Cached daily.
     * Images are resolved by callers via the existing artwork cascade —
     * LB chart entries carry no images.
     */
    async getTopChartArtists(limit = 20): Promise<ChartArtist[]> {
        const cacheKey = `lb:chart:artists:${limit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached) as ChartArtist[];
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.rateLimitedGet<any>(
                "/1/stats/sitewide/artists",
                { stat_type: "top_artists", count: limit }
            );
            const artists: any[] = data?.payload?.artists || [];
            const results: ChartArtist[] = artists
                .filter((a) => a?.artist_mbid && a?.artist_name)
                .slice(0, limit)
                .map((a) => ({
                    type: "music" as const,
                    id: a.artist_mbid,
                    name: a.artist_name,
                    listeners: Number(a.listen_count) || 0,
                    playCount: Number(a.listen_count) || 0,
                    url: `https://listenbrainz.org/artist/${a.artist_mbid}`,
                    mbid: a.artist_mbid,
                }));
            if (results.length > 0) {
                // Charts move slowly; cache 6h.
                await redisClient.setex(cacheKey, 21600, JSON.stringify(results));
            }
            return results;
        } catch (error) {
            logger.warn("ListenBrainz sitewide chart error:", error);
            return [];
        }
    }

    /**
     * Submit listens (scrobbling) with the playing user's own token. With
     * no token configured this is a silent no-op (returns false) — Kima's
     * play log is local and stays the source of truth; LB is a mirror,
     * never the record.
     */
    async submitListens(
        userId: string,
        listens: Array<{
            artist: string;
            track: string;
            /** ISO-OSError-style release date or year string, optional. */
            release?: string;
            listenMbid?: string;
            recordingMbid?: string;
            listenedAt: number; // unix seconds
        }>
    ): Promise<boolean> {
        const token = await this.getUserToken(userId);
        if (!token) {
            logger.debug("[ListenBrainz] No user token configured — skipping submit");
            return false;
        }

        try {
            const payload = {
                listen_type: "listens",
                payload: listens.map((l) => ({
                    listened_at: l.listenedAt,
                    track: {
                        artist_name: l.artist,
                        track_name: l.track,
                        ...(l.release ? { release_name: l.release } : {}),
                        ...(l.listenMbid ? { additional_info: { media_service: "kima", media_player: "kima", mapping_set_id: l.listenMbid } } : {}),
                        ...(l.recordingMbid
                            ? {
                                  additional_info: {
                                      media_service: "kima",
                                      media_player: "kima",
                                      ...(l.listenMbid ? { mapping_set_id: l.listenMbid } : {}),
                                      recording_mbid: l.recordingMbid,
                                  },
                              }
                            : {}),
                    },
                })),
            };
            const res = await rateLimiter.execute("listenbrainz", async () => {
                const r = await this.client.post("/1/submit-listens", payload, {
                    headers: {
                        Authorization: `Token ${token}`,
                        "Content-Type": "application/json",
                    },
                });
                return r;
            });
            if (res.status === 200) {
                logger.debug(`[ListenBrainz] Submitted ${listens.length} listen(s)`);
                return true;
            }
            logger.warn(`[ListenBrainz] submit-listens returned ${res.status}`);
            return false;
        } catch (error: any) {
            logger.warn(
                `[ListenBrainz] submit-listens failed: ${error?.message || error}`
            );
            return false;
        }
    }

    /** Validate a candidate token before saving it in Settings. */
    async validateToken(token: string): Promise<{ valid: boolean; userName?: string }> {
        try {
            const data = await this.rateLimitedGet<any>(
                "/1/validate-token",
                {},
                token
            );
            return { valid: !!data?.valid, userName: data?.user_name };
        } catch (error) {
            logger.warn("ListenBrainz validate-token error:", error);
            return { valid: false };
        }
    }
}

export const listenBrainzService = new ListenBrainzService();
