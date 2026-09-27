-- lease expiry re-offers a record without consuming an attempt;
-- `redelivered` bounds the silent-crash loop (closes at 3).
ALTER TABLE "TrackStage" ADD COLUMN IF NOT EXISTS "redelivered" INTEGER NOT NULL DEFAULT 0;
