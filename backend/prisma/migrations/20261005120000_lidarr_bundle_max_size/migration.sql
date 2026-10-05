-- Bundle-grab fallback: ceiling (MB) on releases Kima grabs whole; 0 = no cap.
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "lidarrBundleMaxSizeMB" INTEGER NOT NULL DEFAULT 0;
