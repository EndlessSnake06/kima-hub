-- A record's attempt names each claim (a job id is unique per claim); `failures` counts only
-- reported failures, which alone use up retries. A wait for a paused source or a reset claim
-- costs no retry. Existing failed records keep the count their attempt carried.
ALTER TABLE "TrackStage" ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0;
UPDATE "TrackStage" SET "failures" = attempt WHERE status = 'failed';
