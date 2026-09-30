/**
 * On startup, repairs download jobs left `processing` by a crash. Running jobs
 * are reconciled against Lidarr by workers/index.ts's runReconciliationCycle.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/** A `processing` row this much past its start is a corpse from a previous
 *  process, not a genuinely slow download (Lidarr pulls finish well inside
 *  this window; anything later gets failed by the Lidarr-snapshot
 *  reconciliation instead). */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export async function reconcileStaleDownloadJobs(): Promise<{
    failed: number;
}> {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    const result = await prisma.downloadJob.updateMany({
        where: {
            status: "processing",
            startedAt: { lt: staleThreshold },
        },
        data: {
            status: "failed",
            error: "Server restart - download was processing but never completed",
        },
    });

    logger.debug(
        `[DOWNLOAD] Marked ${result.count} stale processing rows as failed`
    );

    return { failed: result.count };
}
