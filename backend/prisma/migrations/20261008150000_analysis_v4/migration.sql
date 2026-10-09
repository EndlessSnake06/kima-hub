-- Analysis 2.1b6-enhanced-v4 decodes stereo correctly, keeps mono files at their level and measures loudness by
-- EBU R128. Every answer from an earlier analyzer (another version, or none stored) is asked again, except one a
-- person decided; a missing file's answer is left as it is.
UPDATE "TrackStage"
   SET status = 'pending', redelivered = 0, "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
       "failureClass" = NULL, retryable = true, "nextRetryAt" = NULL,
       evidence = jsonb_build_object('reason', 'analysis version changed'), "startedAt" = NULL, "finishedAt" = NULL
 WHERE stage = 'analysis' AND status = 'done' AND "decidedAt" IS NULL
   AND "trackId" IN (SELECT id FROM "Track"
                      WHERE "missingSince" IS NULL
                        AND "analysisVersion" IS DISTINCT FROM '2.1b6-enhanced-v4');

UPDATE "Track" t
   SET "analysisStatus" = 'pending', "analysisError" = NULL, "analysisStartedAt" = NULL
  FROM "TrackStage" ts
 WHERE ts."trackId" = t.id AND ts.stage = 'analysis' AND ts.status = 'pending'
   AND ts.evidence ->> 'reason' = 'analysis version changed';
