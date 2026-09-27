-- A track whose file is missing is never deleted: the scan sets this column
-- with the time it was found missing, and the next scan that finds the file
-- again clears it. Null is the normal present-on-disk state. The flag and the
-- timestamp are one nullable column -- a missing track is shown as missing
-- (since when) instead of having its plays, likes and stage answers cascade
-- away with the row.
ALTER TABLE "Track" ADD COLUMN "missingSince" TIMESTAMP(3);
