-- Resolve the soulseekFallback column split and clean up the fake migration
-- rows that the old Dockerfile boot hack inserted on every container start.
--
-- WHY THIS EXISTS (2026-09-16, kima-hub-v1 takeover):
--   1. The boot script (Dockerfile start.sh, removed same day) INSERTed a row
--      into _prisma_migrations for the 20250101000000 rename on every boot,
--      guarded only on soulseekFallback existing, with ON CONFLICT DO NOTHING.
--      _prisma_migrations has no unique constraint on migration_name, so the
--      conflict clause was inert: one bogus row per boot (163 on the
--      production database). Those rows made `prisma migrate deploy` treat the
--      rename as already applied, so the old column never disappeared and the
--      boot condition never went false -- self-perpetuating since v1.3.0
--      (cc8d0f69).
--   2. On production, BOTH columns exist: soulseekFallback (holding the
--      live value 'lidarr', set under the old UI) and
--      primaryFailureFallback (added by 20260107000000 with DEFAULT 'none',
--      never user-written). The original migration would have tried
--      RENAME COLUMN to an existing name and errored -- which is why the hack
--      existed. The honest resolution keeps the LIVE value: where the old
--      column still holds a non-default value and the new column is at its
--      default, carry the value across, then drop the old column.
--
-- IDEMPOTENT BY CONSTRUCTION: every step is guarded on catalog state, so this
-- is a no-op on a healthy database (neither column split nor bogus rows) and
-- safe on a fresh database (no SystemSettings/_prisma_migrations yet).
--
-- NOTE ON ORDERING: `prisma migrate deploy` applies this AFTER
-- 20260915000000_track_embeddings_constraint_repair. That is fine; the two
-- touch unrelated objects.

DO $$
BEGIN
    -- Fresh or partially-migrated database: nothing to resolve.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'SystemSettings'
    ) THEN
        RAISE NOTICE '[soulseek-resolve] SystemSettings does not exist; nothing to do';
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'SystemSettings'
          AND column_name = 'soulseekFallback'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'SystemSettings'
              AND column_name = 'primaryFailureFallback'
        ) THEN
            -- Both columns: the split state. Carry the LIVE value across.
            -- The old column holds the operator's setting (e.g. 'lidarr' on
            -- prod, verified 2026-09-16); the new one sits at its default
            -- because no UI ever wrote it. Copy old -> new ONLY where the old
            -- value is non-default and the new one is untouched, so a
            -- deliberate later setting is never overwritten.
            UPDATE "SystemSettings"
            SET "primaryFailureFallback" = "soulseekFallback"
            WHERE "soulseekFallback" IS DISTINCT FROM 'none'
              AND "primaryFailureFallback" = 'none';
            ALTER TABLE "SystemSettings" DROP COLUMN "soulseekFallback";
            RAISE NOTICE '[soulseek-resolve] both columns existed: carried live value, dropped soulseekFallback';
        ELSE
            -- Only the old column: the state the original migration intended.
            ALTER TABLE "SystemSettings"
                RENAME COLUMN "soulseekFallback" TO "primaryFailureFallback";
            RAISE NOTICE '[soulseek-resolve] renamed soulseekFallback -> primaryFailureFallback';
        END IF;
    ELSE
        RAISE NOTICE '[soulseek-resolve] soulseekFallback absent; nothing to do';
    END IF;
END $$;

-- Remove the bogus _prisma_migrations rows the boot hack inserted (empty
-- checksum identifies them; a genuine applied row carries a proper prisma
-- checksum and is kept). Guarded for fresh databases where the table does not
-- exist yet.
DO $$
DECLARE
    removed integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ) THEN
        DELETE FROM "_prisma_migrations"
        WHERE migration_name = '20250101000000_rename_soulseek_fallback'
          AND (checksum IS NULL OR checksum = '');
        GET DIAGNOSTICS removed = ROW_COUNT;
        IF removed > 0 THEN
            RAISE NOTICE '[soulseek-resolve] removed % bogus _prisma_migrations row(s)', removed;
        END IF;
    ELSE
        RAISE NOTICE '[soulseek-resolve] _prisma_migrations absent; no cleanup needed';
    END IF;
END $$;
