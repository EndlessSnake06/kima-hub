-- The 1.11 matching engine.

CREATE TABLE "matching_feel" (
    "track_id" TEXT NOT NULL,
    "embedded_at" TIMESTAMPTZ(6) NOT NULL,
    "probe" TEXT NOT NULL,
    "valence" REAL NOT NULL,
    "arousal" REAL NOT NULL,

    CONSTRAINT "matching_feel_pkey" PRIMARY KEY ("track_id")
);

ALTER TABLE "matching_feel" ADD CONSTRAINT "matching_feel_track_id_fkey"
    FOREIGN KEY ("track_id") REFERENCES "track_embeddings"("track_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "matching_state" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "version" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "trackCount" INTEGER NOT NULL,
    "feelMeanValence" DOUBLE PRECISION NOT NULL,
    "feelMeanArousal" DOUBLE PRECISION NOT NULL,
    "feelSdValence" DOUBLE PRECISION NOT NULL,
    "feelSdArousal" DOUBLE PRECISION NOT NULL,
    "soundSpread" DOUBLE PRECISION NOT NULL,
    "genreSpread" DOUBLE PRECISION NOT NULL,
    "genreWeight" DOUBLE PRECISION NOT NULL,
    "genres" JSONB NOT NULL,
    "builtAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matching_state_pkey" PRIMARY KEY ("id")
);

-- Artist centroids are now computed per request from the eligible tracks.
DROP TABLE IF EXISTS "artist_embeddings";
