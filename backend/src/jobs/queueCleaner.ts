import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { requestScan } from "../workers/scanRequest";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { artistIdentityKey } from "../services/artistIdentity";
import { editionlessKey } from "../services/albumIdentity";

class QueueCleanerService {
    private isRunning = false;
    private checkInterval = 30000; // 30 seconds when active
    private emptyQueueChecks = 0;
    private maxEmptyChecks = 3; // Stop after 3 consecutive empty checks
    private timeoutId?: NodeJS.Timeout;

    // Cached dynamic imports (lazy-loaded once, reused on subsequent calls)
    private discoverWeeklyService: typeof import("../services/discoverWeekly")["discoverWeeklyService"] | null = null;
    private spotifyImportService: typeof import("../services/spotifyImport")["spotifyImportService"] | null = null;

    /**
     * Get discoverWeeklyService (lazy-loaded and cached)
     */
    private async getDiscoverWeeklyService() {
        if (!this.discoverWeeklyService) {
            const module = await import("../services/discoverWeekly");
            this.discoverWeeklyService = module.discoverWeeklyService;
        }
        return this.discoverWeeklyService;
    }

    /**
     * Get spotifyImportService (lazy-loaded and cached)
     */
    private async getSpotifyImportService() {
        if (!this.spotifyImportService) {
            const module = await import("../services/spotifyImport");
            this.spotifyImportService = module.spotifyImportService;
        }
        return this.spotifyImportService;
    }

    /**
     * Start the polling loop
     * Safe to call multiple times - won't create duplicate loops
     */
    async start() {
        if (this.isRunning) {
            logger.debug(" Queue cleaner already running");
            return;
        }

        this.isRunning = true;
        this.emptyQueueChecks = 0;
        logger.debug(" Queue cleaner started (checking every 30s)");

        await this.runCleanup();
    }

    /**
     * Stop the polling loop
     */
    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.isRunning = false;
        logger.debug(" Queue cleaner stopped (queue empty)");
    }

    /**
     * Main cleanup logic - runs every 30 seconds when active
     */
    private async runCleanup() {
        if (!this.isRunning) return;

        try {
            // Use getSystemSettings() to get decrypted API key
            const settings = await getSystemSettings();

            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) {
                logger.debug(" Lidarr not configured, stopping queue cleaner");
                this.stop();
                return;
            }

            // Discover batches past their deadline
            const discoverWeeklyService = await this.getDiscoverWeeklyService();
            const stuckBatchCount =
                await discoverWeeklyService.checkStuckBatches();
            if (stuckBatchCount > 0) {
                logger.debug(
                    `⏰ Force-completed ${stuckBatchCount} stuck discovery batch(es)`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // Spotify imports stuck scanning or downloading
            const stuckImportCount = await this.checkStuckSpotifyImports();
            if (stuckImportCount > 0) {
                logger.debug(
                    `Recovered ${stuckImportCount} stuck Spotify import job(s)`
                );
                this.emptyQueueChecks = 0;
            }

            // Stop once nothing is queued
            const activeJobs = await prisma.downloadJob.count({
                where: {
                    status: { in: ["pending", "processing"] },
                },
            });

            const hadActivity = activeJobs > 0;

            if (!hadActivity) {
                this.emptyQueueChecks++;
                logger.debug(
                    ` Queue empty (${this.emptyQueueChecks}/${this.maxEmptyChecks})`
                );

                if (this.emptyQueueChecks >= this.maxEmptyChecks) {
                    logger.debug(
                        ` No activity for ${this.maxEmptyChecks} checks - stopping cleaner`
                    );
                    this.stop();
                    return;
                }
            } else {
                this.emptyQueueChecks = 0;
            }

            // Schedule next check
            this.timeoutId = setTimeout(
                () => this.runCleanup(),
                this.checkInterval
            );
        } catch (error) {
            logger.error(" Queue cleanup error:", error);
            // Still schedule next check even on error
            this.timeoutId = setTimeout(
                () => this.runCleanup(),
                this.checkInterval
            );
        }
    }

    /**
     * Check for Spotify import jobs stuck in "scanning" or "downloading" status.
     * Re-triggers scan for jobs stuck scanning, or forces completion check
     * for jobs stuck downloading.
     */
    async checkStuckSpotifyImports(): Promise<number> {
        const SCANNING_RETRY_TIMEOUT = 10 * 60 * 1000; // 10 minutes - retry scan
        const SCANNING_FAIL_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force fail
        const DOWNLOADING_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force completion check

        const stuckJobs = await prisma.spotifyImportJob.findMany({
            where: {
                status: { in: ["scanning", "downloading"] },
            },
        });

        if (stuckJobs.length === 0) return 0;

        let recoveredCount = 0;

        for (const job of stuckJobs) {
            const jobAge = Date.now() - job.updatedAt.getTime();

            if (job.status === "scanning") {
                if (jobAge > SCANNING_FAIL_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - force failing`
                    );

                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: "Scan timed out after 30 minutes",
                        },
                    });
                    recoveredCount++;
                } else if (jobAge > SCANNING_RETRY_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - re-queuing scan`
                    );

                    const result = await requestScan({
                        userId: job.userId,
                        source: "spotify-import",
                        spotifyImportJobId: job.id,
                    });
                    if (!result.queued) {
                        logger.debug(`    Scan skipped: ${result.reason}`);
                    }

                    // Touch updatedAt to prevent re-queuing every 30s
                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: { progress: job.progress },
                    });
                    recoveredCount++;
                }
            } else if (job.status === "downloading" && jobAge > DOWNLOADING_TIMEOUT) {
                logger.debug(
                    `[IMPORT STUCK] Job ${job.id} stuck in downloading for ${Math.round(jobAge / 60000)}min - forcing completion check`
                );

                try {
                    const spotifyImportService = await this.getSpotifyImportService();
                    await spotifyImportService.checkImportCompletion(job.id);
                    recoveredCount++;
                } catch (err: any) {
                    logger.debug(
                        `[IMPORT STUCK] Failed to force completion check for ${job.id}: ${err.message}`
                    );
                }
            }
        }

        return recoveredCount;
    }

    /**
     * Complete jobs Lidarr is not fetching whose album the library already
     * holds: the same album id, or the same artist and title once edition
     * words are set aside (owning another edition counts). Covers albums that
     * arrived some other way, and requests for an album already owned.
     */
    async reconcileWithLocalLibrary(): Promise<{ reconciled: number }> {
        // A job Lidarr is fetching is settled by what Lidarr says about its album.
        const wanted = (
            await prisma.downloadJob.findMany({
                where: { status: { in: ["pending", "processing"] }, lidarrAlbumId: null },
            })
        ).filter((job) => {
            const meta = (job.metadata as any) ?? {};
            return job.targetMbid || (meta.artistName && meta.albumTitle);
        });
        if (wanted.length === 0) return { reconciled: 0 };

        const names = [...new Set(wanted.map((job) => (job.metadata as any)?.artistName).filter(Boolean))] as string[];
        const localAlbums = await prisma.album.findMany({
            where: {
                tracks: { some: {} },
                OR: [
                    { rgMbid: { in: wanted.map((job) => job.targetMbid).filter((m): m is string => !!m) } },
                    { artist: { name: { in: names, mode: "insensitive" } } },
                ],
            },
            select: { rgMbid: true, title: true, artist: { select: { name: true } } },
        });
        const mbids = new Set(localAlbums.map((a) => a.rgMbid));
        const owned = new Set(localAlbums.map((a) => `${artistIdentityKey(a.artist.name)}|${editionlessKey(a.title)}`));

        const found = wanted.filter((job) => {
            const meta = (job.metadata as any) ?? {};
            return (
                (!!job.targetMbid && mbids.has(job.targetMbid)) ||
                (!!meta.artistName && !!meta.albumTitle && owned.has(`${artistIdentityKey(meta.artistName)}|${editionlessKey(meta.albumTitle)}`))
            );
        });
        const reconciled = await simpleDownloadManager.completeJobs(found);
        if (reconciled > 0) {
            logger.debug(`[LOCAL-RECONCILE] ${reconciled} job(s) found in the library`);
        }
        return { reconciled };
    }

    /**
     * Get current status (for debugging/monitoring)
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            emptyQueueChecks: this.emptyQueueChecks,
            nextCheckIn: this.isRunning
                ? `${this.checkInterval / 1000}s`
                : "stopped",
        };
    }
}

// Export singleton instance
export const queueCleaner = new QueueCleanerService();
