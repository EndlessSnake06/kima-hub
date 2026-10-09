import type { Prisma } from "@prisma/client";

/**
 * Close every open stage record of a flagged-missing track as FILE_MISSING, so
 * `pending` always means work the sweep can do and the hang watchdog does not
 * fire on files that are gone. Runs over every flagged track, not just new ones.
 * The Track status columns mirror the closed records.
 */
export async function closeStagesForMissingTracks(
    client: Pick<Prisma.TransactionClient, "$queryRaw">
): Promise<number> {
    const [row] = await client.$queryRaw<Array<{ closed: number }>>`
        WITH closed AS (
            UPDATE "TrackStage" ts
               SET status = 'failed',
                   retryable = false,
                   "nextRetryAt" = NULL,
                   "startedAt" = COALESCE(ts."startedAt", now()),
                   "finishedAt" = COALESCE(ts."finishedAt", now()),
                   "failureClass" = 'FILE_MISSING',
                   "lastErrorCode" = 'FILE_MISSING',
                   "lastErrorMessage" = 'file missing from the library; a scan that finds it again re-opens this record',
                   evidence = jsonb_build_object('reason', 'file missing', 'closure', 'file-missing')
              WHERE (ts.status = 'pending'
                     OR (ts.status = 'failed' AND ts.retryable
                         AND (ts."nextRetryAt" IS NULL
                              OR ts."nextRetryAt" <= now())))
                AND ts."trackId" IN (
                    SELECT id FROM "Track" WHERE "missingSince" IS NOT NULL
                )
            RETURNING ts."trackId", ts.stage
        ), per_track AS (
            SELECT "trackId",
                   bool_or(stage = 'analysis') AS analysis,
                   bool_or(stage = 'embedding') AS embedding
              FROM closed
             GROUP BY "trackId"
        ), mirrored AS (
            UPDATE "Track" t
               SET "analysisStatus" = CASE WHEN p.analysis THEN 'permanently_failed' ELSE t."analysisStatus" END,
                   "analysisError" = CASE WHEN p.analysis THEN 'file missing' ELSE t."analysisError" END,
                   "analysisStartedAt" = CASE WHEN p.analysis THEN NULL ELSE t."analysisStartedAt" END,
                   "vibeAnalysisStatus" = CASE WHEN p.embedding THEN 'permanently_failed' ELSE t."vibeAnalysisStatus" END,
                   "vibeAnalysisError" = CASE WHEN p.embedding THEN 'file missing' ELSE t."vibeAnalysisError" END,
                   "vibeAnalysisStatusUpdatedAt" = CASE WHEN p.embedding THEN now() ELSE t."vibeAnalysisStatusUpdatedAt" END
              FROM per_track p
             WHERE t.id = p."trackId" AND (p.analysis OR p.embedding)
            RETURNING t.id
        )
        SELECT (SELECT count(*) FROM closed)::int AS closed, (SELECT count(*) FROM mirrored)::int AS mirrored`;
    return row?.closed ?? 0;
}

/**
 * A record a bulk re-ask may reopen: not running now, not parked by a person,
 * and its file is present. `alias` names the TrackStage row in the caller's SQL.
 */
export function reopenable(alias: string): string {
    return `${alias}.status NOT IN ('working', 'blocked')
        AND ${alias}."failureClass" IS DISTINCT FROM 'FILE_MISSING'
        AND NOT EXISTS (SELECT 1 FROM "Track" gone
                         WHERE gone.id = ${alias}."trackId" AND gone."missingSince" IS NOT NULL)`;
}
