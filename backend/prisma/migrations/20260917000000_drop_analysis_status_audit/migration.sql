-- Drop the hand-made analysis-status audit scaffolding
-- 2026-09-16: "Delete").
--
-- These objects were created BY HAND on the production database during the
-- August 2026 outage as a debugging aid; no migration ever created them and
-- no code references them:
--   * trigger  track_analysis_audit  (AFTER UPDATE ON "Track")
--   * function audit_analysis_status()
--   * table    analysis_status_audit (+ its sequence analysis_status_audit_seq_seq
--              and pkey index, both dropped with the table)
--
-- Why they must go:
--   1. The trigger captured pg_stat_activity.query (full SQL text) into the
--      app_name column on every analysisStatus/analysisStartedAt change --
--      317k+ rows of unbounded growth nobody reads.
--   2. Its sequence falling 191,588 behind max(seq) was the root cause of the
--      2026-08-22..09-13 enrichment outage: every Track status write died on
--      a duplicate key. Any future restore or backfill that inserts explicit
--      seq values without setval recreates that outage.
--   3. Being absent from the schema, any database copy/restore silently
--      carries or loses them, and nothing in the repo can explain either.
--
-- IDEMPOTENT BY CONSTRUCTION: every drop is guarded with IF EXISTS, so this
-- is a no-op on fresh installs and on any database already cleaned.

DROP TRIGGER IF EXISTS track_analysis_audit ON "Track";
DROP TABLE IF EXISTS analysis_status_audit;
DROP FUNCTION IF EXISTS audit_analysis_status();
