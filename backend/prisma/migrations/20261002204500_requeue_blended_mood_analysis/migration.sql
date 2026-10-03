-- Re-queue the mood analyzer for every track whose DEAM raw was overwritten
-- by the CLAP blend, so the raws become recoverable and the pair becomes a
-- pure function of the raws. Attempt counts keep their history; the
-- stage machinery owns retries from here.
UPDATE "Track"
SET "analysisStatus" = 'pending', "analysisVersion" = NULL
WHERE "analysisStatus" = 'completed'
  AND "vibeAnalysisStatus" = 'completed'
  AND "deamValence" IS NULL;

-- retryable = true: a record closed as success under the old code carries
-- retryable = false, and the due query only offers retryable records. Without
-- this the re-queue would silently skip every such track.
UPDATE "TrackStage"
SET status = 'pending', "nextRetryAt" = NULL, retryable = true,
    "lastErrorCode" = NULL, "lastErrorMessage" = NULL, "failureClass" = NULL
WHERE stage = 'analysis' AND status = 'done'
  AND "trackId" IN (
    SELECT id FROM "Track"
    WHERE "analysisStatus" = 'pending' AND "deamValence" IS NULL
  );
