-- Resolve (do NOT delete) stale EnrichmentFailure rows whose track has
-- since completed the stage the failure describes: the ledger must tell the
-- truth, and deleting the rows would erase the history.
--
-- Mapping: entityType 'track' -> stage 'recording', 'audio' -> 'analysis',
-- 'vibe' -> 'embedding'; the entityId is the trackId. Other entityTypes
-- (artist, podcast, scan) describe no track stage and stay untouched.
--
-- Idempotent: every statement only touches rows that are still unresolved,
-- so running it twice produces the same result and never rewrites
-- resolvedAt on already-resolved rows.

-- 1. Track-recording failures whose recording stage is answered done.
UPDATE "EnrichmentFailure" ef
   SET resolved = true,
       "resolvedAt" = now()
  WHERE ef.resolved = false
    AND ef."entityType" = 'track'
    AND EXISTS (
        SELECT 1 FROM "TrackStage" ts
         WHERE ts."trackId" = ef."entityId"
           AND ts.stage = 'recording'
           AND ts.status = 'done'
    );

-- 2. Audio-analysis failures whose analysis stage is answered done.
UPDATE "EnrichmentFailure" ef
   SET resolved = true,
       "resolvedAt" = now()
  WHERE ef.resolved = false
    AND ef."entityType" = 'audio'
    AND EXISTS (
        SELECT 1 FROM "TrackStage" ts
         WHERE ts."trackId" = ef."entityId"
           AND ts.stage = 'analysis'
           AND ts.status = 'done'
    );

-- 3. Vibe-embedding failures whose embedding stage is answered done.
UPDATE "EnrichmentFailure" ef
   SET resolved = true,
       "resolvedAt" = now()
  WHERE ef.resolved = false
    AND ef."entityType" = 'vibe'
    AND EXISTS (
        SELECT 1 FROM "TrackStage" ts
         WHERE ts."trackId" = ef."entityId"
           AND ts.stage = 'embedding'
           AND ts.status = 'done'
    );