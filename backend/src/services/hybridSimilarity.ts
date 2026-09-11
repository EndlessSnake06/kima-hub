import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";

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

export const WEIGHTS = {
    clap: 0.55,
    features: {
        energy: 0.10,
        valence: 0.09,
        arousal: 0.08,
        bpm: 0.07,
        danceability: 0.05,
        acousticness: 0.03,
        instrumentalness: 0.02,
        key: 0.01,
    },
};

// Normalized weights for features-only mode (sum to 1.0)
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

export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (features.vibeEmbeddings && features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using hybrid mode for track ${trackId}`);
        return findSimilarHybrid(trackId, limit);
    }

    if (features.vibeEmbeddings && !features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using CLAP-only mode for track ${trackId}`);
        return findSimilarClapOnly(trackId, limit);
    }

    if (features.musicCNN && !features.vibeEmbeddings) {
        logger.debug(`[HYBRID-SIMILARITY] Using features-only mode for track ${trackId}`);
        return findSimilarFeaturesOnly(trackId, limit);
    }

    logger.warn("[HYBRID-SIMILARITY] No similarity features available");
    return [];
}

async function findSimilarHybrid(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    // Fetch 5x candidates from CLAP to ensure good coverage after re-ranking
    const candidateMultiplier = 5;

    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT
                te.embedding,
                t.energy, t.valence, t.arousal, t.bpm, t."danceabilityMl",
                t.acousticness, t.instrumentalness, t.key, t."keyScale"
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            WHERE te.track_id = ${trackId}
        ),
        clap_candidates AS (
            SELECT
                te.track_id,
                te.embedding <=> (SELECT embedding FROM source) as clap_dist,
                GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as clap_sim
            FROM track_embeddings te
            WHERE te.track_id != ${trackId}
            ORDER BY te.embedding <=> (SELECT embedding FROM source)
            LIMIT ${limit * candidateMultiplier}
        )
        SELECT
            t.id,
            t.title,
            t.duration,
            c.clap_dist as distance,
            -- F4: weighted MEAN over PRESENT features. A null feature on either side
            -- contributes 0 to the numerator AND drops its weight from the denominator
            -- (its bpm_similarity()/key_similarity() 0.5 term is dropped too), so the
            -- total still divides by the sum of present weights. This removes the old
            -- 0.5-at-full-weight burial that capped under-analyzed tracks below a
            -- fully-analyzed one. When every feature is null the denominator collapses
            -- to WEIGHTS.clap, so the score falls back to the CLAP similarity alone.
            (
                ${WEIGHTS.clap} * c.clap_sim
                + ${WEIGHTS.features.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 - ABS(t.energy - s.energy) END)
                + ${WEIGHTS.features.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 - ABS(t.valence - s.valence) END)
                + ${WEIGHTS.features.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 - ABS(t.arousal - s.arousal) END)
                + ${WEIGHTS.features.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE bpm_similarity(t.bpm, s.bpm) END)
                + ${WEIGHTS.features.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 - ABS(t."danceabilityMl" - s."danceabilityMl") END)
                + ${WEIGHTS.features.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 - ABS(t.acousticness - s.acousticness) END)
                + ${WEIGHTS.features.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 - ABS(t.instrumentalness - s.instrumentalness) END)
                + ${WEIGHTS.features.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE key_similarity(t.key, t."keyScale", s.key, s."keyScale") END)
            )
            /
            (
                ${WEIGHTS.clap}
                + ${WEIGHTS.features.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 END)
                + ${WEIGHTS.features.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE 1 END)
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM clap_candidates c
        JOIN "Track" t ON c.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return results;
}

async function findSimilarClapOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
        )
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
            ar.name as "artistName"
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE te.track_id != ${trackId}
        ORDER BY distance
        LIMIT ${limit}
    `;

    return results;
}

/**
 * Fallback path (DB-9): used by findSimilarTracks only when MusicCNN features
 * are available but CLAP embeddings are not (see the mode selection above) --
 * the hybrid and CLAP-only paths above are the well-trodden ones and are not
 * touched here. This is a full CROSS JOIN scan over every Track, computing
 * the weighted feature-similarity expression per row before ORDER BY/LIMIT;
 * cost scales with total track count, which is fine for typical self-hosted
 * library sizes. A cheap bpm/key prefilter was considered to prune candidates
 * before that computation, but bpm_similarity() normalizes BPM into a 70-140
 * band via repeated doubling/halving to catch half-/double-time matches
 * (e.g. 70 vs 140 BPM scores as near-identical) -- a naive `ABS(t.bpm - s.bpm)`
 * prefilter in the WHERE clause would incorrectly exclude those without
 * reimplementing the same normalization, so it was left out rather than risk
 * silently dropping valid matches for a low-traffic fallback.
 */

async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const results = await prisma.$queryRaw<SimilarTrack[]>`
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
            WHERE t.id != ${trackId}
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
        FROM combined
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return results;
}
