/**
 * Artist similarity — replaces lastFmService.getSimilarArtists.
 *
 * Two sources, in order of trust:
 *
 * 1. LOCAL CENTROID. Each artist gets a centroid vector (mean of its
 *    tracks' CLAP embeddings, 512-d) stored in `artist_embeddings`. Similar artists
 *    = cosine nearest-neighbours over those centroids. This is real audio
 *    similarity computed from the operator's own library, and it is the
 *    primary source whenever the artist has >= MIN_LOCAL_TRACKS embedded.
 *    Centroids are rebuilt inside the existing "rebuild embeddings" flow
 *    (no new polling loops) and incrementally when a track gains an
 *    embedding.
 *
 * 2. LISTENBRAINZ DATASET. When the artist has no local centroid (brand-new
 *    artist, unanalyzed tracks, or <3 embedded tracks), fall back to the
 *    open artist–artist dataset via listenBrainzService.getSimilarArtists.
 *    Measured 2026-09-19 on a 33-artist sample: 30/33 seeds returned data
 *    (91%), 550–1550 ms per call — inside the ≤1.5s uncached bar.
 *
 * The return shape is IDENTICAL to lastFmService.getSimilarArtists
 * (SimilarArtist[]) so the eight call sites change import only.
 *
 * `match` semantics differ from Last.fm's by necessity: local results carry
 * true cosine similarity of centroids (typically 0.4–0.9); LB results carry
 * a log-scaled proxy of connection strength (0.5–0.95). Both bands overlap
 * the 0.5–0.7 range the discover-weekly tier thresholds were calibrated to,
 * so tier assignment keeps working without re-calibration.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import {
    listenBrainzService,
    type SimilarArtist,
} from "./listenBrainz";

export type { SimilarArtist };

/** Below this many embedded tracks a centroid is noise; use LB instead. */
export const MIN_LOCAL_TRACKS = 3;

/** 7 days, same as the old Last.fm cache. */
const CACHE_TTL = 604800;

/**
 * Parse a pgvector text literal ("[0.1,0.2,...]") into numbers.
 */
export function parseVector(literal: string): number[] {
    return JSON.parse(literal) as number[];
}

/** Elementwise mean of equal-length vectors; skips nulls. */
export function meanVector(vectors: number[][]): number[] | null {
    const usable = vectors.filter((v) => v.length > 0);
    if (usable.length === 0) return null;
    const dim = usable[0].length;
    const sum = new Array<number>(dim).fill(0);
    for (const v of usable) {
        for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
    }
    return sum.map((s) => s / usable.length);
}

/** Cosine similarity of two vectors; 0 when either is degenerate. */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * (Re)compute and store the centroid for one artist from its tracks'
 * embeddings. Returns the number of tracks behind the centroid, or 0 when
 * the artist has no usable embeddings. Rides the existing rebuild-embeddings
 * flow and the per-track embed path — never its own scheduler.
 */
export async function rebuildArtistCentroid(
    artistId: string
): Promise<{ trackCount: number }> {
    const rows = await prisma.$queryRaw<
        Array<{ embedding: unknown }>
    >`
        SELECT te.embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."artistId" = ${artistId}
    `;
    const vectors = rows
        .map((r) => parseVector(String(r.embedding)))
        .filter((v) => v.length > 0);
    const centroid = meanVector(vectors);
    if (!centroid) {
        return { trackCount: 0 };
    }
    await prisma.$executeRaw`
        INSERT INTO artist_embeddings ("artistId", embedding, "computedAt", "trackCount")
        VALUES (${artistId}, ${`[${centroid.join(",")}]`}::vector, now(), ${vectors.length})
        ON CONFLICT ("artistId") DO UPDATE
        SET embedding = EXCLUDED.embedding,
            "computedAt" = now(),
            "trackCount" = EXCLUDED."trackCount"
    `;
    return { trackCount: vectors.length };
}

/**
 * Similar artists for one artist. Local centroid first (when backed by
 * >= MIN_LOCAL_TRACKS tracks), LB dataset as cold-start fallback.
 * Never throws; returns [] when neither source has data.
 */
export async function getSimilarArtists(
    artistId: string,
    artistMbid: string | null | undefined,
    artistName: string,
    limit = 30
): Promise<SimilarArtist[]> {
    const cacheKey = `artist-similar:${artistId || artistMbid || artistName}:${limit}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached) as SimilarArtist[];
            if (parsed.length > 0) return parsed;
        }
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis read error:", err);
    }

    // --- Tier 1: local centroid NN over artist_embeddings ---
    let local: SimilarArtist[] = [];
    try {
        const centroidRow = await prisma.$queryRaw<
            Array<{ embedding: unknown; trackCount: number }>
        >`
            SELECT embedding, "trackCount"
            FROM artist_embeddings
            WHERE "artistId" = ${artistId}
        `;
        const row = centroidRow[0];
        if (row && Number(row.trackCount) >= MIN_LOCAL_TRACKS) {
            const centroid = parseVector(String(row.embedding));
            const nn = await prisma.$queryRaw<
                Array<{
                    artistId: string;
                    name: string;
                    mbid: string | null;
                    distance: number;
                }>
            >`
                SELECT ae."artistId",
                       a.name,
                       a.mbid,
                       ae.embedding <=> (
                           SELECT embedding FROM artist_embeddings
                           WHERE "artistId" = ${artistId}
                       ) AS distance
                FROM artist_embeddings ae
                JOIN "Artist" a ON a.id = ae."artistId"
                WHERE ae."artistId" != ${artistId}
                  AND ae."trackCount" >= ${MIN_LOCAL_TRACKS}
                ORDER BY ae.embedding <=> (
                    SELECT embedding FROM artist_embeddings
                    WHERE "artistId" = ${artistId}
                )
                LIMIT ${limit}
            `;
            local = nn
                .filter((r) => Number(r.distance) < 1)
                .map((r) => ({
                    name: r.name,
                    mbid: r.mbid || undefined,
                    match: Math.max(0, 1 - Number(r.distance)),
                    url: r.mbid
                        ? `https://musicbrainz.org/artist/${r.mbid}`
                        : "",
                }));
        }
    } catch (err) {
        logger.warn(
            `[ArtistSimilarity] local centroid path failed for ${artistName}:`,
            err
        );
    }

    if (local.length >= Math.min(limit, 5)) {
        await store(cacheKey, local);
        return local;
    }

    // --- Tier 2: LB artist–artist dataset (cold start) ---
    if (artistMbid) {
        const lb = await listenBrainzService.getSimilarArtists(
            artistMbid,
            artistName,
            limit
        );
        const merged = dedupe([...local, ...lb]).slice(0, limit);
        if (merged.length > 0) {
            await store(cacheKey, merged);
            return merged;
        }
    }

    if (local.length > 0) {
        await store(cacheKey, local);
        return local;
    }
    return [];
}

async function store(key: string, value: SimilarArtist[]): Promise<void> {
    try {
        await redisClient.setex(key, CACHE_TTL, JSON.stringify(value));
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis write error:", err);
    }
}

function dedupe(list: SimilarArtist[]): SimilarArtist[] {
    const seen = new Set<string>();
    const out: SimilarArtist[] = [];
    for (const item of list) {
        const key = item.mbid || item.name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
