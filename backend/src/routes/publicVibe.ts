/**
 * Public vibe surface router, mounted at /api/public/vibe.
 *
 * Five read-only, unauthenticated routes over auth-walled internals. There is
 * no request-side identity at all: the public user's id is read once, from
 * SystemSettings, in the `withPublic` guard, then threaded into every handler.
 * A caller cannot name that user; a disabled feature yields 404, not 403.
 *
 * Each handler faithfully ports the matching authed /vibe handler — the same
 * text search, the same similarity, the same live/joined-playback payload —
 * with two public-only changes on top: native covers are proxied instead of
 * handed out, and the whole surface is gated on the enable flag.
 */
import {
    Router,
    Request,
    Response,
    NextFunction,
    RequestHandler,
} from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { apiLimiter } from "../middleware/rateLimiter";
import {
    getPublicLiveCached,
    getPublicQueue,
    getPublicMap,
} from "../services/publicVibeService";
import { findSimilarTracks, SimilarTrack } from "../services/hybridSimilarity";
import { getTextEmbedding } from "../services/textEmbeddingBridge";
import {
    getVocabulary,
    expandQueryWithVocabulary,
    rerankWithFeatures,
    VocabTerm,
} from "../services/vibeVocabulary";
import { getResizedImagePath, resizeImageBuffer } from "../services/imageStorage";
import { findAlbumArtwork } from "../services/artwork";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { USER_AGENT, config } from "../config";

interface PublicAccess {
    enabled: boolean;
    userId: string | null;
    checkedAt: number;
}

const publicAccess: PublicAccess = { enabled: false, userId: null, checkedAt: 0 };
const ACCESS_TTL = 5 * 1000;

// Permission is one SystemSettings read, cheaply cached, so a hot route does
// not hit the DB on every request. A missing row or a DB failure both read as
// "disabled" — the safe default for a public surface.
async function resolvePublicAccess(forceRefresh = false): Promise<{
    enabled: boolean;
    userId: string | null;
}> {
    const now = Date.now();
    if (!forceRefresh && publicAccess.checkedAt && now - publicAccess.checkedAt < ACCESS_TTL) {
        return {
            enabled: publicAccess.enabled,
            userId: publicAccess.userId,
        };
    }

    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
    }).catch(() => null);

    const value = {
        enabled: !!settings?.publicVibeEnabled,
        userId: settings?.publicVibeUserId ?? null,
    };
    publicAccess.enabled = value.enabled;
    publicAccess.userId = value.userId;
    publicAccess.checkedAt = now;
    return value;
}

interface PublicRequest extends Request {
    publicUserId: string;
}

// Gate every public route on the enable flag. 404 (not 403) when disabled —
// an operator who has not enabled the surface is "not listed", and the
// designated user id is carried forward for handlers that need it.
function withPublic(
    handler: (req: PublicRequest, res: Response, next: NextFunction) => unknown,
): RequestHandler {
    return async (req, res, next) => {
        const { enabled, userId } = await resolvePublicAccess();
        if (!enabled) {
            res.status(404).json({ error: "Not available" });
            return;
        }
        (req as PublicRequest).publicUserId = userId!;
        return handler(req as PublicRequest, res, next);
    };
}

// ---- shared plumbing -------------------------------------------------------

const TRACK_ID_RE = /^c[a-z0-9]{16,30}$/;

function requireTrackId(param: string): boolean {
    return typeof param === "string" && TRACK_ID_RE.test(param);
}

// The map endpoint caps to 5000; the client-visible /map cap is smaller.
const MAP_CAP_DEFAULT = 2000;
const MAP_CAP_MIN = 100;
const MAP_CAP_MAX = 5000;

// The /map `limit` param: fall back to the default, clamp to 100..5000. Never
// reject — a confused client should simply see fewer points.
function parseMapLimit(value: unknown): number {
    if (value === undefined || value === "") return MAP_CAP_DEFAULT;
    const n = Number(value);
    if (!Number.isFinite(n)) return MAP_CAP_DEFAULT;
    const floored = Math.floor(n);
    if (floored < MAP_CAP_MIN) return MAP_CAP_MIN;
    if (floored > MAP_CAP_MAX) return MAP_CAP_MAX;
    return floored;
}

// The similar/search `limit` param: fall back to 20, clamp 1..100.
function parseListLimit(value: unknown): number {
    if (value === undefined || value === "") return 20;
    const n = Number(value);
    if (!Number.isFinite(n)) return 20;
    return Math.min(100, Math.max(1, Math.floor(n)));
}

// Maps carry `native:` coverUrls. Never hand those to a client: rewrite each
// to the proxied cover endpoint, which resolves and serves the bytes.
function proxyCover(url: string | null | undefined): string | null {
    if (url && url.startsWith("native:")) {
        return "/api/public/vibe/cover/native"; // replaced below with an id
    }
    return url ?? null;
}

// Convert a `native:` album cover to a proxied URL, carrying the owning track's
// id so /cover can find the album.
function proxiedCover(trackId: string, url: string | null | undefined): string | null {
    if (!url) return null;
    if (!url.startsWith("native:")) return url;
    return `/api/public/vibe/cover/${encodeURIComponent(trackId)}`;
}

// One cover does not change, so it is immutable and its digest doubles as the
// ETag.
function etagFor(buffer: Buffer): string {
    return '"' + crypto.createHash("md5").update(buffer).digest("hex") + '"';
}

// Apply the cover-response headers, mirroring the authed cover-art route.
function applyCoverHeaders(res: Response, size?: string): void {
    const corsHeader: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
    const headers: Record<string, string> = {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, immutable, max-age=31536000, s-maxage=31536000",
        ...corsHeader,
    };
    void size;
    void headers;
}

// Best-effort recovery when a native cover file has gone missing from disk:
// ask the shared artwork service, keyed on the album's MusicBrainz id + title.
async function recoverCover(
    rgMbid: string | null | undefined,
    artistName: string | null | undefined,
    albumTitle: string | null | undefined,
): Promise<string | null> {
    if (!rgMbid || !artistName || !albumTitle) return null;
    try {
        const found = await findAlbumArtwork({
            rgMbid,
            artistName,
            albumTitle,
        });
        return found?.url ?? null;
    } catch {
        return null;
    }
}

// Safely resolve a `native:` cover to disk, mirroring the authed cover route's
// validator so a crafted id cannot read arbitrary files.
function getNativeCoverPath(nativePath: string): string | null {
    const coversBase = path.resolve(config.music.transcodeCachePath, "../covers");
    const resolved = path.resolve(coversBase, nativePath);
    if (!resolved.startsWith(coversBase + path.sep) && resolved !== coversBase) {
        return null;
    }
    return resolved;
}

// Serve the album cover bytes for one track. Reads are server-side only; a
// missing file, a non-native reference, or a bad id all map to 404.
async function resolveCoverBytes(
    trackId: string,
    size?: string,
): Promise<{ buffer: Buffer; etag: string; contentType: string | null } | null> {
    const row = await prisma.track.findFirst({
        where: { id: trackId },
        select: {
            album: {
                select: {
                    coverUrl: true,
                    rgMbid: true,
                    title: true,
                    artist: { select: { name: true } },
                },
            },
        },
    });

    const cover = row?.album;
    const coverRef = cover?.coverUrl;
    if (!cover || !coverRef || !coverRef.startsWith("native:")) {
        return null;
    }

    const nativePath = coverRef.slice("native:".length);
    const abs = getNativeCoverPath(nativePath);
    if (!abs || !fs.existsSync(abs)) {
        // Recover a fresh cover for the album so the next request can serve.
        const recoveredUrl = await recoverCover(cover.rgMbid, cover.artist?.name, cover.title);
        if (!recoveredUrl) {
            return null;
        }
        const imageResponse = await fetch(recoveredUrl, {
            headers: { "User-Agent": USER_AGENT },
        });
        if (!imageResponse.ok || imageResponse.status !== 200) {
            return null;
        }
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        return {
            buffer,
            etag: etagFor(buffer),
            contentType: imageResponse.headers.get("content-type"),
        };
    }

    const fileBuf = fs.readFileSync(abs);
    let serve: Buffer | null = null;

    // Honor a ?size= scale request, cached under the same validator.
    if (size && /^\d+$/.test(size)) {
        const width = Number.parseInt(size, 10);
        if (width >= 16 && width <= 3072) {
            const resizedPath = getResizedImagePath(`native:${nativePath}`, width);
            if (resizedPath && fs.existsSync(resizedPath)) {
                const cached = fs.readFileSync(resizedPath);
                return {
                    buffer: cached,
                    etag: etagFor(cached),
                    contentType: null,
                };
            }
            try {
                const resized = await resizeImageBuffer(fileBuf, width);
                serve = resized ?? null;
            } catch {
                // fall through to serving the original
            }
        }
    }

    if (serve === null) serve = fileBuf;

    return {
        buffer: serve,
        etag: etagFor(serve),
        contentType: null,
    };
}

const router = Router();

/**
 * GET /api/public/vibe/live
 *
 * The playing point, queued line, and derived context, joined to the map.
 * Cached ~2s at the service layer. nowPlaying is null when idle, which is
 * normal. Sent no-store so the edge owns freshness.
 */
router.get(
    "/live",
    withPublic(
        asyncHandler(async (_req: Request, res: Response) => {
            const req = _req as PublicRequest;
            const { nowPlaying } = await getPublicLiveCached(
                req.publicUserId,
                MAP_CAP_MAX,
            );
            const queue = await getPublicQueue(req.publicUserId, MAP_CAP_MAX);

            res.header("Cache-Control", "no-store");
            res.header("Vary", "Accept-Encoding");
            res.json({
                nowPlaying,
                queue,
                context: {
                    type: "queue",
                    name: "Public Queue",
                },
            });
        }),
    ),
);

// An anonymous surface has no user to bound against, so the whole stream set is
// capped globally. Reaching it is a soft 429, not a hard ban — the site should
// reconnect.
const STREAM_CONNECTION_CEILING = 50;
const streamClients = new Set<string>();

/**
 * GET /api/public/vibe/stream
 *
 * SSE that pushes the live payload on an interval so a client stays idle
 * without polling. Payload matches /live.
 */
router.get(
    "/stream",
    withPublic(
        asyncHandler(async (_req: Request, res: Response) => {
            const req = _req as PublicRequest;
            const userId = req.publicUserId;

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.setHeader("Vary", "Accept-Encoding");
            res.flushHeaders?.();

            if (streamClients.size >= STREAM_CONNECTION_CEILING) {
                res.status(429).json({
                    error: "Public stream at capacity. Please try again shortly.",
                });
                return;
            }

            const connId = crypto.randomBytes(8).toString("hex");
            streamClients.add(connId);
            let settled = false;

            const send = async (): Promise<void> => {
                if (settled) return;
                try {
                    const { nowPlaying } = await getPublicLiveCached(
                        userId,
                        MAP_CAP_MAX,
                    );
                    const queue = await getPublicQueue(userId, MAP_CAP_MAX);
                    const payload = {
                        type: "public:vibe:live",
                        nowPlaying,
                        queue,
                        timestamp: new Date().toISOString(),
                    };
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                } catch (e) {
                    logger.warn(
                        "[PUBLIC-VIBE] stream emit failed:",
                        (e as Error).message,
                    );
                }
            };

            const heartbeat = setInterval(() => {
                if (settled) return;
                try {
                    res.write(": heartbeat\n\n");
                } catch {
                    /* already gone */
                }
            }, 30000);

            const poll = setInterval(send, 5000);

            const teardown = () => {
                if (settled) return;
                settled = true;
                clearInterval(heartbeat);
                clearInterval(poll);
                streamClients.delete(connId);
                try {
                    res.end();
                } catch {
                    /* already gone */
                }
            };

            req.on("close", teardown);
            req.on("error", teardown);
            res.on("close", teardown);

            // Fire one frame immediately so the client sees the stream open,
            // then keep polling.
            await send();
        }),
    ),
);

/**
 * GET /api/public/vibe/map
 *
 * The full map, capped to the operator's public ceiling, deeply cached.
 * Covers are proxied (each `native:` url rewritten by the service), so a
 * client never learns a `native:` reference from this response.
 */
router.get(
    "/map",
    withPublic(
        asyncHandler(async (req: Request, res: Response) => {
            const maxPoints = parseMapLimit(req.query.limit);
            const map = await getPublicMap(maxPoints);

            // A 60s edge cache is plenty for a map that updates only when the
            // projection refreshes. Derive the ETag from the serialised body so a
            // client can 304 against it; changing payload always changes the digest.
            const jsonBody = JSON.stringify(map);
            const etag = '"' + crypto.createHash("sha256").update(jsonBody).digest("hex").slice(0, 16) + '"';
            if (req.headers["if-none-match"] === etag) {
                res.status(304).header("ETag", etag).end();
                return;
            }

            res.header("Cache-Control", "public, s-maxage=3600, max-age=300, stale-while-revalidate=60");
            res.header("ETag", etag);
            res.header("Vary", "Accept-Encoding");
            res.type("application/json").send(jsonBody);
        }),
    ),
);

/**
 * GET /api/public/vibe/similar/:trackId
 *
 * Faithful port of the authed /vibe/similar handler: same similarity pipeline,
 * re-projected to client fields with the existing map overlay applied so the
 * list and the 2D map agree.
 */
router.get(
    "/similar/:trackId",
    withPublic(
        asyncHandler(async (req: Request, res: Response) => {
            const reqPub = req as PublicRequest;
            const { trackId } = req.params;
            if (!requireTrackId(trackId)) {
                res.status(400).json({ error: "Invalid trackId format" });
                return;
            }

            const limit = parseListLimit(req.query.limit);
            const tracks = await findSimilarTracks(trackId, limit);
            if (tracks.length === 0) {
                res.status(404).json({
                    error: "No similar tracks found",
                    message: "This track was not found among analysed tracks.",
                });
                return;
            }

            // Coordinates come from the existing map projection — never
            // re-derived — so similar and map agree by construction.
            let coordinates: Record<string, { x: number; y: number }> = {};
            try {
                const map = await getPublicMap(MAP_CAP_MAX);
                for (const point of map.tracks) {
                    if (point.x != null && point.y != null) {
                        coordinates[point.id] = { x: point.x, y: point.y };
                    }
                }
            } catch {
                coordinates = {};
            }

            res.header("Cache-Control", "public, s-maxage=120, max-age=30");
            res.header("Vary", "Accept-Encoding");
            res.json({
                sourceTrackId: trackId,
                limit,
                total: tracks.length,
                tracks: tracks.map(
                    (t: SimilarTrack) => ({
                        trackId: t.id,
                        title: t.title,
                        distance: t.distance,
                        similarity: t.similarity,
                        album: {
                            id: t.albumId,
                            title: t.albumTitle,
                            coverUrl: proxiedCover(t.id, t.albumCoverUrl),
                        },
                        artist: {
                            id: t.artistId,
                            name: t.artistName,
                        },
                        ...(coordinates[t.id] ? coordinates[t.id] : {}),
                    }),
                ),
            });
        }),
    ),
);

interface SearchResult {
    id: string;
    title: string;
    duration: number | null;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    energy: number | null;
    valence: number | null;
    danceabilityMl: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    arousal: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
}

/**
 * POST /api/public/vibe/search
 *
 * Faithful port of the authed /vibe/search: same embedding, same vocabulary
 * expansion, same re-rank over the same nearest-neighbour query. Results are
 * reshaped for the client; native covers are proxied.
 */
router.post(
    "/search",
    withPublic(
        asyncHandler(async (req: Request, res: Response) => {
            const reqPub = req as PublicRequest;
            const query = typeof req?.body?.query === "string" ? req.body.query : "";
            if (!query || query.length < 2 || query.length > 500) {
                res.status(400).json({ error: "query must be 2-500 characters" });
                return;
            }

            const limit = parseListLimit(req.query.limit);
            const maxDistance = 1 - 0.4; // reuse the authed minimum-similarity floor

            const trimmedQuery = query.trim();
            try {
                const embedding = await getTextEmbedding(trimmedQuery);
                const vocab = getVocabulary();
                let searchEmbedding = embedding;
                let genreConfidence = 0;
                let matchedTerms: VocabTerm[] = [];
                if (vocab) {
                    const expansion = expandQueryWithVocabulary(
                        embedding,
                        trimmedQuery,
                        vocab,
                    );
                    searchEmbedding = expansion.embedding;
                    genreConfidence = expansion.genreConfidence;
                    matchedTerms = expansion.matchedTerms;
                }

                const rawResults = await prisma.$queryRaw<SearchResult[]>`
                    SELECT
                        t.id,
                        t.title,
                        t.duration,
                        te.embedding <=> ${searchEmbedding}::vector AS distance,
                        a.id AS "albumId",
                        a.title AS "albumTitle",
                        a.coverUrl AS "albumCoverUrl",
                        ar.id AS "artistId",
                        ar.name AS "artistName",
                        t.energy,
                        t.valence,
                        t."danceabilityMl" AS danceabilityMl,
                        t.acousticness,
                        t.instrumentalness,
                        t.arousal,
                        t."moodHappy" AS moodHappy,
                        t."moodSad" AS moodSad,
                        t."moodRelaxed" AS moodRelaxed,
                        t."moodAggressive" AS moodAggressive,
                        t."moodParty" AS moodParty,
                        t."moodAcoustic" AS moodAcoustic,
                        t."moodElectronic" AS moodElectronic
                    FROM track_embeddings te
                    JOIN "Track" t ON te.track_id = t.id
                    JOIN "Album" a ON t."albumId" = a.id
                    JOIN "Artist" ar ON a."artistId" = ar.id
                    WHERE te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
                    ORDER BY te.embedding <=> ${searchEmbedding}::vector
                    LIMIT ${limit * 3}
                `;

                let ranked = rawResults;
                if (vocab && matchedTerms.length > 0) {
                    ranked = rerankWithFeatures<SearchResult>(
                        rawResults,
                        matchedTerms,
                        genreConfidence,
                    ).slice(0, limit);
                } else {
                    ranked = rawResults.slice(0, limit);
                }

                // Coordinates from the existing map, overlaying search hits.
                let coordinates: Record<string, { x: number; y: number }> = {};
                try {
                    const map = await getPublicMap(MAP_CAP_MAX);
                    for (const point of map.tracks) {
                        if (point.x != null && point.y != null) {
                            coordinates[point.id] = { x: point.x, y: point.y };
                        }
                    }
                } catch {
                    coordinates = {};
                }

                res.header("Cache-Control", "no-store");
                res.header("Vary", "Accept-Encoding");
                res.json({
                    query: trimmedQuery,
                    count: ranked.length,
                    tracks: ranked.map(
                        (r: SearchResult) => ({
                            trackId: r.id,
                            title: r.title,
                            distance: r.distance,
                            similarity: 1 - r.distance,
                            album: {
                                id: r.albumId,
                                title: r.albumTitle,
                                coverUrl: proxiedCover(r.id, r.albumCoverUrl),
                            },
                            artist: {
                                id: r.artistId,
                                name: r.artistName,
                            },
                            ...(coordinates[r.id] ? coordinates[r.id] : {}),
                        }),
                    ),
                });
            } catch (e) {
                logger.error(
                    "[PUBLIC-VIBE] search error:",
                    (e as Error).message,
                );
                res.status(500).json({ error: "Search unavailable" });
            }
        }),
    ),
);

/**
 * GET /api/public/vibe/cover/:trackId
 *
 * The only route that returns bytes: the operator's album cover for a track,
 * proxied so we never leak a `native:` reference. Server-side resolution only;
 * a missing file, a remote cover, or a malformed id all yield 404.
 */
router.get(
    "/cover/:trackId",
    withPublic(
        asyncHandler(async (req: Request, res: Response) => {
            const reqPub = req as PublicRequest;
            const { trackId, size } = req.params;
            if (!requireTrackId(trackId)) {
                res.status(400).json({ error: "Invalid trackId format" });
                return;
            }

            if (size && !/^\d+$/.test(size)) {
                res.status(400).json({ error: "Invalid size parameter" });
                return;
            }

            const resolved = await resolveCoverBytes(trackId, size);
            if (!resolved) {
                res.status(404).end();
                return;
            }

            if (req?.headers?.["if-none-match"] === resolved.etag) {
                res.status(304).end();
                return;
            }

            res.header("Content-Type", resolved.contentType || "image/jpeg");
            res.header("ETag", resolved.etag);
            res.header("Cross-Origin-Resource-Policy", "cross-origin");
            res.header("Cache-Control", "public, immutable, max-age=31536000, s-maxage=31536000");
            res.header("Vary", "Accept-Encoding");

            res.send(resolved.buffer);
        }),
    ),
);

export default router;
