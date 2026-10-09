-- Whether Kima removes junk downloads (no usable music, the wrong album) from
-- Lidarr so it tries the next release. On by default; off leaves them to the
-- user's own Lidarr setup.
ALTER TABLE "SystemSettings" ADD COLUMN "lidarrRemoveJunk" BOOLEAN NOT NULL DEFAULT true;
