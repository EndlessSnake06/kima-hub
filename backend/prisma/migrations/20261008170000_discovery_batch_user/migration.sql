-- Nothing linked a discovery batch to its user, so deleting a user from the admin screen left
-- their batches behind. Those leftovers belong to users who no longer exist and are removed;
-- from now on a user's batches go with the user.
DELETE FROM "DiscoveryBatch" WHERE "userId" NOT IN (SELECT id FROM "User");

ALTER TABLE "DiscoveryBatch" ADD CONSTRAINT "DiscoveryBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
