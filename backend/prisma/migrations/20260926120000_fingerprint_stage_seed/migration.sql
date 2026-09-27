-- GAP 1 (2026-09-26): the AcoustID fingerprint sweep covers EVERY track
-- Until now only a track that had no ISRC
-- AND survived file-tag and name-search identification ever got a
-- fingerprint, so most of the library never did.
--
-- `TrackStage.stage` is a plain text column, so the new 'fingerprint' value
-- needs no DDL. What every track needs is its fingerprint QUESTION: this
-- seeds a pending `fingerprint` record for every track that exists, in the
-- same shape the 20260925140000_track_stage_gating seed used (id =
-- md5(trackId || ':' || stage); ON CONFLICT DO NOTHING so re-running, or a
-- record that already exists, is untouched and no attempt history is lost).
--
-- The stage is answered by the worker locally (fpcalc →
-- Track.acoustidFingerprint) whether or not any AcoustID lookup matches; a
-- paused 'acoustid' source gates only the network lookup, never this stage —
-- its source is 'fpcalc', the local binary.

INSERT INTO "TrackStage"
    (id, "trackId", stage, status, source, attempt, retryable, evidence)
SELECT md5(t.id || ':fingerprint'),
       t.id,
       'fingerprint',
       'pending',
       'fpcalc',
       0,
       true,
       '{"seeded_by": "20260926120000_fingerprint_stage_seed"}'::jsonb
FROM "Track" t
WHERE NOT EXISTS (
    SELECT 1 FROM "TrackStage" ts
    WHERE ts."trackId" = t.id AND ts.stage = 'fingerprint'
)
ON CONFLICT ("trackId", stage) DO NOTHING;
