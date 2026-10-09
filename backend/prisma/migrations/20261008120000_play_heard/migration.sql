-- A play recorded under the listen rule is a listen by construction; the history audit never judges it a skip.
ALTER TABLE "Play" ADD COLUMN "heard" BOOLEAN NOT NULL DEFAULT false;

-- Every play since this install moved to 1.11 was recorded under that rule. "playedAt" holds UTC without a zone;
-- it is read as UTC, so a database whose sessions run in another zone compares the same instants.
UPDATE "Play" SET "heard" = true
WHERE ("playedAt" AT TIME ZONE 'UTC') >= (
    SELECT min("finished_at") FROM "_prisma_migrations"
    WHERE "migration_name" >= '20260825010000_play_audit_ignore' AND "finished_at" IS NOT NULL
);
