-- Public vibe surface: which user's state is exposed to chevron7.io, and whether.
--
-- Two fields, both on the existing flat SystemSettings row, defaulting closed.
-- The public API reads the state of `publicVibeUserId` only, never a user id
-- supplied in the request. Until `publicVibeEnabled` is set TRUE every route
-- returns 404, so a fresh or default install is indistinguishable from a site
-- that simply has no public map.
--
-- Nullable userId on purpose: enabling the flag without designating a user is a
-- misconfiguration we would rather surface as "nothing to publish" than crash on.

ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "publicVibeEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "publicVibeUserId" TEXT;
