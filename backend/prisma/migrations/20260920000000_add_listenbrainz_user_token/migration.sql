-- ListenBrainz user token for scrobble forwarding (replaces the Last.fm
-- user key). Stored encrypted at rest via utils/encryption.ts, like the
-- other credential columns.
--
-- Shipped with a940bc67's schema change but initially missing the migration
-- (caught on a fresh-install boot 2026-09-20: "column
-- SystemSettings.listenbrainzUserToken does not exist"). Column is nullable
-- and idempotent so existing installs converge regardless of the manual fix
-- applied on the testbed.

ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "listenbrainzUserToken" TEXT;
