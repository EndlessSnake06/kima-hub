-- The two analyzers' valence/arousal, stored raw.
-- valence/arousal become the blend of these, recomputed at every embedding
-- completion. CLAP used to blend into the shared pair, so each rebuild
-- re-blended its own output (erosion); with the raws stored, the blend is a
-- pure function and repeating it changes nothing.
ALTER TABLE "Track" ADD COLUMN "deamValence" FLOAT;
ALTER TABLE "Track" ADD COLUMN "deamArousal" FLOAT;
ALTER TABLE "Track" ADD COLUMN "clapValenceRaw" FLOAT;
ALTER TABLE "Track" ADD COLUMN "clapArousalRaw" FLOAT;

-- Tracks that never saw CLAP: their shared-pair value is the untouched DEAM
-- raw, recoverable in place. Blended tracks get NULL here and are re-queued
-- for mood analysis by the next migration.
UPDATE "Track"
SET "deamValence" = "valence", "deamArousal" = "arousal"
WHERE "analysisStatus" = 'completed'
  AND "valence" IS NOT NULL
  AND ("vibeAnalysisStatus" IS NULL OR "vibeAnalysisStatus" <> 'completed');
