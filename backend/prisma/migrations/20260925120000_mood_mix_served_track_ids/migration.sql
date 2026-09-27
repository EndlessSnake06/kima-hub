-- AlterTable
ALTER TABLE "UserMoodMix" ADD COLUMN     "servedTrackIds" TEXT[];

-- Backfill
UPDATE "UserMoodMix" SET "servedTrackIds" = ARRAY[]::TEXT[] WHERE "servedTrackIds" IS NULL;
