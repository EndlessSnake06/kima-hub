-- A notification with a group key is one row per user that later alerts replace.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "groupKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_groupKey_key" ON "Notification"("userId", "groupKey");

-- The per-cycle enrichment alerts are no longer sent; their rows carry no user decision.
DELETE FROM "Notification" WHERE "title" IN ('Enrichment Complete', 'Enrichment Completed with Errors');
