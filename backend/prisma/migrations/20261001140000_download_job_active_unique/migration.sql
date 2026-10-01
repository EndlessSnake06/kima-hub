UPDATE "DownloadJob"
SET "artistMbid" = metadata->>'artistMbid'
WHERE "artistMbid" IS NULL AND metadata->>'artistMbid' IS NOT NULL;

DROP INDEX IF EXISTS "DownloadJob_userId_targetMbid_discoveryBatchId_key";

-- Keep one active job per album: the one furthest along, then the oldest.
UPDATE "DownloadJob" d
SET status = 'failed', error = 'Duplicate of another active download', "completedAt" = now()
FROM (
    SELECT id, row_number() OVER (
        PARTITION BY "userId", "targetMbid", "discoveryBatchId"
        ORDER BY (status = 'processing') DESC, "createdAt", id
    ) AS rank
    FROM "DownloadJob"
    WHERE status IN ('pending', 'processing') AND type = 'album' AND "targetMbid" IS NOT NULL
) ranked
WHERE d.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX "DownloadJob_active_album_key"
    ON "DownloadJob" ("userId", "targetMbid", "discoveryBatchId") NULLS NOT DISTINCT
    WHERE status IN ('pending', 'processing') AND type = 'album' AND "targetMbid" IS NOT NULL;
