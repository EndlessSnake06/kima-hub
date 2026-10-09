-- Identification only waits for the fingerprint to settle; a fingerprint closed for good leaves it its
-- other sources. Records closed as if they needed the fingerprint are asked again.
UPDATE "TrackStage"
   SET status = 'pending', retryable = true, failures = 0, redelivered = 0, "nextRetryAt" = NULL,
       "failureClass" = NULL, "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
       evidence = jsonb_build_object('reason', 'closed for a fingerprint it does not need'),
       "startedAt" = NULL, "finishedAt" = NULL
 WHERE stage = 'recording' AND status = 'failed' AND "lastErrorCode" = 'DEPENDENCY_CLOSED' AND "decidedAt" IS NULL;
