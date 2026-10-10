-- Nothing writes these: genres live in the genre tables, and the saved mood mix has its own table.
DROP INDEX IF EXISTS "Track_enrichmentTags_gin_idx";
ALTER TABLE "Track" DROP COLUMN IF EXISTS "enrichmentTags";
ALTER TABLE "User" DROP COLUMN IF EXISTS "moodMixParams";
