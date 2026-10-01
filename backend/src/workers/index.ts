import { Worker } from "bullmq";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    scanQueue,
    discoverQueue,
    importQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImportJob } from "./processors/importProcessor";
import { createWorkerConnection } from "./enrichmentQueues";
import { withTimeout } from "../utils/timeout";
import { spotifyImportService } from "../services/spotifyImport";
import {
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodBucketWorker,
    stopMoodBucketWorker,
} from "./moodBucketWorker";
import {
    startDiscoverWeeklyCron,
    stopDiscoverWeeklyCron,
} from "./discoverCron";
import {
    startDataCleanupCron,
    stopDataCleanupCron,
} from "./dataCleanup";
import {
    startLibrarySyncCron,
    stopLibrarySyncCron,
} from "./librarySyncCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { sweepFailedDownloads } from "../services/lidarrFailures";
import { queueCleaner } from "../jobs/queueCleaner";
import { enrichmentStateService } from "../services/enrichmentState";

// Track timeouts for cleanup
const timeouts: NodeJS.Timeout[] = [];

// BullMQ workers for scan and discover queues
const scanWorker = new Worker("library-scan-v2", processScan, {
    connection: createWorkerConnection(),
    concurrency: 1,
    lockDuration: 300000, // 5 minutes — scans can be slow
});

const discoverWorker = new Worker("discover-weekly-v2", processDiscoverWeekly, {
    connection: createWorkerConnection(),
    concurrency: 1,
    lockDuration: 120000,
});

const importWorker = new Worker(
    "playlist-import",
    async (job) => processImportJob(job),
    {
        connection: createWorkerConnection(),
        concurrency: 1,
        lockDuration: 600000, // 10 minutes -- imports with downloads can be slow
    }
);

// Start unified enrichment worker
// Handles: artist metadata, track mood tags, audio analysis queueing (Essentia)
startUnifiedEnrichmentWorker().catch((err) => {
    logger.error("Failed to start unified enrichment worker:", err);
});

// Start mood bucket worker
// Assigns newly analyzed tracks to mood buckets for fast mood mix generation
startMoodBucketWorker().catch((err) => {
    logger.error("Failed to start mood bucket worker:", err);
});

// Event handlers for scan worker
scanWorker.on("completed", (job, result) => {
    logger.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing}`
    );
});

scanWorker.on("failed", (job, err) => {
    logger.error(`Scan job ${job?.id} failed:`, err.message);
});

scanWorker.on("active", (job) => {
    logger.debug(` Scan job ${job.id} started`);
});

scanWorker.on("error", (err) => {
    logger.error("Scan worker error:", err.message);
});

// Event handlers for discover worker
discoverWorker.on("completed", (job, result) => {
    if (result.success) {
        logger.debug(
            `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs)`
        );
    } else {
        logger.debug(`Discover job ${job.id} failed: ${result.error}`);
    }
});

discoverWorker.on("failed", (job, err) => {
    logger.error(`Discover job ${job?.id} failed:`, err.message);
});

discoverWorker.on("active", (job) => {
    logger.debug(` Discover job ${job.id} started for user ${job.data.userId}`);
});

discoverWorker.on("error", (err) => {
    logger.error("Discover worker error:", err.message);
});

// Event handlers for import worker
importWorker.on("completed", (job) => {
    logger.info(`[ImportWorker] Job ${job.id} completed`);
});

importWorker.on("failed", async (job, err) => {
    logger.error(`[ImportWorker] Job ${job?.id} failed: ${err.message}`);
    if (job?.data?.importJobId) {
        try {
            await spotifyImportService.markJobFailed(job.data.importJobId, err.message);
        } catch (e: any) {
            logger.error(`[ImportWorker] Failed to mark job as failed: ${e.message}`);
        }
    }
});

importWorker.on("error", (err) => {
    logger.error("[ImportWorker] Worker error:", err.message);
});

logger.debug("BullMQ workers registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Sundays at 8 PM)
startDiscoverWeeklyCron();

// Start data cleanup cron scheduler (daily at 2 AM)
startDataCleanupCron();

// Start library auto-sync cron (every 6h, gated on the autoSync setting)
startLibrarySyncCron();

// Running guards to prevent pile-up when tasks take longer than their interval
let dataIntegrityRunning = false;
let reconciliationRunning = false;
let lidarrCleanupRunning = false;

// Self-rescheduling data integrity check (prevents pile-up on slow runs)
async function runDataIntegrityCycle() {
    if (dataIntegrityRunning) return;
    dataIntegrityRunning = true;
    try {
        await runDataIntegrityCheck();
    } catch (err) {
        logger.error("Data integrity check failed:", err);
    } finally {
        dataIntegrityRunning = false;
        timeouts.push(setTimeout(runDataIntegrityCycle, 24 * 60 * 60 * 1000));
    }
}

// First run 10 seconds after startup
timeouts.push(setTimeout(runDataIntegrityCycle, 10000));
logger.debug("Data integrity check scheduled (every 24 hours, self-rescheduling)");

// Matches active downloads against Lidarr and the library. Each cycle schedules
// the next when it finishes, and does nothing while no download is active.
async function runReconciliationCycle() {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
        const activeJobs = await prisma.downloadJob.count({
            where: { status: { in: ["pending", "processing"] } },
        });
        if (activeJobs === 0) return;

        const { lidarrService } = await import("../services/lidarr");
        const snapshot = await withTimeout(
            lidarrService.getReconciliationSnapshot(),
            30000,
            "getReconciliationSnapshot timed out"
        );

        const staleCount = await withTimeout(
            simpleDownloadManager.markStaleJobsAsFailed(snapshot),
            120000,
            "markStaleJobsAsFailed timed out"
        );
        if (staleCount && staleCount > 0) {
            logger.debug(
                `Periodic cleanup: marked ${staleCount} stale download(s) as failed`
            );
        }

        const lidarrResult = await withTimeout(
            simpleDownloadManager.reconcileWithLidarr(snapshot),
            120000,
            "reconcileWithLidarr timed out"
        );
        if (lidarrResult && lidarrResult.reconciled > 0) {
            logger.debug(
                `Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`
            );
        }

        const localResult = await withTimeout(
            queueCleaner.reconcileWithLocalLibrary(),
            120000,
            "reconcileWithLocalLibrary timed out"
        );
        if (localResult && localResult.reconciled > 0) {
            logger.debug(
                `Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`
            );
        }

        const syncResult = await withTimeout(
            simpleDownloadManager.syncWithLidarrQueue(snapshot),
            120000,
            "syncWithLidarrQueue timed out"
        );
        if (syncResult && syncResult.cancelled > 0) {
            logger.debug(
                `Periodic sync: ${syncResult.cancelled} job(s) synced with Lidarr queue`
            );
        }
    } catch (err) {
        logger.error(
            "Periodic download cleanup/reconciliation failed:",
            err
        );
    } finally {
        reconciliationRunning = false;
        // Schedule next run AFTER this one completes (prevents pile-up)
        timeouts.push(setTimeout(runReconciliationCycle, 2 * 60 * 1000));
    }
}

// First reconciliation run 2 minutes after startup
timeouts.push(setTimeout(runReconciliationCycle, 2 * 60 * 1000));
logger.debug("Stale download cleanup scheduled (every 2 minutes, self-rescheduling)");

// Self-rescheduling Lidarr queue cleanup (replaces setInterval to prevent pile-up)
async function runLidarrCleanupCycle() {
    if (lidarrCleanupRunning) return;
    lidarrCleanupRunning = true;
    try {
        const result = await withTimeout(
            sweepFailedDownloads(),
            180000,
            "sweepFailedDownloads timed out"
        );
        if (result && result.removed > 0) {
            logger.debug(
                `Periodic Lidarr cleanup: removed ${result.removed} stuck download(s)`
            );
        }
    } catch (err) {
        logger.error("Lidarr queue cleanup failed:", err);
    } finally {
        lidarrCleanupRunning = false;
        // Schedule next run AFTER this one completes (prevents pile-up)
        timeouts.push(setTimeout(runLidarrCleanupCycle, 5 * 60 * 1000));
    }
}

// First Lidarr cleanup 5 minutes after startup (initial cleanup at 30s is separate)
timeouts.push(setTimeout(runLidarrCleanupCycle, 5 * 60 * 1000));
logger.debug("Lidarr queue cleanup scheduled (every 5 minutes, self-rescheduling)");

// Run initial Lidarr cleanup 30 seconds after startup (to catch any stuck items)
timeouts.push(
    setTimeout(async () => {
        try {
            logger.debug("Running initial Lidarr queue cleanup...");
            const result = await sweepFailedDownloads();
            if (result.removed > 0) {
                logger.debug(
                    `Initial cleanup: removed ${result.removed} stuck download(s)`
                );
            } else {
                logger.debug("Initial cleanup: queue is clean");
            }
        } catch (err) {
            logger.error("Initial Lidarr cleanup failed:", err);
        }
    }, 30 * 1000) // 30 seconds after startup
);

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    logger.debug("Shutting down workers...");

    // Stop unified enrichment worker (async — closes BullMQ workers and queues)
    await stopUnifiedEnrichmentWorker();

    // Disconnect enrichment state service Redis connections (2 connections)
    try {
        await enrichmentStateService.disconnect();
        logger.debug("Enrichment state service disconnected");
    } catch (err) {
        logger.error("Failed to disconnect enrichment state service:", err);
    }

    // Stop mood bucket worker
    stopMoodBucketWorker();

    // Stop discover weekly cron
    stopDiscoverWeeklyCron();

    // Stop data cleanup cron
    stopDataCleanupCron();

    // Stop library auto-sync cron
    stopLibrarySyncCron();

    // Clear all timeouts
    for (const timeout of timeouts) {
        clearTimeout(timeout);
    }
    timeouts.length = 0;

    // Close workers first so in-flight jobs complete, then close queues
    await Promise.all([scanWorker.close(), discoverWorker.close(), importWorker.close()]);
    await Promise.all([scanQueue.close(), discoverQueue.close(), importQueue.close()]);

    logger.debug("Workers shutdown complete");
}

// Export queues for use in other modules
