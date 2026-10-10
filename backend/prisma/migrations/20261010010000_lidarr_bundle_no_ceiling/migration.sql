-- A bundle is grabbed whatever its size.
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "lidarrBundleMaxSizeMB";
