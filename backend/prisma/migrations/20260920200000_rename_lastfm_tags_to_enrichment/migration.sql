-- Rename the legacy-named Track.lastfmTags column to Track.enrichmentTags
-- and drop the four dead SystemSettings lastfm* columns.
--
-- Background: since the Last.fm tag service was deleted (e3381238), the
-- column holds MusicBrainz genre tags plus the queue sentinels '_queued' /
-- '_no_mood_tags' / '_not_found'. The data and every query against it are
-- live; only the provider name in the column name was stale.
--
-- NOTE on why the target is NOT "moodTags": Track.moodTags already exists
-- (since 20251130000000_init) with older, differently-shaped data and LIVE
-- queries against it (mood-mix tag filters, the workout filter,
-- moodBucketService). Renaming lastfmTags INTO that name would either
-- collide outright or — if the old column were dropped first — silently
-- repoint those mood-vocabulary queries ("energetic", "workout", "sad")
-- at MusicBrainz genre data that does not use that vocabulary. The two
-- columns stay separate; the live one just loses its provider name.

-- 1. Rename the column. Guarded so re-running is a no-op once renamed.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Track' AND column_name = 'lastfmTags'
    ) THEN
        ALTER TABLE "Track" RENAME COLUMN "lastfmTags" TO "enrichmentTags";
    END IF;
END
$$;

-- 2. Drop the dead SystemSettings columns. Code references were already
--    removed in e3381238; the columns were never read by live logic.
ALTER TABLE "SystemSettings"
    DROP COLUMN IF EXISTS "lastfmApiKey",
    DROP COLUMN IF EXISTS "lastfmApiSecret",
    DROP COLUMN IF EXISTS "lastfmUserKey",
    DROP COLUMN IF EXISTS "lastfmEnabled";

-- 3. Recreate the two enrichment indexes under names that match the new
--    column. Postgres follows column renames automatically (the existing
--    indexes already point at "enrichmentTags" after step 1), so this is
--    purely renaming the index objects themselves; DROP + CREATE with the
--    identical definitions keeps predicate and name in sync and is
--    idempotent.
--
--    3a. Backlog index. The predicate MUST stay `"enrichmentTags" = '{}'`
--        — the exact shape Prisma emits for { equals: [] } — per the
--        measurements in 20260801140000_fix_backlog_indexes. Do NOT
--        "restore" the array_length(...) IS NULL variant; it is provably
--        unreachable for the ORM query.
DROP INDEX IF EXISTS "Track_pending_moodtags_idx";
CREATE INDEX IF NOT EXISTS "Track_pending_enrichmenttags_idx"
    ON "Track" (id) WHERE ("enrichmentTags" = '{}');

--    3b. GIN index for the sentinel containment tests
--        ({ has: "_queued" } etc.) on the same column.
DROP INDEX IF EXISTS "Track_lastfmTags_gin_idx";
CREATE INDEX IF NOT EXISTS "Track_enrichmentTags_gin_idx"
    ON "Track" USING GIN ("enrichmentTags");