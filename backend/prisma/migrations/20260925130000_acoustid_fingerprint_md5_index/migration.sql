-- Real fpcalc fingerprints are ~3.3-3.6 kB, over the 2,704-byte btree key
-- limit, so every write to the plain index from 20260901000000 failed with
-- SQLSTATE 54000. Index the md5 of the value instead; the column itself holds
-- the full fingerprint.
DROP INDEX IF EXISTS "Track_acoustidFingerprint_idx";
CREATE INDEX "Track_acoustidFingerprint_md5_idx" ON "Track" (md5("acoustidFingerprint"));

-- The MusicBrainz recording a fingerprint lookup matched. Null when the
-- lookup found nothing.
ALTER TABLE "Track" ADD COLUMN "recordingMbid" TEXT;
