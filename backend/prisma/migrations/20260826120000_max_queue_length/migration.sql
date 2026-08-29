-- The play queue's length becomes an operator setting rather than a constant.
--
-- It was 2000, hard-coded in two places that a comment kept in step by hand:
-- the client sliced before sending and the route sliced on receipt. The queue
-- is a list of track references, so the ceiling was never about storage -- it
-- was a number somebody picked. Now it is one number, owned by the server.
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "maxQueueLength" INTEGER NOT NULL DEFAULT 10000;
