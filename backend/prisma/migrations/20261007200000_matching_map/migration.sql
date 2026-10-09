-- The vibe map, computed by the similarity step.

CREATE TABLE "matching_map" (
    "track_id" TEXT NOT NULL,
    "embedded_at" TIMESTAMPTZ(6) NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "z" DOUBLE PRECISION NOT NULL,
    "colour" DOUBLE PRECISION NOT NULL,
    "laid_out" BOOLEAN NOT NULL,

    CONSTRAINT "matching_map_pkey" PRIMARY KEY ("track_id")
);

ALTER TABLE "matching_map" ADD CONSTRAINT "matching_map_track_id_fkey"
    FOREIGN KEY ("track_id") REFERENCES "track_embeddings"("track_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "matching_state"
    ADD COLUMN "mapVersion" TEXT,
    ADD COLUMN "mapFrame" JSONB,
    ADD COLUMN "mapUpdatedAt" TIMESTAMPTZ(6);

-- The similarity step recomputes every position.
ALTER TABLE "track_embeddings" DROP COLUMN "map_x", DROP COLUMN "map_y", DROP COLUMN "map_z";
