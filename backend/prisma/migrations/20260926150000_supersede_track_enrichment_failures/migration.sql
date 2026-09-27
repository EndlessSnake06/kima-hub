-- TrackStage supersedes EnrichmentFailure for per-track stage failures.
--
-- The engine used to write every track-stage failure (recording → "track",
-- analysis → "audio", embedding → "vibe", fingerprint → "scan") to TWO
-- ledgers: the TrackStage record the queue decides from, and the older
-- EnrichmentFailure table. Only one of them was ever settled on success, so
-- the failures list drifted — 757 tracks whose stages had long succeeded
-- still showed open failures, and the count was stuck at 2,787.
--
-- One record per fact: from here on the failures API reads TrackStage for
-- track stages, and EnrichmentFailure remains only for entities that have
-- no TrackStage (artist, podcast). The existing track-kind rows are marked
-- RESOLVED with a note saying TrackStage supersedes them — the ledger is a
-- history, so rows are never deleted.

UPDATE "EnrichmentFailure"
SET "resolved" = true,
    "resolvedAt" = COALESCE("resolvedAt", now()),
    "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"supersededBy": "TrackStage"}'::jsonb
WHERE "entityType" IN ('track', 'audio', 'vibe', 'scan')
  AND "resolved" = false;
