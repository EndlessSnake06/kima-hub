import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { sweepFailedDownloads } from "../services/lidarrFailures";
import { requestScan } from "../workers/scanRequest";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { yieldToEventLoop } from "../utils/async";
import { stringSimilarity } from "../utils/normalization";

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

            // PART 0: Check for stale downloads (timed out)
            const staleCount =
                await simpleDownloadManager.markStaleJobsAsFailed();
            if (staleCount > 0) {
                logger.debug(`⏰ Cleaned up ${staleCount} stale download(s)`);
                this.emptyQueueChecks = 0; // Reset counter
            }

            // Complete jobs whose album is already in the library, for missed Lidarr webhooks.
            const localReconcileResult = await this.reconcileWithLocalLibrary();
            if (localReconcileResult.reconciled > 0) {
                logger.debug(
                    `✓ Reconciled ${localReconcileResult.reconciled} job(s) with local library`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.5: Check for stuck discovery batches (batch-level timeout)
            const discoverWeeklyService = await this.getDiscoverWeeklyService();
            const stuckBatchCount =
                await discoverWeeklyService.checkStuckBatches();
            if (stuckBatchCount > 0) {
                logger.debug(
                    `⏰ Force-completed ${stuckBatchCount} stuck discovery batch(es)`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.6: Check for stuck Spotify import jobs (scanning timeout)
            const stuckImportCount = await this.checkStuckSpotifyImports();
            if (stuckImportCount > 0) {
                logger.debug(
                    `Recovered ${stuckImportCount} stuck Spotify import job(s)`
                );
                this.emptyQueueChecks = 0;
            }

            const swept = await sweepFailedDownloads();
            if (swept.removed > 0) {
                logger.debug(`[CLEANUP] Removed ${swept.removed} failed download(s)`);
                this.emptyQueueChecks = 0;
            }

            // Stop once nothing is queued or swept
            const activeJobs = await prisma.downloadJob.count({
                where: {
                    status: { in: ["pending", "processing"] },
                },
            });

            const hadActivity = swept.removed > 0 || activeJobs > 0;

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
     * Mark pending and processing jobs complete when their album is already in
     * the library, matching names fuzzily: covers missed Lidarr webhooks and
     * MBID or name mismatches. Loads the library once. Also run by workers/index.ts.
     */
    async reconcileWithLocalLibrary(): Promise<{ reconciled: number }> {
        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        if (processingJobs.length === 0) {
            return { reconciled: 0 };
        }

        logger.debug(
            `[LOCAL-RECONCILE] Checking ${processingJobs.length} job(s) against local library...`
        );

        // Extract jobs with valid artist/album metadata
        const jobsToCheck = processingJobs
            .map((job) => {
                const metadata = (job.metadata as any) || {};
                return {
                    job,
                    artistName: metadata?.artistName as string | undefined,
                    albumTitle: metadata?.albumTitle as string | undefined,
                };
            })
            .filter((x) => x.artistName && x.albumTitle);

        if (jobsToCheck.length === 0) {
            return { reconciled: 0 };
        }

        // Fetch ALL local albums with tracks in ONE query
        const localAlbums = await prisma.album.findMany({
            where: {
                tracks: { some: {} }, // Only albums with at least one track
            },
            select: {
                id: true,
                title: true,
                artist: { select: { name: true } },
            },
        });

        logger.debug(
            `[LOCAL-RECONCILE] Loaded ${localAlbums.length} local albums for matching`
        );

        // Build normalized lookup index for O(1) exact matching
        const exactIndex = new Map<string, boolean>();
        for (const album of localAlbums) {
            const key = `${album.artist.name.toLowerCase().trim()}|${album.title.toLowerCase().trim()}`;
            exactIndex.set(key, true);
        }

        // Check all jobs against index
        const toComplete: string[] = [];
        const discoveryBatchIds = new Set<string>();

        for (const { job, artistName, albumTitle } of jobsToCheck) {
            const normalizedArtist = artistName!.toLowerCase().trim();
            const normalizedAlbum = albumTitle!.toLowerCase().trim();
            const exactKey = `${normalizedArtist}|${normalizedAlbum}`;

            let matched = false;

            // Strategy 1: Exact match (O(1))
            if (exactIndex.has(exactKey)) {
                matched = true;
                logger.debug(
                    `[LOCAL-RECONCILE] ✓ Exact match for "${artistName} - ${albumTitle}"`
                );
            }

            // Strategy 2: Contains match (check if album title contains or is contained)
            if (!matched) {
                for (const album of localAlbums) {
                    const libArtist = album.artist.name.toLowerCase().trim();
                    const libAlbum = album.title.toLowerCase().trim();

                    if (
                        libArtist.includes(normalizedArtist) ||
                        normalizedArtist.includes(libArtist)
                    ) {
                        if (
                            libAlbum.includes(normalizedAlbum) ||
                            normalizedAlbum.includes(libAlbum)
                        ) {
                            matched = true;
                            logger.debug(
                                `[LOCAL-RECONCILE] ✓ Contains match "${artistName} - ${albumTitle}" -> "${album.artist.name} - ${album.title}"`
                            );
                            break;
                        }
                    }
                }
            }

            // Strategy 3: Fuzzy match (more expensive, last resort)
            if (!matched) {
                const fuzzyMatch = localAlbums.find(
                    (album) =>
                        stringSimilarity(artistName!, album.artist.name) >= 75 &&
                        stringSimilarity(albumTitle!, album.title) >= 75
                );

                if (fuzzyMatch) {
                    matched = true;
                    logger.debug(
                        `[LOCAL-RECONCILE] ✓ Fuzzy match "${artistName} - ${albumTitle}" -> "${fuzzyMatch.artist.name} - ${fuzzyMatch.title}"`
                    );
                }
            }

            if (matched) {
                toComplete.push(job.id);
                if (job.discoveryBatchId) {
                    discoveryBatchIds.add(job.discoveryBatchId);
                }
            }
        }

        // Batch update all matched jobs
        if (toComplete.length > 0) {
            await prisma.downloadJob.updateMany({
                where: { id: { in: toComplete } },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    error: null,
                },
            });
            logger.debug(
                `[LOCAL-RECONCILE] Batch updated ${toComplete.length} job(s) to completed`
            );
        }

        // Check discovery batch completions (deduplicated, with yielding)
        if (discoveryBatchIds.size > 0) {
            const discoverWeeklyService = await this.getDiscoverWeeklyService();
            for (const batchId of discoveryBatchIds) {
                await discoverWeeklyService.checkBatchCompletion(batchId);
                await yieldToEventLoop();
            }
        }

        return { reconciled: toComplete.length };
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
