-- One answer per track per stage.
--
-- The stage name is the question ("recording", "analysis", "embedding");
-- `status` is that question's answer. Because the answer lives on the record
-- and not in a reused Track column, a track that is `failed` or `blocked` at
-- one stage cannot hold another track's stage behind it.

-- 1. The per-track-per-stage record.
CREATE TABLE IF NOT EXISTS "TrackStage" (
  "id"               TEXT        NOT NULL,
  "trackId"          TEXT        NOT NULL,
  "stage"            TEXT        NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  "source"           TEXT,
  "attempt"          INTEGER     NOT NULL DEFAULT 0,
  "lastErrorCode"    TEXT,
  "lastErrorMessage" TEXT,
  "failureClass"     TEXT,
  "retryable"        BOOLEAN     NOT NULL DEFAULT true,
  "nextRetryAt"      TIMESTAMP(3),
  "evidence"         JSONB,
  "startedAt"        TIMESTAMP(3),
  "finishedAt"       TIMESTAMP(3),
  "decidedAt"        TIMESTAMP(3),
  "decidedBy"        TEXT,
  CONSTRAINT "TrackStage_pkey" PRIMARY KEY ("id"),
  -- One answer per stage per track — this is what stops the same question
  -- being answered twice into two different rows.
  CONSTRAINT "TrackStage_trackId_stage_key" UNIQUE ("trackId", "stage")
);

-- What the stage queue actually queries: "give me the next work per stage".
CREATE INDEX IF NOT EXISTS "TrackStage_stage_status_nextRetryAt_idx"
  ON "TrackStage" ("stage", "status", "nextRetryAt");

ALTER TABLE "TrackStage"
  ADD CONSTRAINT "TrackStage_trackId_fkey"
  FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. One record per *source*, so a paused source is one row rather than 2,787.
CREATE TABLE IF NOT EXISTS "SourceAttempt" (
  "id"               TEXT        NOT NULL,
  "source"           TEXT        NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  "attempt"          INTEGER     NOT NULL DEFAULT 0,
  "lastErrorCode"    TEXT,
  "lastErrorMessage" TEXT,
  "failureClass"     TEXT,
  "retryable"        BOOLEAN     NOT NULL DEFAULT true,
  "nextRetryAt"      TIMESTAMP(3),
  "evidence"         JSONB,
  "startedAt"        TIMESTAMP(3),
  "finishedAt"       TIMESTAMP(3),
  "decidedAt"        TIMESTAMP(3),
  "decidedBy"        TEXT,
  CONSTRAINT "SourceAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceAttempt_source_key" UNIQUE ("source")
);

-- 3. Seed every track with the three stages, so "Tracks with no TrackStage
--    row at all: 8,984 -> 0" holds the moment this lands. The status is
--    derived from the current column so the migration does not re-ask a
--    question the library has already answered, and does not mark a
--    permanently-failed track retryable.
INSERT INTO "TrackStage"
  (id, "trackId", stage, status, source, attempt, "lastErrorCode", "lastErrorMessage",
   "failureClass", retryable, "nextRetryAt", evidence, "finishedAt")
SELECT
  md5(t.id || ':recording'),
  t.id,
  'recording',
  CASE
    WHEN t."enrichmentTags" @> ARRAY['_not_found'] THEN 'failed'
    -- Queued-but-unanswered is an OPEN question, not an answer: seeding it
    -- 'done' would retire the question with finishedAt set and nothing
    -- behind it, so it stays pending for the stage queue to ask.
    WHEN t."enrichmentTags" @> ARRAY['_queued']    THEN 'pending'
    WHEN cardinality(t."enrichmentTags") > 0        THEN 'done'
    ELSE 'pending'
  END,
  'musicbrainz',
  CASE WHEN t."enrichmentTags" @> ARRAY['_not_found'] THEN 3 ELSE 0 END,
  CASE WHEN t."enrichmentTags" @> ARRAY['_not_found'] THEN 'RECORDING_NOT_FOUND' ELSE NULL END,
  CASE WHEN t."enrichmentTags" @> ARRAY['_not_found']
       THEN 'No recording could be identified for this track' ELSE NULL END,
  CASE WHEN t."enrichmentTags" @> ARRAY['_not_found'] THEN 'INCONCLUSIVE' ELSE NULL END,
  -- A track whose recording was never found stays retryable: the answer is
  -- "we could not tell", not "we know this is damaged".
  true,
  NULL,
  jsonb_build_object('seededFrom', 'Track.enrichmentTags'),
  CASE WHEN t."enrichmentTags" @> ARRAY['_queued'] THEN NULL
       WHEN cardinality(t."enrichmentTags") > 0 THEN now() ELSE NULL END
FROM "Track" t
ON CONFLICT ("trackId", "stage") DO NOTHING;

INSERT INTO "TrackStage"
  (id, "trackId", stage, status, source, attempt, "lastErrorCode", "lastErrorMessage",
   "failureClass", retryable, "nextRetryAt", evidence, "finishedAt")
SELECT
  md5(t.id || ':analysis'),
  t.id,
  'analysis',
  CASE
    WHEN t."analysisStatus" = 'completed'          THEN 'done'
    WHEN t."analysisStatus" = 'permanently_failed' THEN 'failed'
    WHEN t."analysisStatus" = 'failed'              THEN 'failed'
    ELSE 'pending'
  END,
  'analyzer',
  t."analysisRetryCount",
  -- Track stores only the message, never a code, so the seed writes the class
  -- it can prove from the status rather than inventing a per-file code.
  CASE WHEN t."analysisStatus" = 'permanently_failed' THEN 'DECODE_FAILED'
       WHEN t."analysisStatus" = 'failed'              THEN 'ANALYSIS_FAILED'
       ELSE NULL END,
  CASE WHEN t."analysisStatus" IN ('failed', 'permanently_failed')
       THEN COALESCE(t."analysisError", 'Analysis failed') ELSE NULL END,
  CASE WHEN t."analysisStatus" = 'permanently_failed' THEN 'DAMAGED'
       WHEN t."analysisStatus" = 'failed'              THEN 'INCONCLUSIVE'
       ELSE NULL END,
  -- `permanently_failed` is terminal: it must NOT come back retryable, or the
  -- 55 damaged files restart their loop the moment this migration lands.
  (t."analysisStatus" <> 'permanently_failed'),
  CASE WHEN t."analysisStatus" IN ('failed', 'permanently_failed')
       THEN now() + interval '30 minutes' ELSE NULL END,
  jsonb_build_object('seededFrom', 'Track.analysisStatus'),
  CASE WHEN t."analysisStatus" = 'completed' THEN now() ELSE NULL END
FROM "Track" t
ON CONFLICT ("trackId", "stage") DO NOTHING;

INSERT INTO "TrackStage"
  (id, "trackId", stage, status, source, attempt, "lastErrorCode", "lastErrorMessage",
   "failureClass", retryable, "nextRetryAt", evidence, "finishedAt")
SELECT
  md5(t.id || ':embedding'),
  t.id,
  'embedding',
  CASE
    WHEN te.track_id IS NOT NULL                          THEN 'done'
    WHEN t."vibeAnalysisStatus" = 'failed'                THEN 'failed'
    WHEN t."vibeAnalysisStatus" = 'completed'             THEN 'pending'
    ELSE 'pending'
  END,
  'clap',
  COALESCE(t."vibeAnalysisRetryCount", 0),
  CASE WHEN t."vibeAnalysisStatus" = 'failed'
       THEN 'EMBEDDING_FAILED' ELSE NULL END,
  CASE WHEN t."vibeAnalysisStatus" = 'failed'
       THEN COALESCE(t."vibeAnalysisError", 'Embedding failed') ELSE NULL END,
  CASE WHEN t."vibeAnalysisStatus" = 'failed' THEN 'INCONCLUSIVE' ELSE NULL END,
  true,
  CASE WHEN t."vibeAnalysisStatus" = 'failed'
       THEN now() + interval '30 minutes' ELSE NULL END,
  jsonb_build_object('seededFrom', 'track_embeddings / Track.vibeAnalysisStatus'),
  CASE WHEN te.track_id IS NOT NULL THEN now() ELSE NULL END
FROM "Track" t
LEFT JOIN "track_embeddings" te ON te.track_id = t.id
ON CONFLICT ("trackId", "stage") DO NOTHING;

-- 4. Seed the two sources that actually answer questions today.
INSERT INTO "SourceAttempt"
  (id, source, status, attempt, "lastErrorCode", "lastErrorMessage",
   "failureClass", retryable, "nextRetryAt", evidence)
VALUES
  ('source_analyzer',  'analyzer',     'pending', 0, NULL, NULL, NULL, true, NULL,
   jsonb_build_object('seededFrom', 'migration 20260925140000')),
  ('source_clap',      'clap',         'pending', 0, NULL, NULL, NULL, true, NULL,
   jsonb_build_object('seededFrom', 'migration 20260925140000')),
  ('source_musicbrainz', 'musicbrainz', 'pending', 0, NULL, NULL, NULL, true, NULL,
   jsonb_build_object('seededFrom', 'migration 20260925140000'))
ON CONFLICT ("source") DO NOTHING;
