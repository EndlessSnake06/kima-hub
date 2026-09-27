-- Scrobbling belongs to the user who listened: a per-user, encrypted
-- ListenBrainz token replaces the server-wide one.
ALTER TABLE "UserSettings" ADD COLUMN IF NOT EXISTS "listenbrainzToken" text;

-- The server-wide token path is deleted, not deprecated.
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "listenbrainzUserToken";
