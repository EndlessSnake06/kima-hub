/**
 * Artist similarity — replaces the retired Last.fm service's getSimilarArtists.
 *
 * Three sources, in order of trust ("lets try
 * listenbrainz with deezer fallback" — music discovery is the point, so
 * global taste data comes first and local audio analysis only backstops):
 *
 * 1. LISTENBRAINZ DATASET (global taste). listenBrainzService
 *    .getSimilarArtists answers from the open artist–artist dataset via the
 *    lb-radio endpoint. Keyed by MBID; skipped when there is no MBID.
 *
 * 2. DEEZER RELATED ARTISTS. deezerService.getRelatedArtists answers from
 *    Deezer's per-artist related list, keyed by name. Runs concurrently
 *    with Tier 1 and fills the request when ListenBrainz is empty or short;
 *    when ListenBrainz already returns >= limit, Deezer's results are
 *    discarded (LB-first ordering).
 *
 * 3. LOCAL CENTROID. Each artist gets a centroid vector (mean of its
 *    tracks' CLAP embeddings, 512-d) stored in `artist_embeddings`. Similar
 *    artists = cosine nearest-neighbours over those centroids. Only used
 *    when both remote tiers came back empty — local-only answers
 *    "circlejerk the library" instead of surfacing new music. Centroids are
 *    rebuilt inside the existing "rebuild embeddings" flow
 *    (rebuildStaleArtistCentroids in unifiedEnrichment.ts — untouched).
 *
 * Before returning, results are RE-RANKED against the library: artists
 * whose rows exist here get `inLibrary: true`, and when both the seed and
 * the result have stored centroids the match score is nudged by the local
 * centroid distance — at most ±0.1 (RERANK_MAX_DELTA) — so taste leans
 * ours without hiding non-owned artists.
 *
 * The return shape is the old Last.fm service's getSimilarArtists shape plus
 * the optional `inLibrary` flag, so the eight call sites compile unchanged.
 * The first argument is the MBID ("" when unknown), exactly like the old
 * signature.
 *
 * `match` semantics differ from Last.fm's by necessity: LB results carry a
 * log-scaled proxy of connection strength (0.5–0.95); Deezer results carry
 * a rank-position score (0.5–0.9); local results carry true cosine
 * similarity. All bands overlap the 0.5–0.7 range the discover-weekly tier
 * thresholds were calibrated to, so tier assignment keeps working without
 * re-calibration.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import {
    listenBrainzService,
    type SimilarArtist,
} from "./listenBrainz";
import { deezerService } from "./deezer";

export type { SimilarArtist };

/**
 * SimilarArtist plus the in-library flag. Identical to SimilarArtist apart
 * from the optional `inLibrary` field, so every existing consumer that
 * types against SimilarArtist keeps compiling.
 */
export interface SimilarArtistWithLibrary extends SimilarArtist {
    /** True when the artist has rows in this library (MBID-then-name lookup). */
    inLibrary?: boolean;
}

/** Below this many embedded tracks a centroid is noise; don't trust it. */
export const MIN_LOCAL_TRACKS = 3;

/** 7 days — same TTL the Last.fm path used; similarity data churns slowly. */
const CACHE_TTL = 604800;

/**
 * Maximum ± adjustment the library re-rank may apply to any match score.
 * Small on purpose: it leans results toward artists we actually own without
 * letting local audio analysis override global taste data.
 */
const RERANK_MAX_DELTA = 0.1;

/**
 * Parse a pgvector text literal ("[0.1,0.2,...]") into numbers.
 */
export function parseVector(literal: string): number[] {
    return JSON.parse(literal) as number[];
}

/** Elementwise mean of equal-length vectors; skips empty vectors. */
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
        JOIN "Album" al ON al.id = t."albumId"
        WHERE al."artistId" = ${artistId}
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
 * Similar artists for one artist, keyed by MBID ("" when unknown) — same
 * signature as the old Last.fm service's getSimilarArtists.
 *
 * Tier 1 (ListenBrainz, needs the MBID) and Tier 2 (Deezer, keyed by name)
 * run concurrently; ListenBrainz wins outright when it fills the request.
 * If both come back empty, Tier 3 (local centroid NN) answers. Never
 * throws; returns [] when no source has data.
 */
export async function getSimilarArtists(
    artistMbid: string,
    artistName: string,
    limit = 30
): Promise<SimilarArtistWithLibrary[]> {
    const cacheKey = `artist-similar:${artistMbid || artistName}:${limit}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached) as SimilarArtistWithLibrary[];
            if (parsed.length > 0) return parsed;
        }
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis read error:", err);
    }

    const hasMbid = typeof artistMbid === "string" && artistMbid.length > 0;

    // --- Tier 1 (ListenBrainz) + Tier 2 (Deezer), concurrently ---
    const [lb, dz] = await Promise.all([
        hasMbid
            ? listenBrainzService
                  .getSimilarArtists(artistMbid, artistName, limit)
                  .catch((err) => {
                      logger.warn(
                          `[ArtistSimilarity] ListenBrainz path failed for ${artistName}:`,
                          err
                      );
                      return [] as SimilarArtist[];
                  })
            : Promise.resolve([] as SimilarArtist[]),
        deezerService
            .getRelatedArtists(artistName, limit)
            .catch((err) => {
                logger.warn(
                    `[ArtistSimilarity] Deezer path failed for ${artistName}:`,
                    err
                );
                return [] as SimilarArtist[];
            }),
    ]);

    let results: SimilarArtist[];
    if (lb.length >= limit) {
        // Global data filled the request — keep ListenBrainz alone.
        results = lb.slice(0, limit);
    } else if (lb.length > 0 || dz.length > 0) {
        // LB short or empty: Deezer fills the rest; dedupe by name so the
        // same artist from both sources appears once (LB entries win).
        results = dedupeByName([...lb, ...dz]).slice(0, limit);
    } else {
        // --- Tier 3: local centroid NN (both remote tiers empty/failed) ---
        results = await getLocalSimilarArtists(artistMbid, limit);
    }

    // Re-rank against the library, then cache and return.
    const reranked = await rerankWithLibrary(
        results,
        artistMbid,
        artistName
    );
    if (reranked.length > 0) {
        await store(cacheKey, reranked);
    }
    return reranked;
}

/**
 * Tier 3: cosine nearest-neighbours over locally computed artist centroids.
 * Keyed by MBID — without a library row for the seed there is no centroid
 * to measure distance from, so an unknown-to-us artist gets nothing here.
 */
async function getLocalSimilarArtists(
    artistMbid: string,
    limit: number
): Promise<SimilarArtist[]> {
    const hasMbid = typeof artistMbid === "string" && artistMbid.length > 0;
    try {
        const artistRow = hasMbid
            ? await prisma.artist.findUnique({
                  where: { mbid: artistMbid },
                  select: { id: true },
              })
            : null;
        if (!artistRow) return [];

        const centroidRow = await prisma.$queryRaw<
            Array<{ embedding: unknown; trackCount: number }>
        >`
            SELECT embedding, "trackCount"
            FROM artist_embeddings
            WHERE "artistId" = ${artistRow.id}
        `;
        const row = centroidRow[0];
        if (!row || Number(row.trackCount) < MIN_LOCAL_TRACKS) return [];

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
                       WHERE "artistId" = ${artistRow.id}
                   ) AS distance
            FROM artist_embeddings ae
            JOIN "Artist" a ON a.id = ae."artistId"
            WHERE ae."artistId" != ${artistRow.id}
              AND ae."trackCount" >= ${MIN_LOCAL_TRACKS}
            ORDER BY ae.embedding <=> (
                SELECT embedding FROM artist_embeddings
                WHERE "artistId" = ${artistRow.id}
            )
            LIMIT ${limit}
        `;
        return nn
            .filter((r) => Number(r.distance) < 1)
            .map((r) => ({
                name: r.name,
                mbid: r.mbid || undefined,
                match: Math.max(0, 1 - Number(r.distance)),
                url: r.mbid
                    ? `https://musicbrainz.org/artist/${r.mbid}`
                    : "",
            }));
    } catch (err) {
        logger.warn(
            `[ArtistSimilarity] local centroid path failed (seed ${artistMbid}):`,
            err
        );
        return [];
    }
}

/**
 * Set `inLibrary` on every result (MBID-then-name lookup against the Artist
 * table) and nudge match scores of in-library artists by their centroid
 * distance to the seed's centroid, bounded to ±RERANK_MAX_DELTA. Results
 * are then sorted by the adjusted score, so artists we own float up
 * slightly without hiding anything we don't. On any DB failure the input
 * passes through with inLibrary: false — discovery must not depend on the
 * local library.
 */
async function rerankWithLibrary(
    results: SimilarArtist[],
    seedMbid: string,
    seedName: string
): Promise<SimilarArtistWithLibrary[]> {
    if (results.length === 0) return [];

    try {
        // 1. Resolve each result to a local Artist row: MBID first, then
        // name for whatever the MBID lookup missed (Deezer results carry no
        // MBID, and LB MBIDs may not exist in our Artist table).
        const mbids = [
            ...new Set(
                results
                    .map((r) => r.mbid)
                    .filter((m): m is string => typeof m === "string" && m.length > 0)
            ),
        ];
        const rowByMbid = new Map<string, string>(); // mbid -> Artist row id
        if (mbids.length > 0) {
            const rows = await prisma.artist.findMany({
                where: { mbid: { in: mbids } },
                select: { id: true, mbid: true },
            });
            for (const r of rows) if (r.mbid) rowByMbid.set(r.mbid, r.id);
        }
        const missedNames = [
            ...new Set(
                results
                    .filter((r) => !r.mbid || !rowByMbid.has(r.mbid))
                    .map((r) => r.name)
            ),
        ];
        const rowByName = new Map<string, string>(); // name -> Artist row id
        if (missedNames.length > 0) {
            const rows = await prisma.artist.findMany({
                where: { name: { in: missedNames } },
                select: { id: true, name: true },
            });
            for (const r of rows) rowByName.set(r.name, r.id);
        }
        const resolveRow = (r: SimilarArtist): string | undefined =>
            (r.mbid ? rowByMbid.get(r.mbid) : undefined) ??
            rowByName.get(r.name);

        // 2. The seed's own row — distance is measured from its centroid.
        let seedRowId: string | undefined;
        if (seedMbid) {
            seedRowId =
                (await prisma.artist.findUnique({
                    where: { mbid: seedMbid },
                    select: { id: true },
                }))?.id ?? undefined;
        } else if (seedName) {
            seedRowId =
                (await prisma.artist.findFirst({
                    where: { name: seedName },
                    select: { id: true },
                }))?.id ?? undefined;
        }

        // 3. One query for every centroid we might need.
        const ids = new Set<string>();
        if (seedRowId) ids.add(seedRowId);
        for (const r of results) {
            const id = resolveRow(r);
            if (id) ids.add(id);
        }
        const centroidById = new Map<string, number[]>();
        if (ids.size > 0) {
            const rows = await prisma.$queryRaw<
                Array<{
                    artistId: string;
                    embedding: unknown;
                    trackCount: number;
                }>
            >`
                SELECT "artistId", embedding, "trackCount"
                FROM artist_embeddings
                WHERE "artistId" = ANY(${[...ids]})
            `;
            for (const row of rows) {
                const v = parseVector(String(row.embedding));
                if (v.length > 0 && Number(row.trackCount) >= 1) {
                    centroidById.set(row.artistId, v);
                }
            }
        }
        const seedCentroid = seedRowId
            ? centroidById.get(seedRowId)
            : undefined;

        // 4. Adjusted scores + flags. Distance 0 against the seed's
        // centroid → +0.1; distance >= 1 → −0.1; nothing in between is
        // outside the band. No measurable distance → no adjustment.
        const out: SimilarArtistWithLibrary[] = results.map((r) => {
            const rowId = resolveRow(r);
            const inLibrary = !!rowId;
            let match = r.match;
            const resultCentroid = rowId
                ? centroidById.get(rowId)
                : undefined;
            if (inLibrary && seedCentroid && resultCentroid) {
                const distance = 1 - cosineSimilarity(seedCentroid, resultCentroid);
                const delta =
                    RERANK_MAX_DELTA *
                    (1 - 2 * Math.min(Math.max(distance, 0), 1));
                match = Math.min(1, Math.max(0, r.match + delta));
            }
            return { ...r, match, inLibrary };
        });

        // Re-rank: sort by the adjusted score. Array#sort is stable, so
        // untouched entries keep their source order on ties.
        out.sort((a, b) => b.match - a.match);
        return out;
    } catch (err) {
        logger.warn(
            `[ArtistSimilarity] library re-rank failed for ${seedName}:`,
            err
        );
        return results.map((r) => ({ ...r, inLibrary: false }));
    }
}

async function store(key: string, value: SimilarArtist[]): Promise<void> {
    try {
        await redisClient.setex(key, CACHE_TTL, JSON.stringify(value));
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis write error:", err);
    }
}

/**
 * Dedupe by normalized name — the merge key across sources. Deezer results
 * carry no MBID and LB results may carry MBIDs the other source doesn't
 * know about, so name is the only key that collapses "same artist, two
 * sources" into one entry. First occurrence wins (LB before Deezer).
 */
function dedupeByName(list: SimilarArtist[]): SimilarArtist[] {
    const seen = new Set<string>();
    const out: SimilarArtist[] = [];
    for (const item of list) {
        const key = item.name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/**
 * Build search-result entries from a SimilarArtist list — same shape as
 * the retired Last.fm service's enrichSimilarArtists so the search route swaps import only.
 * The first three get the full treatment (bio via Wikidata/Wikipedia,
 * artwork via the cascade, genres from the stored/MB data); the rest are
 * served from the similarity entry alone plus artwork.
 */
export async function enrichSimilarArtists(
    similar: SimilarArtist[],
    limit = 6
): Promise<
    Array<
        {
            type: "music";
            id: string;
            name: string;
            listeners: number;
            url: string;
            image: string | null;
            mbid?: string;
            bio: string | null;
            tags: string[];
        }
    >
> {
    const { findArtistArtwork } = await import("./artwork");
    const { wikidataService } = await import("./wikidata");
    const { hasRealMbid } = await import("./artistIdentity");

    const capped = similar.slice(0, limit);
    const enrichCount = Math.min(3, capped.length);

    const build = async (
        s: SimilarArtist,
        enrich: boolean
    ): Promise<{
        type: "music";
        id: string;
        name: string;
        listeners: number;
        url: string;
        image: string | null;
        mbid?: string;
        bio: string | null;
        tags: string[];
    }> => {
        const base = {
            type: "music" as const,
            id: s.mbid || s.name,
            name: s.name,
            listeners: 0, // neither source publishes listener counts
            url: s.url,
            image: null as string | null,
            mbid: s.mbid,
            bio: null as string | null,
            tags: [] as string[],
        };
        const validMbid = s.mbid && hasRealMbid(s.mbid) ? s.mbid : undefined;

        if (!enrich) {
            base.image =
                (await findArtistArtwork({
                    name: s.name,
                    mbid: validMbid,
                }))?.url ?? null;
            return base;
        }

        const [wd, found] = await Promise.all([
            validMbid
                ? wikidataService.getArtistInfo(s.name, validMbid)
                : Promise.resolve(null),
            findArtistArtwork({ name: s.name, mbid: validMbid }),
        ]);
        base.image = found?.url ?? null;
        base.bio = wd?.summary || null;
        // WikidataResult carries {summary, heroUrl} only; tags are not a
        // Wikidata concept we can serve without an extra MB round-trip.
        base.tags = [];
        return base;
    };

    const [enriched, fast] = await Promise.all([
        Promise.all(capped.slice(0, enrichCount).map((s) => build(s, true))),
        Promise.all(capped.slice(enrichCount).map((s) => build(s, false))),
    ]);
    return [...enriched, ...fast].filter(Boolean);
}