-- artist_embeddings: per-artist centroid vectors over track_embeddings.
--
-- Replaces the Last.fm artist.getSimilar dependency with local similarity:
-- each artist's centroid is the mean of its tracks' CLAP embeddings
-- (512-d, see services/audio-analyzer-clap). Queries are cosine NN over
-- these centroids (services/artistSimilarity.ts).
--
-- Created outside Prisma's tracked migrations like track_embeddings itself
-- (the pgvector migrations were applied directly); this file documents the
-- exact DDL so any environment can re-apply it idempotently.

CREATE TABLE IF NOT EXISTS "artist_embeddings" (
    "artistId"   TEXT PRIMARY KEY,
    "embedding"  vector(512) NOT NULL,
    "computedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "trackCount" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "artist_embeddings_embedding_idx"
    ON "artist_embeddings" USING hnsw ("embedding" vector_cosine_ops);
