import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";
import { efFor, withEfSearch } from "../utils/knn";

export interface SimilarTrack {
    id: string;
    title: string;
    /**
     * Seconds. Carried because the vibe queue is built straight from these rows, and the
     * player treats duration as non-optional -- without it the seek bar, remaining time and
     * total queue length are all NaN for every track in the queue. The two sibling vibe
     * endpoints (/vibe/alchemy, /vibe/path) have always selected it; this one did not.
     */
    duration: number;
    /**
     * Distance from the source track. In the CLAP-backed paths it is the pgvector
     * cosine distance (0 = identical, 1 = orthogonal); in the CLAP-absent
     * features-only path there is no embedding, so it is the complement of the
     * feature similarity (1 - similarity). Never a fabricated constant.
     */
    distance: number;
    similarity: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

// Feature weights for the fallback used only when no CLAP embeddings exist
// (sum to 1.0). When embeddings exist they are NOT mixed in: see
// findSimilarTracks.
export const FEATURES_ONLY_WEIGHTS = {
    energy: 0.222,
    valence: 0.200,
    arousal: 0.178,
    bpm: 0.156,
    danceability: 0.111,
    acousticness: 0.067,
    instrumentalness: 0.044,
    key: 0.022,
};

/**
 * At most two tracks per album and four per artist, with the seed counted
 * against its own, so one album or artist cannot flood the list.
 */
export const MAX_PER_ALBUM = 2;
export const MAX_PER_ARTIST = 4;

/**
 * Similar tracks, ranked on the CLAP embedding alone when one exists. Blending
 * in audio features measured worse against human judgements, and several of
 * them are read off the same embedding. Installs without CLAP rank on features.
 */
export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (features.vibeEmbeddings) {
        logger.debug(`[HYBRID-SIMILARITY] Using CLAP fingerprint for track ${trackId}`);
        return findSimilarClapOnly(trackId, limit);
    }

    if (features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using features-only mode for track ${trackId}`);
        return findSimilarFeaturesOnly(trackId, limit);
    }

    logger.warn("[HYBRID-SIMILARITY] No similarity features available");
    return [];
}

async function findSimilarClapOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    // Ranks the whole library (the HNSW index only offers ef_search candidates,
    // too few once groups are thinned), inside the transaction that raised
    // ef_search. The LIMIT over-fetches by MAX_PER_ARTIST because thinByGroup also
    // charges the seed against its album and artist.
    const rows = await withEfSearch(efFor(limit, 1), (tx) =>
        tx.$queryRaw<SimilarTrack[]>(
            Prisma.sql`
                WITH source AS (
                    -- S2: read only through the scalar subqueries below; the
                    -- EXISTS guard over this CTE is what turns an unanalysed
                    -- seed into zero rows instead of ~limit arbitrary ones.
                    SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
                ),
                candidates AS (
                    SELECT
                        t.id,
                        t.title,
                        t.duration,
                        te.embedding <=> (SELECT embedding FROM source) as distance,
                        GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as similarity,
                        a.id as "albumId",
                        a.title as "albumTitle",
                        a."coverUrl" as "albumCoverUrl",
                        ar.id as "artistId",
                        ar.name as "artistName",
                        -- S3: rank the whole library, then thin to MAX_PER_ALBUM
                        -- per album in this CTE. The artist rank in the next CTE
                        -- is counted over these survivors ONLY -- computing both
                        -- windows over the unthinned ranking instead (as the
                        -- scope's SQL did) counts thinned-away album rows toward
                        -- the artist and silently returns fewer than
                        -- MAX_PER_ARTIST for a seed with a dominant album.
                        ROW_NUMBER() OVER (
                            PARTITION BY a.id
                            ORDER BY te.embedding <=> (SELECT embedding FROM source)
                        ) as "albumRank"
                    FROM track_embeddings te
                    JOIN "Track" t ON te.track_id = t.id
                    JOIN "Album" a ON t."albumId" = a.id
                    JOIN "Artist" ar ON a."artistId" = ar.id
                    WHERE te.track_id != ${trackId}
                    AND t."missingSince" IS NULL
                    -- S2: source is read only through the scalar subqueries above, so an
                    -- unanalysed seed (empty CTE) used to give every row a NULL distance
                    -- and answer with ~limit arbitrary tracks. EXISTS over the CTE turns
                    -- that into zero rows while leaving the cosine-distance ORDER BY
                    -- untouched, so the planner keeps the HNSW Index Scan (the guard shows
                    -- up as a One-Time Filter; a CROSS JOIN here would force a Seq Scan).
                    AND EXISTS (SELECT 1 FROM source)
                ),
                thinned AS (
                    SELECT
                        c.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY c."artistId"
                            ORDER BY c.distance
                        ) as "artistRank"
                    FROM candidates c
                    WHERE c."albumRank" <= ${MAX_PER_ALBUM}
                )
                -- Explicit columns: the two ROW_NUMBER() ranks are BIGINT, which
                -- arrives as a JS BigInt and makes any caller that JSON-encodes
                -- the rows answer 500.
                SELECT id, title, duration, distance, similarity, "albumId",
                       "albumTitle", "albumCoverUrl", "artistId", "artistName"
                FROM thinned
                WHERE "artistRank" <= ${MAX_PER_ARTIST}
                ORDER BY distance
                -- Over-fetch by MAX_PER_ARTIST: the SQL caps each group over
                -- the whole ranking, while the post-thinning below also has to
                -- fit the seed into its own album's/artist's budget, so up to
                -- 4 of these rows can be rejected there.
                LIMIT ${limit + MAX_PER_ARTIST}
            `,
        ),
    );

    // The seed consumes its own album's and artist's budget.
    const seed = await prisma.track.findUnique({
        where: { id: trackId },
        select: { album: { select: { artistId: true } }, albumId: true },
    });
    return thinByGroup(rows, {
        albumId: seed?.albumId,
        artistId: seed?.album?.artistId,
    }, limit);
}

/**
 * Walk the ranked rows keeping at most MAX_PER_ALBUM per album and
 * MAX_PER_ARTIST per artist, up to `limit`. The seed's groups start at 1.
 */
export function thinByGroup(
    ranked: SimilarTrack[],
    seed: { albumId?: string; artistId?: string },
    limit: number,
): SimilarTrack[] {
    const perAlbum = new Map<string, number>();
    const perArtist = new Map<string, number>();
    if (seed.albumId) perAlbum.set(seed.albumId, 1);
    if (seed.artistId) perArtist.set(seed.artistId, 1);

    const out: SimilarTrack[] = [];
    for (const row of ranked) {
        // The SQL over-fetches by exactly the seed's slot, so this bound is
        // a safety net rather than the mechanism -- but it keeps the
        // "return exactly `limit` when the library allows" contract honest.
        if (out.length >= limit) break;
        const albumCount = perAlbum.get(row.albumId) ?? 0;
        const artistCount = perArtist.get(row.artistId) ?? 0;
        // Accept a track only while both its album and its artist have budget,
        // the same rule the SQL applies.
        if (albumCount < MAX_PER_ALBUM && artistCount < MAX_PER_ARTIST) {
            out.push(row);
            perAlbum.set(row.albumId, albumCount + 1);
            perArtist.set(row.artistId, artistCount + 1);
        }
    }
    return out;
}

/**
 * Feature-only ranking for installs with MusiCNN features but no CLAP: a full
 * scan scoring every track. No BPM prefilter, because bpm_similarity folds
 * half and double time together and a plain BPM range would drop those.
 */
async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    // S3 mirrors the CLAP path exactly: rank every candidate on the feature
    // score, thin to MAX_PER_ALBUM per album, count the artist rank over the
    // survivors only, then enforce MAX_PER_ARTIST -- and keep the seed inside
    // its own album's and artist's budget via thinByGroup.
    const results = await prisma.$queryRaw<SimilarTrack[]>(
        Prisma.sql`
            WITH source AS (
                SELECT energy, valence, arousal, bpm, "danceabilityMl", acousticness, instrumentalness, key, "keyScale"
                FROM "Track"
                WHERE id = ${trackId}
            ),
            combined AS (
                SELECT
                    t.id,
                    t.title,
                    t.duration,
                    -- F4: weighted MEAN over PRESENT features, same contract as the
                    -- hybrid path. A null feature on either side contributes 0 to the
                    -- numerator and drops its weight from the denominator (its
                    -- bpm_similarity()/key_similarity() 0.5 term is dropped too), so
                    -- the score still divides by the sum of present weights rather than
                    -- the full 1.0. This removes the old 0.5-at-full-weight burial that
                    -- capped under-analyzed tracks below a fully-analyzed one.
                    (
                        ${FEATURES_ONLY_WEIGHTS.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 - ABS(t.energy - s.energy) END)
                        + ${FEATURES_ONLY_WEIGHTS.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 - ABS(t.valence - s.valence) END)
                        + ${FEATURES_ONLY_WEIGHTS.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 - ABS(t.arousal - s.arousal) END)
                        + ${FEATURES_ONLY_WEIGHTS.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE bpm_similarity(t.bpm, s.bpm) END)
                        + ${FEATURES_ONLY_WEIGHTS.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 - ABS(t."danceabilityMl" - s."danceabilityMl") END)
                        + ${FEATURES_ONLY_WEIGHTS.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 - ABS(t.acousticness - s.acousticness) END)
                        + ${FEATURES_ONLY_WEIGHTS.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 - ABS(t.instrumentalness - s.instrumentalness) END)
                        + ${FEATURES_ONLY_WEIGHTS.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE key_similarity(t.key, t."keyScale", s.key, s."keyScale") END)
                    ) AS num,
                    (
                        ${FEATURES_ONLY_WEIGHTS.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 END)
                        + ${FEATURES_ONLY_WEIGHTS.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE 1 END)
                    ) AS den,
                    a.id as "albumId",
                    a.title as "albumTitle",
                    a."coverUrl" as "albumCoverUrl",
                    ar.id as "artistId",
                    ar.name as "artistName"
                FROM "Track" t
                JOIN "Album" a ON t."albumId" = a.id
                JOIN "Artist" ar ON a."artistId" = ar.id
                CROSS JOIN source s
                WHERE t.id != ${trackId} AND t."missingSince" IS NULL
            ),
            scored AS (
                SELECT
                    c.*,
                    -- S3: rank the whole library on the feature score, thin to
                    -- MAX_PER_ALBUM per album here, and count the artist rank
                    -- over those survivors only (see the CLAP path for why).
                    ROW_NUMBER() OVER (
                        PARTITION BY c."albumId"
                        -- NULLIF: an unanalysed candidate has den = 0; the
                        -- score then falls back to the neutral 0.5 (see the
                        -- final SELECT), and NULLS LAST sorts those last.
                        ORDER BY (c.num / NULLIF(c.den, 0)) DESC NULLS LAST
                    ) as "albumRank"
                FROM combined c
            ),
            thinned AS (
                SELECT
                    s.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY s."artistId"
                        ORDER BY (s.num / NULLIF(s.den, 0)) DESC NULLS LAST
                    ) as "artistRank"
                FROM scored s
                WHERE s."albumRank" <= ${MAX_PER_ALBUM}
            )
            SELECT
                id,
                title,
                duration,
                -- F4/F5: the only meaningful distance in this CLAP-absent mode is the
                -- complement of the feature similarity (1 - similarity); 0 is a lie and
                -- is gone. When NO feature is present on either side the denominator is
                -- 0, so the score falls back to the neutral 0.5 (documented contract).
                CASE WHEN den = 0 THEN 0.5 ELSE num / den END AS similarity,
                CASE WHEN den = 0 THEN 0.5 ELSE 1 - (num / den) END AS distance,
                "albumId",
                "albumTitle",
                "albumCoverUrl",
                "artistId",
                "artistName"
            FROM thinned
            WHERE "artistRank" <= ${MAX_PER_ARTIST}
            ORDER BY similarity DESC
            -- Over-fetch by MAX_PER_ARTIST, same reason as the CLAP path.
            LIMIT ${limit + MAX_PER_ARTIST}
        `,
    );

    // The seed's own album/artist start their budgets at 1, so a seed's
    // album-mates and artist-mates are capped against the seed itself.
    const seed = await prisma.track.findUnique({
        where: { id: trackId },
        select: { album: { select: { artistId: true } }, albumId: true },
    });
    return thinByGroup(results, {
        albumId: seed?.albumId,
        artistId: seed?.album?.artistId,
    }, limit);
}
