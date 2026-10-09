-- 1.10 stored sound vectors from a different CLAP checkpoint under the label 1.11 used too; the two spaces are
-- unrelated. Vectors under the old label are removed (their feel and map rows go with them by cascade) and
-- their tracks are asked again; a track whose file is gone waits, closed as missing, for a scan to find it.
UPDATE "TrackStage"
   SET status = 'pending', attempt = 0, redelivered = 0, "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
       "failureClass" = NULL, retryable = true, "nextRetryAt" = NULL, evidence = NULL, "startedAt" = NULL,
       "finishedAt" = NULL, "decidedAt" = NULL, "decidedBy" = NULL
 WHERE stage = 'embedding'
   AND "trackId" IN (SELECT track_id FROM track_embeddings WHERE model_version = 'laion-clap-music-v1')
   AND "trackId" IN (SELECT id FROM "Track" WHERE "missingSince" IS NULL);

UPDATE "TrackStage"
   SET status = 'failed', retryable = false, "nextRetryAt" = NULL,
       "failureClass" = 'FILE_MISSING', "lastErrorCode" = 'FILE_MISSING',
       "lastErrorMessage" = 'file missing from the library; a scan that finds it again re-opens this record',
       evidence = jsonb_build_object('reason', 'file missing', 'closure', 'file-missing'),
       "startedAt" = COALESCE("startedAt", now()), "finishedAt" = COALESCE("finishedAt", now())
 WHERE stage = 'embedding'
   AND "trackId" IN (SELECT track_id FROM track_embeddings WHERE model_version = 'laion-clap-music-v1')
   AND "trackId" IN (SELECT id FROM "Track" WHERE "missingSince" IS NOT NULL);

UPDATE "Track"
   SET "vibeAnalysisStatus" = 'pending', "vibeAnalysisStartedAt" = NULL, "vibeAnalysisError" = NULL,
       "vibeAnalysisRetryCount" = 0, "vibeAnalysisStatusUpdatedAt" = NULL
 WHERE id IN (SELECT track_id FROM track_embeddings WHERE model_version = 'laion-clap-music-v1');

DELETE FROM track_embeddings WHERE model_version = 'laion-clap-music-v1';
