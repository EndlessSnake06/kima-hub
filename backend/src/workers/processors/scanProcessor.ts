import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { MusicScannerService } from "../../services/musicScanner";
import { config } from "../../config";
import { eventBus } from "../../services/eventBus";
import { notificationService } from "../../services/notificationService";
import { stringSimilarity } from "../../utils/normalization";
import * as path from "path";

/**
 * After a scan, complete pending download jobs whose albums arrived without a
 * webhook, matching names fuzzily and in batched queries.
 */
async function reconcileDownloadJobsWithScan(): Promise<number> {
    const { prisma } = await import("../../utils/db");

    // Get all pending/processing download jobs
    const activeJobs = await prisma.downloadJob.findMany({
        where: { status: { in: ["pending", "processing"] } },
    });

    if (activeJobs.length === 0) {
        return 0;
    }

    // Extract job metadata for matching
    const jobsWithMetadata = activeJobs
        .map((job) => {
            const metadata = (job.metadata as any) || {};
            return {
                job,
                artistName: metadata?.artistName as string | undefined,
                albumTitle: metadata?.albumTitle as string | undefined,
            };
        })
        .filter((j) => j.artistName && j.albumTitle);

    if (jobsWithMetadata.length === 0) {
        return 0;
    }

    // Batch fetch: Get all albums that might match any of our jobs
    // Use OR conditions for all artist name prefixes (for fuzzy matching)
    const artistPrefixes = [...new Set(
        jobsWithMetadata.map((j) => j.artistName!.substring(0, 5).toLowerCase())
    )];

    const candidateAlbums = await prisma.album.findMany({
        where: {
            OR: artistPrefixes.map((prefix) => ({
                artist: {
                    name: {
                        contains: prefix,
                        mode: "insensitive" as const,
                    },
                },
            })),
        },
        include: {
            tracks: {
                select: { id: true },
                take: 1,
            },
            artist: {
                select: { name: true },
            },
        },
    });

    // Match jobs to albums
    const jobsToComplete: string[] = [];
    const discoveryBatchIds: string[] = [];

    for (const { job, artistName, albumTitle } of jobsWithMetadata) {
        // Try exact/contains match first
        let matchedAlbum = candidateAlbums.find(
            (album) =>
                album.tracks.length > 0 &&
                album.artist.name.toLowerCase().includes(artistName!.toLowerCase()) &&
                album.title.toLowerCase().includes(albumTitle!.toLowerCase())
        );

        // Fuzzy match if exact match failed
        if (!matchedAlbum) {
            matchedAlbum = candidateAlbums.find(
                (album) =>
                    album.tracks.length > 0 &&
                    stringSimilarity(artistName!, album.artist.name) >= 75 &&
                    stringSimilarity(albumTitle!, album.title) >= 75
            );
        }

        if (matchedAlbum) {
            jobsToComplete.push(job.id);
            if (job.discoveryBatchId) {
                discoveryBatchIds.push(job.discoveryBatchId);
            }
        }
    }

    if (jobsToComplete.length === 0) {
        return 0;
    }

    // Batch update: Mark all matched jobs as completed
    await prisma.downloadJob.updateMany({
        where: { id: { in: jobsToComplete } },
        data: {
            status: "completed",
            completedAt: new Date(),
            error: null,
        },
    });

    // Check batch completion for discovery jobs (deduplicated)
    const uniqueBatchIds = [...new Set(discoveryBatchIds)];
    if (uniqueBatchIds.length > 0) {
        const { discoverWeeklyService } = await import(
            "../../services/discoverWeekly"
        );
        for (const batchId of uniqueBatchIds) {
            await discoverWeeklyService.checkBatchCompletion(batchId);
        }
    }

    return jobsToComplete.length;
}

export interface ScanJobData {
    userId?: string; // Optional: scans can be triggered without a user
    musicPath?: string; // Optional: use custom path or default from config
    albumMbid?: string; // Optional: if scan triggered by download completion
    artistMbid?: string; // Optional: if scan triggered by download completion
    source?: string; // Optional: source of scan (e.g., "lidarr-webhook", "discover-weekly-completion", "spotify-import")
    downloadId?: string; // Optional: Lidarr download ID for precise job linking
    discoveryBatchId?: string; // Optional: Discovery Weekly batch ID
    spotifyImportJobId?: string; // Optional: Spotify Import job ID
}

export interface ScanJobResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksMissing: number;
    tracksCorrupt: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

const SCAN_RESULT_KEY = "library-scan";

function scanSummary(r: { tracksAdded: number; tracksUpdated: number; tracksMissing: number; tracksCorrupt: number }): string {
    const parts = [
        r.tracksAdded > 0 && `${r.tracksAdded} added`,
        r.tracksUpdated > 0 && `${r.tracksUpdated} updated`,
        r.tracksMissing > 0 && `${r.tracksMissing} missing`,
        r.tracksCorrupt > 0 && `${r.tracksCorrupt} corrupt`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "No changes";
}

export async function processScan(
    job: Job<ScanJobData>
): Promise<ScanJobResult> {
    const {
        userId,
        musicPath,
        albumMbid,
        artistMbid,
        source,
        downloadId,
        discoveryBatchId,
        spotifyImportJobId,
    } = job.data;
    const manual = source === "manual-scan";

    logger.debug(`\n═══════════════════════════════════════════════`);
    logger.debug(`[ScanJob ${job.id}] Starting library scan for user ${userId}`);
    if (source) {
        logger.debug(`[ScanJob ${job.id}] Scan source: ${source}`);
    }
    if (albumMbid) {
        logger.debug(`[ScanJob ${job.id}] Album MBID: ${albumMbid}`);
    }
    if (artistMbid) {
        logger.debug(`[ScanJob ${job.id}] Artist MBID: ${artistMbid}`);
    }
    logger.debug(`═══════════════════════════════════════════════`);

    // Report progress
    await job.updateProgress(0);

    // Prepare cover cache path (store alongside transcode cache)
    const coverCachePath = path.join(
        config.music.transcodeCachePath,
        "../covers"
    );

    // Create scanner with progress callback and cover cache path
    let lastEmittedPercent = -1;
    const scanner = new MusicScannerService((progress) => {
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100
        );
        job.updateProgress(percent).catch((err) =>
            logger.error(`Failed to update job progress:`, err)
        );
        // Emit SSE every 1% for smooth progress
        if (userId && percent >= lastEmittedPercent + 1) {
            lastEmittedPercent = percent;
            eventBus.emit({
                type: "scan:progress",
                userId,
                payload: { jobId: String(job.id), progress: percent },
            });
        }
    }, coverCachePath);

    // Use provided music path or fall back to config
    const scanPath = musicPath || config.music.musicPath;

    logger.debug(`[ScanJob ${job.id}] Scanning path: ${scanPath}`);

    try {
        const result = await scanner.scanLibrary(scanPath);

        await job.updateProgress(100);

        if (userId) {
            eventBus.emit({
                type: "scan:complete",
                userId,
                payload: {
                    jobId: String(job.id),
                    result: { tracksAdded: result.tracksAdded, tracksUpdated: result.tracksUpdated, tracksMissing: result.tracksMissing, tracksCorrupt: result.tracksCorrupt },
                },
            });
            if (manual) {
                await notificationService
                    .create({
                        userId,
                        type: "system",
                        title: "Library scan finished",
                        message: scanSummary(result),
                        groupKey: SCAN_RESULT_KEY,
                        renotify: true,
                    })
                    .catch((e) => logger.error(`[ScanJob ${job.id}] Failed to record scan result:`, e));
            }
        }

        logger.debug(
              `[ScanJob ${job.id}] Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} corrupt:${result.tracksCorrupt}`
          );

        // If this scan was triggered by a download completion, mark download jobs as completed
        if (
            source?.startsWith("lidarr-") &&
            (albumMbid || artistMbid || downloadId)
        ) {
            logger.debug(
                `[ScanJob ${job.id}] Marking download jobs as completed after successful scan`
            );
            const { prisma } = await import("../../utils/db");

            if (artistMbid) {
                // No type filter: nothing creates `type: "artist"` rows, so
                // filtering on it made this sweep a no-op. An artist download
                // is fanned out into album rows, and those are what a scan for
                // that artist should settle.
                await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: artistMbid,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                logger.debug(
                    `[ScanJob ${job.id}] Marked artist download as completed: ${artistMbid}`
                );

                // Trigger enrichment for the newly imported artist
                try {
                    const artist = await prisma.artist.findUnique({
                        where: { mbid: artistMbid },
                    });
                    if (artist && artist.enrichmentStatus === "pending") {
                        logger.debug(
                            `[ScanJob ${job.id}] Queueing enrichment for artist: ${artist.name}`
                        );
                        // Route through the enrichment queue (jobId-deduped) instead of firing
                        // directly -- avoids racing executeArtistsPhase() over the same artist
                        const { artistQueue } = await import(
                            "../enrichmentQueues"
                        );
                        const jobId = `artist-${artist.id}`;
                        if (!(await artistQueue.getJob(jobId))) {
                            await artistQueue.add(
                                "enrich",
                                { artistId: artist.id, artistName: artist.name },
                                { jobId }
                            );
                            await prisma.artist.update({
                                where: { id: artist.id },
                                data: { enrichmentStatus: "enriching" },
                            });
                        }
                    }
                } catch (error) {
                    logger.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (albumMbid) {
                const updatedByMbid = await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: albumMbid,
                        type: "album",
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });

                if (updatedByMbid.count > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] Marked ${updatedByMbid.count} album download(s) as completed by MBID: ${albumMbid}`
                    );
                } else {
                    // Fallback: Try to find the album by artist+title and match download jobs
                    logger.debug(
                        `[ScanJob ${job.id}] No downloads matched by MBID, trying artist+title match...`
                    );

                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });

                    if (album) {
                        const updatedByName =
                            await prisma.downloadJob.updateMany({
                                where: {
                                    type: "album",
                                    status: { in: ["pending", "processing"] },
                                    metadata: {
                                        path: ["albumTitle"],
                                        equals: album.title,
                                    },
                                },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                },
                            });

                        if (updatedByName.count > 0) {
                            logger.debug(
                                `[ScanJob ${job.id}] Marked ${updatedByName.count} album download(s) as completed by title match: ${album.artist.name} - ${album.title}`
                            );
                        } else {
                            logger.debug(
                                `[ScanJob ${job.id}]   No pending downloads found for: ${album.artist.name} - ${album.title}`
                            );
                        }
                    }
                }

                // Trigger enrichment for the artist of the newly imported album
                try {
                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });
                    if (
                        album?.artist &&
                        album.artist.enrichmentStatus === "pending"
                    ) {
                        logger.debug(
                            `[ScanJob ${job.id}] Queueing enrichment for artist: ${album.artist.name}`
                        );
                        // Route through the enrichment queue (jobId-deduped) instead of firing
                        // directly -- avoids racing executeArtistsPhase() over the same artist
                        const { artistQueue } = await import(
                            "../enrichmentQueues"
                        );
                        const jobId = `artist-${album.artist.id}`;
                        if (!(await artistQueue.getJob(jobId))) {
                            await artistQueue.add(
                                "enrich",
                                { artistId: album.artist.id, artistName: album.artist.name },
                                { jobId }
                            );
                            await prisma.artist.update({
                                where: { id: album.artist.id },
                                data: { enrichmentStatus: "enriching" },
                            });
                        }
                    }
                } catch (error) {
                    logger.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (downloadId) {
                const updated = await prisma.downloadJob.updateMany({
                    where: {
                        lidarrRef: downloadId,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                if (updated.count > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] Linked Lidarr download ${downloadId} to ${updated.count} job(s)`
                    );
                } else {
                    logger.debug(
                        `[ScanJob ${job.id}]   No download jobs found for Lidarr ID ${downloadId}`
                    );
                }
            }
        }

        // If this scan was for Discovery Weekly, build the final playlist
        if (source === "discover-weekly-completion" && discoveryBatchId) {
            logger.debug(
                `[ScanJob ${job.id}]  Building Discovery Weekly playlist for batch ${discoveryBatchId}...`
            );
            try {
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                await discoverWeeklyService.buildFinalPlaylist(
                    discoveryBatchId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Discovery Weekly playlist complete!`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}]  Failed to build Discovery playlist:`,
                    error.message
                );
            }
        }

        // If this scan was for Spotify Import, build the final playlist
        if (source === "spotify-import" && spotifyImportJobId) {
            logger.debug(
                `[ScanJob ${job.id}]  Building Spotify Import playlist for job ${spotifyImportJobId}...`
            );
            try {
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                await spotifyImportService.buildPlaylistAfterScan(
                    spotifyImportJobId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Spotify Import playlist complete!`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}]  Failed to build Spotify Import playlist:`,
                    error.message
                );
            }
        }

        // Complete download jobs whose albums this scan found.
        if (result.tracksAdded > 0) {
            logger.debug(
                `[ScanJob ${job.id}] Reconciling download jobs with ${result.tracksAdded} newly scanned tracks...`
            );
            try {
                const reconciledJobs = await reconcileDownloadJobsWithScan();
                if (reconciledJobs > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] ✓ Reconciled ${reconciledJobs} download job(s) with scanned albums`
                    );
                }
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to reconcile download jobs:`,
                    error.message
                );
            }
        }

        // Reconcile Spotify-import pending tracks against new or updated tracks, manual syncs and retried downloads.
        const shouldReconcile =
            result.tracksAdded > 0 ||
            result.tracksUpdated > 0 ||
            manual ||
            source?.startsWith("retry-");
        if (shouldReconcile) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] Checking for pending playlist tracks to reconcile...`
                );
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                const reconcileResult =
                    await spotifyImportService.reconcilePendingTracks();
                if (reconcileResult.tracksAdded > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] ✓ Reconciled ${reconcileResult.tracksAdded} pending tracks to ${reconcileResult.playlistsUpdated} playlists`
                    );
                } else {
                    logger.debug(
                        `[ScanJob ${job.id}] No pending tracks to reconcile`
                    );
                }
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to reconcile pending tracks:`,
                    error
                );
            }
        }

        // Reconcile Discovery Weekly tracks
        // This backfills Discovery Weekly playlists with albums that downloaded after initial playlist creation
        // Run on: new tracks added OR manual sync
        if (shouldReconcile) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] Checking for Discovery Weekly tracks to reconcile...`
                );
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                const discoverResult = await discoverWeeklyService.reconcileDiscoveryTracks();
                if (discoverResult.tracksAdded > 0) {
                    logger.info(
                        `[SCAN] Discovery Weekly reconciliation: ${discoverResult.tracksAdded} tracks added across ${discoverResult.batchesChecked} batches`
                    );
                }
            } catch (error) {
                logger.error('[SCAN] Discovery Weekly reconciliation failed:', error);
            }
        }

        // New files are owed every stage's answer; trigger the next cycle now rather
        // than after the 30 s wait.
        if (result.tracksAdded > 0) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] ${result.tracksAdded} new track(s) added — starting an enrichment cycle`
                );
                const { triggerEnrichmentNow } = await import(
                    "../unifiedEnrichment"
                );
                triggerEnrichmentNow()
                    .then((result) => {
                        if (result.tracks > 0) {
                            logger.debug(
                                `[ScanJob ${job.id}] Enrichment after scan completed: ${result.tracks} tracks`
                            );
                        }
                    })
                    .catch((err) => {
                        logger.error(
                            `[ScanJob ${job.id}] Enrichment for new tracks failed:`,
                            err
                        );
                    });
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to trigger enrichment:`,
                    error
                );
            }
        }

        return result;
    } catch (error: any) {
        logger.error(`[ScanJob ${job.id}] Scan failed:`, error);
        if (userId) {
            eventBus.emit({
                type: "scan:complete",
                userId,
                payload: { jobId: String(job.id), error: error.message || "Scan failed" },
            });
            if (manual) {
                await notificationService
                    .create({
                        userId,
                        type: "error",
                        title: "Library scan failed",
                        message: error.message || undefined,
                        groupKey: SCAN_RESULT_KEY,
                        renotify: true,
                    })
                    .catch((e) => logger.error(`[ScanJob ${job.id}] Failed to record scan failure:`, e));
            }
        }
        throw error;
    }
}
