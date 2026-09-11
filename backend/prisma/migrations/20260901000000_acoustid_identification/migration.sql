-- Add the AcoustID client key so the fingerprint-identification path can be
-- configured per-deploy, encrypted at rest like the other API keys.
ALTER TABLE "SystemSettings" ADD COLUMN "acoustidApiKey" TEXT;

-- Fingerprint-hash column on Track for intra-library duplicate/version
-- detection. Nullable: pre-AcoustID tracks stay null until the enrichment
-- path fingerprints them. A plain (non-unique) index is enough for the
-- "find tracks sharing this fingerprint" query the dedupe path runs.
ALTER TABLE "Track" ADD COLUMN "acoustidFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "Track_acoustidFingerprint_idx" ON "Track"("acoustidFingerprint");
