-- Failed enrichment attempts in a row for an artist. At the stage retry cap the artist is
-- set aside as unresolvable (asked again after a week) instead of retried every cycle.
ALTER TABLE "Artist" ADD COLUMN "enrichmentFailures" INTEGER NOT NULL DEFAULT 0;
