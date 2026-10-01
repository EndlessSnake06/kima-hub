/**
 * Simple Download Manager
 *
 * Stateless download service that uses the database as the single source of truth.
 * Handles album downloads with automatic retry, blocklisting, and completion tracking.
 * No in-memory state - survives server restarts.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { Prisma, PrismaClient } from "@prisma/client";
import { lidarrService, AcquisitionError, AcquisitionErrorType, ReconciliationSnapshot } from "./lidarr";
import { yieldToEventLoop } from "../utils/async";
import { musicBrainzService } from "./musicbrainz";
import { getSystemSettings } from "../utils/systemSettings";
import { notificationService } from "./notificationService";
import { notificationPolicyService } from "./notificationPolicyService";
import { sessionLog } from "../utils/playlistLogger";
import { config } from "../config";
import { eventBus } from "./eventBus";
import * as crypto from "crypto";
import { activeDownloads } from "../utils/metrics";
import { sourcePauseController } from "./sourcePauseController";
import { isRateLimited } from "./enrichmentErrorCodeClassifier";
import { failureCause } from "../utils/outcome";
import { removeFailedDownload } from "./lidarrFailures";
import { distributedLock } from "../utils/distributedLock";
import type { LidarrAlbum } from "../types/lidarr";

const LIDARR_RETRY_DELAYS_MS = [5_000, 20_000];

type TransactionClient = Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

function generateCorrelationId(): string {
    return crypto.randomUUID();
}

class SimpleDownloadManager {
    private readonly DEFAULT_MAX_ATTEMPTS = 3;
    private readonly IMPORT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes for imports
    private readonly PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for pending
    private readonly NO_SOURCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for no sources found

    /**
     * Update active downloads metric from database state
     */
    private async updateActiveDownloadsMetric(): Promise<void> {
        try {
            const [lidarrCount, soulseekCount] = await Promise.all([
                prisma.downloadJob.count({
                    where: {
                        status: 'processing',
                        metadata: { path: ['currentSource'], equals: 'lidarr' },
                    },
                }),
                prisma.downloadJob.count({
                    where: {
                        status: 'processing',
                        metadata: { path: ['currentSource'], equals: 'soulseek' },
                    },
                }),
            ]);

            activeDownloads.set({ source: 'lidarr' }, lidarrCount);
            activeDownloads.set({ source: 'soulseek' }, soulseekCount);
        } catch (error) {
            logger.error('Failed to update active downloads metric:', error);
        }
    }

    private async maxAttempts(userId: string): Promise<number> {
        const config = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
            select: { maxRetryAttempts: true },
        });
        return config?.maxRetryAttempts ?? this.DEFAULT_MAX_ATTEMPTS;
    }

    /**
     * Transaction wrapper with retry logic for serialization conflicts
     */
    private async withTransaction<T>(
        operation: (tx: TransactionClient) => Promise<T>,
        options?: { maxRetries?: number; logPrefix?: string }
    ): Promise<T> {
        const maxRetries = options?.maxRetries ?? 3;
        const logPrefix = options?.logPrefix ?? "[TX]";
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await prisma.$transaction(operation, {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    maxWait: 5000,
                    timeout: 10000,
                });
            } catch (error: any) {
                const isSerializationError =
                    error.code === "P2034" ||
                    error.message?.includes("could not serialize") ||
                    error.message?.includes("deadlock");

                if (isSerializationError && attempt < maxRetries) {
                    lastError = error;
                    const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
                    logger.debug(
                        `${logPrefix} Serialization conflict, retry ${attempt}/${maxRetries} after ${delay}ms`
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
                throw error;
            }
        }

        throw lastError;
    }

    /**
     * Start a new download
     * Returns the correlation ID for webhook matching
     * @param isDiscovery - If true, tags the artist in Lidarr for discovery cleanup
     */
    async startDownload(
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        userId: string,
        isDiscovery: boolean = false
    ): Promise<{ success: boolean; correlationId?: string; error?: string; errorType?: AcquisitionErrorType; isRecoverable?: boolean }> {
        logger.debug(
            `\n Starting download: ${artistName} - ${albumTitle}${
                isDiscovery ? " (discovery)" : ""
            }`
        );
        logger.debug(`   Job ID: ${jobId}`);
        logger.debug(`   Album MBID: ${albumMbid}`);

        const correlationId = generateCorrelationId();

        try {
            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath || config.music.musicPath;

            let artistMbid: string | undefined;
            logger.debug(`   Fetching artist MBID from MusicBrainz...`);
            const rgOutcome = await musicBrainzService.getReleaseGroup(
                albumMbid
            );
            if (rgOutcome.kind === "answered") {
                const credit = rgOutcome.value?.["artist-credit"]?.[0]?.artist?.id;
                if (credit) {
                    artistMbid = credit;
                    logger.debug(`   Found artist MBID: ${artistMbid}`);
                    await prisma.downloadJob.updateMany({
                        where: { id: jobId, artistMbid: null },
                        data: { artistMbid },
                    });
                } else {
                    logger.warn(
                        `   Could not extract artist MBID from release group`
                    );
                }
            } else if (rgOutcome.kind === "absent") {
                logger.warn(
                    `   Release group ${albumMbid} is not on MusicBrainz`
                );
            } else {
                logger.error(
                    `   Artist-MBID lookup ${rgOutcome.kind}: ${failureCause(rgOutcome)}`
                );
            }

            const result = await this.addAlbumToLidarr(
                albumMbid,
                artistName,
                albumTitle,
                musicPath,
                artistMbid,
                isDiscovery
            );

            logger.debug(`   Album queued in Lidarr (ID: ${result.id})`);

            // Lidarr may have matched by name and returned a different MBID
            const actualLidarrMbid = result.foreignAlbumId;
            if (actualLidarrMbid && actualLidarrMbid !== albumMbid) {
                logger.debug(
                    `   MBID mismatch - original: ${albumMbid}, Lidarr: ${actualLidarrMbid}`
                );
            }

            // Keep existing metadata: Discover jobs carry their tier and similarity in it.
            const now = new Date();
            const existingJob = await prisma.downloadJob.findUnique({
                where: { id: jobId },
                select: { metadata: true },
            });
            const existingMetadata = (existingJob?.metadata as any) || {};

            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId, // Unique ID for webhook matching
                    status: "processing",
                    startedAt: now, // For timeout tracking (if field exists)
                    lidarrAlbumId: result.id, // Store Lidarr album ID for retry/cleanup
                    artistMbid: artistMbid, // Store artist MBID for same-artist fallback
                    attempts: 1,
                    metadata: {
                        ...existingMetadata, // Preserve tier, similarity, etc.
                        albumTitle,
                        artistName,
                        artistMbid,
                        albumMbid, // Original requested MBID
                        lidarrMbid: actualLidarrMbid, // Actual Lidarr MBID (may differ)
                        downloadType:
                            existingMetadata.downloadType || "library",
                        startedAt: now.toISOString(), // Backup in metadata for timeout tracking
                        currentSource: "lidarr" as const,
                        statusText: "Lidarr #1",
                    },
                },
            });

            logger.debug(
                `   Download started with correlation ID: ${correlationId}`
            );

            this.updateActiveDownloadsMetric().catch(() => {});

            return { success: true, correlationId };
        } catch (error: any) {
            const errorType = error instanceof AcquisitionError ? error.type : undefined;
            const isRecoverable = error instanceof AcquisitionError ? error.isRecoverable : undefined;

            const job = await prisma.downloadJob.findUnique({
                where: { id: jobId },
            });
            const existingMetadata = (job?.metadata as any) || {};

            if (job && errorType === AcquisitionErrorType.ALREADY_OWNED) {
                await this.completeAlreadyOwned(job, error.message);
                return { success: true };
            }

            if (job && errorType === AcquisitionErrorType.LIDARR_UNAVAILABLE) {
                await this.holdForLidarr(job, artistName, albumTitle, error.message);
                return { success: true };
            }

            logger.error(`   Failed to start download:`, error.message);

            if (errorType === AcquisitionErrorType.NO_RELEASES_AVAILABLE) {
                logger.debug(`   No sources found - handling immediate failure`);

                if (job?.discoveryBatchId) {
                    logger.debug(
                        `   Discovery job - skipping same-artist fallback (diversity enforced)`
                    );
                } else if (job && !job.discoveryBatchId) {
                    logger.debug(
                        `   Library download - trying same-artist fallback...`
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "No sources available"
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }

                await prisma.downloadJob.update({
                    where: { id: jobId },
                    data: {
                        correlationId,
                        status: "failed",
                        error: error.message,
                        completedAt: new Date(),
                        metadata: {
                            ...existingMetadata,
                            statusText: "No sources available",
                            failedAt: new Date().toISOString(),
                        },
                    },
                });

                if (job) {
                    eventBus.emit({
                        type: "download:failed",
                        userId: job.userId,
                        payload: { jobId: job.id, subject: job.subject, error: error.message || "Download failed" },
                    });
                }
                if (job) await this.notifyFailure(job, error.message || "No sources available");

                if (job?.discoveryBatchId) {
                    const { discoverWeeklyService } = await import(
                        "./discoverWeekly"
                    );
                    await discoverWeeklyService.checkBatchCompletion(
                        job.discoveryBatchId
                    );
                }

                return { success: false, error: error.message, errorType, isRecoverable };
            }

            // If album wasn't found, try same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system instead
            if (job && errorType === AcquisitionErrorType.ALBUM_NOT_FOUND) {
                if (job.discoveryBatchId) {
                    logger.debug(
                        `   Album not found - Discovery job, skipping same-artist fallback`
                    );
                    logger.debug(
                        `   Discovery system will find a different artist instead`
                    );
                } else {
                    logger.debug(
                        `   Album not found - trying same-artist fallback...`
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "Album not found in Lidarr"
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }
            }

            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId,
                    status: "failed",
                    error: error.message || "Failed to add album to Lidarr",
                    completedAt: new Date(),
                    metadata: {
                        ...existingMetadata,
                        statusText: "Failed to start",
                        failedAt: new Date().toISOString(),
                    },
                },
            });

            if (job) {
                eventBus.emit({
                    type: "download:failed",
                    userId: job.userId,
                    payload: { jobId: job.id, subject: job.subject, error: error.message || "Failed to add album to Lidarr" },
                });
            }
            if (job) await this.notifyFailure(job, error.message || "Failed to add album to Lidarr");

            if (job?.discoveryBatchId) {
                const { discoverWeeklyService } = await import(
                    "./discoverWeekly"
                );
                await discoverWeeklyService.checkBatchCompletion(
                    job.discoveryBatchId
                );
            }

            return { success: false, error: error.message, errorType, isRecoverable };
        }
    }

    /** Retries twice when Lidarr is down or locked, unless it is paused; null from addAlbum means it did not take the album. */
    private async addAlbumToLidarr(
        ...args: Parameters<typeof lidarrService.addAlbum>
    ): Promise<NonNullable<Awaited<ReturnType<typeof lidarrService.addAlbum>>>> {
        for (let attempt = 0; ; attempt++) {
            try {
                const album = await lidarrService.addAlbum(...args);
                if (!album) {
                    throw new AcquisitionError(
                        "Lidarr did not add the album",
                        AcquisitionErrorType.ALBUM_NOT_FOUND
                    );
                }
                return album;
            } catch (error) {
                const unavailable =
                    error instanceof AcquisitionError &&
                    error.type === AcquisitionErrorType.LIDARR_UNAVAILABLE;
                if (
                    !unavailable ||
                    attempt >= LIDARR_RETRY_DELAYS_MS.length ||
                    (await sourcePauseController.isPaused("lidarr"))
                ) {
                    throw error;
                }
                const delayMs = LIDARR_RETRY_DELAYS_MS[attempt];
                logger.warn(`   ${error.message}; retrying in ${delayMs / 1000}s`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }

    /** Lidarr is down or unhealthy: the job waits as pending until the health monitor resumes it. */
    private async holdForLidarr(
        job: { id: string; metadata: unknown },
        artistName: string,
        albumTitle: string,
        reason: string
    ): Promise<void> {
        logger.warn(`   ${reason}; waiting for Lidarr`);
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "pending",
                metadata: {
                    ...((job.metadata as any) ?? {}),
                    artistName,
                    albumTitle,
                    waitingForLidarr: true,
                    statusText: "Waiting for Lidarr",
                },
            },
        });
    }

    /** Start every download that was held while Lidarr was unavailable. */
    async resumeHeldDownloads(): Promise<number> {
        const held = await prisma.downloadJob.findMany({
            where: { status: "pending", metadata: { path: ["waitingForLidarr"], equals: true } },
            orderBy: { createdAt: "asc" },
        });
        let resumed = 0;
        for (const job of held) {
            if (await sourcePauseController.isPaused("lidarr")) break;
            const { waitingForLidarr: _, ...metadata } = job.metadata as any;
            const claimed = await prisma.downloadJob.updateMany({
                where: { id: job.id, status: "pending", metadata: { path: ["waitingForLidarr"], equals: true } },
                data: { metadata },
            });
            if (claimed.count === 0) continue;
            await this.startDownload(
                job.id,
                metadata.artistName,
                metadata.albumTitle,
                job.targetMbid!,
                job.userId,
                !!job.discoveryBatchId
            );
            resumed++;
        }
        if (resumed > 0) logger.info(`[LIDARR] Resumed ${resumed} download(s) held while Lidarr was unavailable`);
        return resumed;
    }

    /** Lidarr already has this album at or above the wanted quality: the job is done. */
    private async completeAlreadyOwned(
        job: { id: string; userId: string; subject: string; metadata: unknown; discoveryBatchId: string | null },
        reason: string
    ): Promise<void> {
        const metadata = {
            ...((job.metadata as any) ?? {}),
            statusText: "Already in library",
            alreadyOwnedReason: reason,
            completedAt: new Date().toISOString(),
        };
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: { status: "completed", completedAt: new Date(), metadata },
        });
        logger.debug(`   ${reason} - job ${job.id} complete`);
        await this.announceCompletion({
            jobId: job.id,
            userId: job.userId,
            subject: job.subject,
            metadata,
            batchId: job.discoveryBatchId ?? undefined,
            spotifyImportJobId: metadata.spotifyImportJobId,
        });
    }

    /** Tell the user and the batch that owns the job that it completed. */
    private async announceCompletion(result: {
        jobId: string;
        userId: string;
        subject: string;
        metadata: any;
        batchId?: string;
        spotifyImportJobId?: string;
    }): Promise<void> {
        eventBus.emit({
            type: "download:complete",
            userId: result.userId,
            payload: { jobId: result.jobId, subject: result.subject },
        });

        try {
            const decision =
                await notificationPolicyService.evaluateNotification(
                    result.jobId,
                    "complete"
                );

            if (decision.shouldNotify) {
                logger.debug(
                    `   Sending completion notification: ${decision.reason}`
                );
                await notificationService.notifyDownloadComplete(
                    result.userId,
                    result.subject,
                    undefined,
                    result.metadata?.artistId
                );

                await prisma.downloadJob.update({
                    where: { id: result.jobId },
                    data: {
                        metadata: {
                            ...result.metadata,
                            notificationSent: true,
                        },
                    },
                });
            } else {
                logger.debug(
                    `   Suppressing completion notification: ${decision.reason}`
                );
            }
        } catch (notifError) {
            logger.error(
                "Failed to evaluate/send download notification:",
                notifError
            );
        }

        if (result.batchId) {
            const { discoverWeeklyService } = await import(
                "./discoverWeekly"
            );
            await discoverWeeklyService.checkBatchCompletion(
                result.batchId
            );
        }

        if (result.spotifyImportJobId) {
            const { spotifyImportService } = await import(
                "./spotifyImport"
            );
            await spotifyImportService.checkImportCompletion(
                result.spotifyImportJobId
            );
        }
    }

    /**
     * The jobs a Lidarr event about an album belongs to: those carrying its MBID
     * or Lidarr album id, else those with its artist and title. Several users can
     * each have a job on one album.
     */
    private jobsForAlbum<J extends { targetMbid: string | null; lidarrAlbumId: number | null; subject: string; metadata: Prisma.JsonValue }>(
        jobs: J[],
        album: { albumMbid?: string; lidarrAlbumId?: number; artistName?: string; albumTitle?: string }
    ): J[] {
        const byId = jobs.filter((j) => {
            const meta = (j.metadata as any) ?? {};
            const mbidMatch = !!album.albumMbid && (j.targetMbid === album.albumMbid || meta.lidarrMbid === album.albumMbid);
            const idMatch = !!album.lidarrAlbumId && (j.lidarrAlbumId === album.lidarrAlbumId || meta.lidarrAlbumId === album.lidarrAlbumId);
            return mbidMatch || idMatch;
        });
        if (byId.length > 0) return byId;

        const artist = album.artistName?.toLowerCase().trim();
        const title = album.albumTitle?.toLowerCase().trim();
        if (!artist || !title) return [];
        return jobs.filter((j) => {
            const meta = (j.metadata as any) ?? {};
            const subject = j.subject.toLowerCase();
            return (
                (meta.artistName?.toLowerCase().trim() === artist && meta.albumTitle?.toLowerCase().trim() === title) ||
                (subject.includes(artist) && subject.includes(title))
            );
        });
    }

    /**
     * Lidarr grabbed a release: every job waiting for that album takes the
     * download. A grab no job asked for is Lidarr's own and stays untracked.
     */
    async onDownloadGrabbed(
        downloadId: string,
        albumMbid: string,
        albumTitle: string,
        artistName: string,
        lidarrAlbumId: number
    ): Promise<{ matched: boolean; jobId?: string }> {
        logger.debug(`[DOWNLOAD] Grabbed: ${artistName} - ${albumTitle} (${downloadId})`);

        return await this.withTransaction(
            async (tx) => {
                const tracked = await tx.downloadJob.findFirst({
                    where: { metadata: { path: ["downloadId"], equals: downloadId } },
                    select: { id: true },
                });
                if (tracked) return { matched: true, jobId: tracked.id };

                const waiting = await tx.downloadJob.findMany({
                    where: { status: { in: ["pending", "processing"] }, lidarrRef: null },
                    orderBy: { createdAt: "asc" },
                });
                const jobs = this.jobsForAlbum(waiting, { albumMbid, lidarrAlbumId, artistName, albumTitle });
                if (jobs.length === 0) {
                    logger.debug(`   No job asked for this album; Lidarr grabbed it on its own`);
                    return { matched: false };
                }

                const grabbedAt = new Date().toISOString();
                for (const job of jobs) {
                    await tx.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "processing",
                            lidarrRef: downloadId,
                            lidarrAlbumId: lidarrAlbumId || job.lidarrAlbumId,
                            targetMbid: job.targetMbid || albumMbid,
                            metadata: {
                                ...((job.metadata as any) || {}),
                                downloadId,
                                lidarrMbid: albumMbid,
                                grabbedAt,
                            },
                        },
                    });
                }
                logger.debug(`   ${jobs.length} job(s) took the download`);
                return { matched: true, jobId: jobs[0].id };
            },
            { logPrefix: "[GRAB-TX]" }
        );
    }

    /**
     * Lidarr imported a download: every job waiting for that album completes,
     * and each job's user and batch are told.
     */
    async onDownloadComplete(
        downloadId: string,
        albumMbid?: string,
        artistName?: string,
        albumTitle?: string,
        lidarrAlbumId?: number
    ): Promise<{
        jobId?: string;
        batchId?: string;
        downloadBatchId?: string;
        spotifyImportJobId?: string;
    }> {
        logger.debug(`[COMPLETE] Download completed: ${downloadId}`);

        const jobs = await this.withTransaction(
            async (tx) => {
                const done = await tx.downloadJob.findFirst({
                    where: { metadata: { path: ["downloadId"], equals: downloadId }, status: "completed" },
                });
                if (done) return [done];

                const active = await tx.downloadJob.findMany({
                    where: { status: { in: ["pending", "processing"] } },
                    orderBy: { createdAt: "asc" },
                });
                const byDownload = active.filter(
                    (j) => j.lidarrRef === downloadId || (j.metadata as any)?.previousDownloadIds?.includes(downloadId)
                );
                const albumIds = new Set(
                    [lidarrAlbumId, ...byDownload.map((j) => j.lidarrAlbumId)].filter((id): id is number => !!id)
                );
                let matched = active.filter(
                    (j) => byDownload.includes(j) || (j.lidarrAlbumId !== null && albumIds.has(j.lidarrAlbumId))
                );
                if (matched.length === 0) {
                    matched = this.jobsForAlbum(active, { albumMbid, lidarrAlbumId, artistName, albumTitle });
                }
                if (matched.length === 0) {
                    logger.debug(`   No matching job found`);
                    return [];
                }

                const nameKey = (m: any) =>
                    m?.artistName && m?.albumTitle
                        ? `${m.artistName.toLowerCase().trim()}\u0000${m.albumTitle.toLowerCase().trim()}`
                        : null;
                const names = new Set(matched.map((j) => nameKey(j.metadata)).filter(Boolean));
                const sameNames = active.filter((j) => !matched.includes(j) && names.has(nameKey(j.metadata)));

                const completedAt = new Date();
                const completed = [];
                for (const job of [...matched, ...sameNames]) {
                    completed.push(
                        await tx.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "completed",
                                completedAt,
                                error: null,
                                metadata: { ...((job.metadata as any) || {}), completedAt: completedAt.toISOString() },
                            },
                        })
                    );
                }
                logger.debug(`   ${completed.length} job(s) marked complete`);
                return completed.map((job) => ({ ...job, announce: true }));
            },
            { logPrefix: "[COMPLETE-TX]" }
        );

        for (const job of jobs) {
            if (!("announce" in job)) continue;
            const metadata = job.metadata as any;
            await this.announceCompletion({
                jobId: job.id,
                userId: job.userId,
                subject: job.subject,
                metadata,
                batchId: job.discoveryBatchId || undefined,
                spotifyImportJobId: metadata?.spotifyImportJobId,
            });
        }

        const first = jobs[0];
        if (!first) return {};
        const meta = first.metadata as any;
        return {
            jobId: first.id,
            batchId: first.discoveryBatchId || undefined,
            downloadBatchId: meta?.batchId,
            spotifyImportJobId: meta?.spotifyImportJobId,
        };
    }

    /**
     * Count a failed download once against every job on its album, ignoring
     * Lidarr's report of a removal Kima made itself. Lidarr searches again while
     * any of those jobs is under its user's retry limit; a job at its limit moves
     * on or fails, and the album is unmonitored once none still wants it.
     */
    async onImportFailed(
        downloadId: string,
        reason: string,
        albumMbid?: string
    ): Promise<{ jobId?: string; searchAgain: boolean }> {
        logger.debug(`[RETRY] Import failed: ${downloadId} (${reason})`);

        if (isRateLimited({ message: reason })) {
            await sourcePauseController.handleRateLimit("lidarr", { message: reason });
            return { searchAgain: false };
        }

        if (await prisma.handledDownload.findUnique({ where: { downloadId } })) {
            logger.debug(`   Kima removed this download itself, not counting it`);
            return { searchAgain: false };
        }

        const counted = await this.withTransaction(
            async (tx) => {
                const jobs = await tx.downloadJob.findMany({
                    where: {
                        status: "processing",
                        OR: [
                            { lidarrRef: downloadId },
                            { metadata: { path: ["previousDownloadIds"], array_contains: [downloadId] } },
                        ],
                    },
                    orderBy: { createdAt: "asc" },
                });
                if (jobs.length === 0 && albumMbid) {
                    jobs.push(
                        ...(await tx.downloadJob.findMany({
                            where: { status: "processing", targetMbid: albumMbid, lidarrRef: null },
                            orderBy: { createdAt: "asc" },
                        }))
                    );
                }

                const albumIds = [
                    ...new Set(
                        jobs.filter((j) => j.lidarrRef === downloadId).map((j) => j.lidarrAlbumId).filter((id): id is number => !!id)
                    ),
                ];
                if (albumIds.length > 0) {
                    jobs.push(
                        ...(await tx.downloadJob.findMany({
                            where: {
                                status: "processing",
                                lidarrAlbumId: { in: albumIds },
                                lidarrRef: null,
                                id: { notIn: jobs.map((j) => j.id) },
                            },
                            orderBy: { createdAt: "asc" },
                        }))
                    );
                }

                const results = [];
                for (const job of jobs) {
                    const metadata = (job.metadata as any) || {};
                    if (metadata.previousDownloadIds?.includes(downloadId)) {
                        results.push({ job, metadata, exhausted: false });
                        continue;
                    }
                    const exhausted = job.attempts >= (await this.maxAttempts(job.userId));
                    const attempts = exhausted ? job.attempts : job.attempts + 1;
                    const updated = {
                        ...metadata,
                        lastError: reason,
                        previousDownloadIds: [...(metadata.previousDownloadIds || []), downloadId],
                        statusText: `Lidarr #${attempts}`,
                    };
                    await tx.downloadJob.update({
                        where: { id: job.id },
                        data: { lidarrRef: null, attempts, metadata: updated },
                    });
                    results.push({ job, metadata: updated, exhausted });
                }
                return results;
            },
            { logPrefix: "[FAIL-TX]" }
        );

        if (counted.length === 0) return { searchAgain: false };
        const searchAgain = counted.some((c) => !c.exhausted);

        if (!searchAgain) {
            const albumIds = new Set(counted.map((c) => c.job.lidarrAlbumId).filter((id): id is number => !!id));
            for (const id of albumIds) await lidarrService.unmonitorAlbum(id);
        }
        for (const { job, metadata, exhausted } of counted) {
            if (!exhausted) continue;
            logger.debug(`[RETRY] ${job.subject}: retry limit reached after ${job.attempts} releases`);
            await this.tryNextAlbumFromArtist({ ...job, metadata }, reason);
        }
        return { jobId: counted[0].job.id, searchAgain };
    }

    /**
     * Lidarr deleted the album: fail the jobs downloading it without falling
     * back to another album, and forget the id on Discover rows.
     */
    async onAlbumDeleted(lidarrAlbumId: number): Promise<string | undefined> {
        const error = "Album removed from Lidarr";
        const jobs = await prisma.downloadJob.findMany({
            where: { lidarrAlbumId, status: "processing" },
        });

        for (const job of jobs) {
            const { count } = await prisma.downloadJob.updateMany({
                where: { id: job.id, status: "processing" },
                data: { status: "failed", error, completedAt: new Date() },
            });
            if (count === 0) continue;

            eventBus.emit({
                type: "download:failed",
                userId: job.userId,
                payload: { jobId: job.id, subject: job.subject, error },
            });
            if (job.discoveryBatchId) {
                const { discoverWeeklyService } = await import("./discoverWeekly");
                await discoverWeeklyService.checkBatchCompletion(job.discoveryBatchId);
            }
        }

        await prisma.discoveryAlbum.updateMany({
            where: { lidarrAlbumId },
            data: { lidarrAlbumId: null },
        });
        return jobs[0]?.id;
    }

    /**
     * Picks the artist's next album that no job has tried and Lidarr does not
     * already hold in full, retires the current job, and creates the next one.
     * Runs under a per-artist lock so two failing jobs cannot pick the same album.
     */
    private async createFallbackJob(
        job: any,
        artistMbid: string,
        artistName: string | undefined,
        metadata: any,
        lidarrAlbums: LidarrAlbum[]
    ) {
        const artistJobs = await prisma.downloadJob.findMany({
            where: {
                artistMbid,
                status: { in: ["pending", "processing", "completed", "failed", "exhausted"] },
            },
            select: { targetMbid: true },
        });
        const tried = new Set(artistJobs.map((j) => j.targetMbid));
        tried.add(job.targetMbid);

        const untried = lidarrAlbums.filter(
            (album) => !tried.has(album.foreignAlbumId) && (album.statistics?.percentOfTracks ?? 0) < 100
        );
        logger.debug(`   Untried albums in Lidarr: ${untried.length}`);
        if (untried.length === 0) return null;

        const studioAlbums = untried.filter(
            (a: any) => a.albumType?.toLowerCase() === "album" || !a.albumType
        );
        const nextAlbum = studioAlbums[0] ?? untried[0];
        logger.debug(`[RETRY] Trying next album from same artist: ${nextAlbum.title}`);

        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "exhausted",
                error: `All releases exhausted - trying: ${nextAlbum.title}`,
                completedAt: new Date(),
            },
        });

        const settings = await getSystemSettings();
        const albumMbid = nextAlbum.foreignAlbumId;
        return prisma.downloadJob.create({
            data: {
                userId: job.userId,
                subject: `${artistName || "Unknown"} - ${nextAlbum.title}`,
                type: "album",
                targetMbid: albumMbid,
                status: "pending",
                discoveryBatchId: job.discoveryBatchId,
                artistMbid,
                metadata: {
                    artistName,
                    artistMbid,
                    albumTitle: nextAlbum.title,
                    albumMbid,
                    lidarrAlbumId: nextAlbum.id,
                    sameArtistFallback: true,
                    originalJobId: job.id,
                    downloadType: metadata.downloadType || "library",
                    rootFolderPath: metadata.rootFolderPath || settings?.musicPath || config.music.musicPath,
                },
            },
        });
    }

    /**
     * Try another album by the same artist once every release of this one failed.
     * Not for Discover Weekly (it wants new artists) or Spotify imports (they want
     * the exact playlist).
     */
    private async tryNextAlbumFromArtist(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        const metadata = (job.metadata as any) || {};
        const artistMbid = job.artistMbid || metadata.artistMbid;
        const artistName = metadata.artistName;

        // Discover finds a different artist rather than another album by this one.
        if (job.discoveryBatchId) {
            logger.debug(
                `[RETRY] Discovery job - skipping same-artist fallback (diversity enforced)`
            );
            logger.debug(
                `   Discovery should find NEW artists, not more from: ${artistName}`
            );
            return await this.markJobExhausted(job, reason);
        }

        // A Spotify import wants the exact playlist, not another album by the artist.
        if (
            metadata.spotifyImportJobId ||
            metadata.downloadType === "spotify_import" ||
            metadata.noFallback
        ) {
            logger.debug(
                `[RETRY] Spotify Import job - skipping fallback (exact match required)`
            );
            logger.debug(`   User wants exact album: ${job.subject}`);

            const result = await this.markJobExhausted(job, reason);

            if (metadata.spotifyImportJobId) {
                const { spotifyImportService } = await import(
                    "./spotifyImport"
                );
                await spotifyImportService.checkImportCompletion(
                    metadata.spotifyImportJobId
                );
            }

            return result;
        }

        if (!artistMbid) {
            logger.debug(
                `   No artistMbid - cannot try other albums from same artist`
            );
            return await this.markJobExhausted(job, reason);
        }

        logger.debug(
            `[RETRY] Trying other albums from artist: ${
                artistName || artistMbid
            }`
        );

        try {
            // Get albums available in LIDARR for this artist (not MusicBrainz)
            // MusicBrainz has many obscure albums (bootlegs, live recordings) that Lidarr can't find
            const lidarrAlbums = await lidarrService.getArtistAlbums(
                artistMbid
            );

            if (!lidarrAlbums || lidarrAlbums.length === 0) {
                logger.debug(`   No albums found in Lidarr for artist`);
                return await this.markJobExhausted(job, reason);
            }

            logger.debug(
                `   Found ${lidarrAlbums.length} albums in Lidarr for artist`
            );

            const newJob = await distributedLock.withLock(
                `download-fallback:${artistMbid}`,
                10_000,
                () => this.createFallbackJob(job, artistMbid, artistName, metadata, lidarrAlbums)
            );
            if (!newJob) {
                logger.debug(`   All Lidarr albums from artist exhausted`);
                return await this.markJobExhausted(job, reason);
            }
            const albumMbid = newJob.targetMbid!;
            const nextAlbumTitle = (newJob.metadata as any).albumTitle;

            logger.debug(`   Created fallback job: ${newJob.id}`);

            const result = await this.startDownload(
                newJob.id,
                artistName || "Unknown Artist",
                nextAlbumTitle,
                albumMbid,
                job.userId
            );

            if (result.success) {
                logger.debug(`   Same-artist fallback download started`);
                return { retried: true, failed: false, jobId: newJob.id };
            } else {
                logger.debug(
                    `   Same-artist fallback failed to start: ${result.error}`
                );
                // The new job will be marked as failed by startDownload
                return { retried: false, failed: true, jobId: newJob.id };
            }
        } catch (error: any) {
            logger.error(
                `   Error trying same-artist fallback: ${error.message}`
            );
            return await this.markJobExhausted(job, reason);
        }
    }

    /**
     * A job is completed when another job already brought in the same album,
     * matched by release-group id or by exact artist and album title.
     */
    private async completeFromDuplicate(job: any): Promise<boolean> {
        const meta = (job.metadata as any) ?? {};
        const artistName = String(meta.artistName ?? "").toLowerCase().trim();
        const albumTitle = String(meta.albumTitle ?? "").toLowerCase().trim();
        const targetMbid = job.targetMbid ?? null;
        if (!targetMbid && !(artistName && albumTitle)) return false;

        const [duplicate] = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "DownloadJob"
            WHERE id <> ${job.id}
              AND status = 'completed'
              AND ("targetMbid" = ${targetMbid}
                OR (${artistName} <> '' AND ${albumTitle} <> ''
                  AND lower(trim(metadata->>'artistName')) = ${artistName}
                  AND lower(trim(metadata->>'albumTitle')) = ${albumTitle}))
            LIMIT 1
        `;
        if (!duplicate) return false;

        logger.debug(`   Completed by duplicate job ${duplicate.id}`);
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "completed",
                completedAt: new Date(),
                error: null,
                metadata: { ...meta, mergedWithJob: duplicate.id },
            },
        });
        eventBus.emit({
            type: "download:complete",
            userId: job.userId,
            payload: { jobId: job.id, subject: job.subject },
        });
        return true;
    }

    /** One tray row per failed album, when the notification policy says the user needs it. */
    private async notifyFailure(
        job: { id: string; userId: string; subject: string },
        reason: string
    ): Promise<void> {
        try {
            const decision = await notificationPolicyService.evaluateNotification(job.id, "failed");
            if (!decision.shouldNotify) {
                logger.debug(`   Suppressing failure notification: ${decision.reason}`);
                return;
            }
            await notificationService.notifyDownloadFailed(job.userId, job.subject, reason);
            await prisma.$executeRaw`
                UPDATE "DownloadJob"
                SET metadata = coalesce(metadata, '{}'::jsonb) || '{"notificationSent": true}'::jsonb
                WHERE id = ${job.id}
            `;
        } catch (notifError) {
            logger.error("Failed to evaluate/send failure notification:", notifError);
        }
    }

    /** Fails a job that has run out of releases and same-artist albums. */
    private async markJobExhausted(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        logger.debug(`[RETRY] Job fully exhausted: ${job.id}`);

        if (await this.completeFromDuplicate(job)) {
            return { retried: false, failed: false, jobId: job.id };
        }

        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "failed",
                error: `All releases and albums exhausted: ${reason}`,
                completedAt: new Date(),
            },
        });

        eventBus.emit({
            type: "download:failed",
            userId: job.userId,
            payload: { jobId: job.id, subject: job.subject, error: `All releases and albums exhausted: ${reason}` },
        });

        if (job.discoveryBatchId) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            await discoverWeeklyService.checkBatchCompletion(
                job.discoveryBatchId
            );
        }

        await this.notifyFailure(job, reason);

        return { retried: false, failed: true, jobId: job.id };
    }

    /**
     * Fail stale jobs: pending over 10 min (never started), processing without a
     * Lidarr ref over 5 min (no sources), with one over 15 min and not downloading.
     * Jobs waiting for Lidarr are spared, and nothing is judged against a paused Lidarr.
     * Accepts a prefetched snapshot to avoid repeat API calls.
     */
    async markStaleJobsAsFailed(
        existingSnapshot?: ReconciliationSnapshot | null
    ): Promise<number> {
        const pendingCutoff = new Date(Date.now() - this.PENDING_TIMEOUT_MS);
        const noSourceCutoff = new Date(Date.now() - this.NO_SOURCE_TIMEOUT_MS);
        const importCutoff = new Date(Date.now() - this.IMPORT_TIMEOUT_MS);

        const activeJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        if (activeJobs.length > 0) {
            const spotifyJobs = activeJobs.filter((j) =>
                j.id.startsWith("spotify_")
            );
            if (spotifyJobs.length > 0) {
                sessionLog(
                    "CLEANUP",
                    `Checking ${activeJobs.length} active jobs (${spotifyJobs.length} Spotify import)`
                );
            }
        }

        const pendingJobs = activeJobs.filter((j) => j.status === "pending");
        const processingJobs = activeJobs.filter(
            (j) => j.status === "processing"
        );

        const stalePendingJobs = pendingJobs.filter(
            (job) => job.createdAt < pendingCutoff && !(job.metadata as any)?.waitingForLidarr
        );

        const pendingDiscoveryBatchIds = new Set<string>();

        if (stalePendingJobs.length > 0) {
            logger.debug(
                `\n⏰ Found ${stalePendingJobs.length} stuck PENDING jobs (never started)`
            );
            sessionLog(
                "CLEANUP",
                `Found ${stalePendingJobs.length} stuck PENDING jobs`
            );

            for (const job of stalePendingJobs) {
                if (job.discoveryBatchId) {
                    pendingDiscoveryBatchIds.add(job.discoveryBatchId);
                }
            }

            await prisma.downloadJob.updateMany({
                where: { id: { in: stalePendingJobs.map((j) => j.id) } },
                data: {
                    status: "failed",
                    error: "Download never started - timed out",
                    completedAt: new Date(),
                },
            });

            for (const job of stalePendingJobs) {
                eventBus.emit({
                    type: "download:failed",
                    userId: job.userId,
                    payload: { jobId: job.id, subject: job.subject, error: "Download never started - timed out" },
                });
                await this.notifyFailure(job, "Download never started - timed out");
            }

            logger.debug(`   Batch updated ${stalePendingJobs.length} pending jobs to failed`);
        }

        if (pendingDiscoveryBatchIds.size > 0) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            for (const batchId of pendingDiscoveryBatchIds) {
                await discoverWeeklyService.checkBatchCompletion(batchId);
                await yieldToEventLoop();
            }
        }

        if (processingJobs.length === 0) {
            return stalePendingJobs.length;
        }

        const snapshot = existingSnapshot;
        const lidarrPaused = await sourcePauseController.isPaused("lidarr");

        const staleJobs: typeof processingJobs = [];
        const jobsToExtend: { id: string; metadata: any }[] = [];

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const startedAt = metadata?.startedAt
                ? new Date(metadata.startedAt)
                : job.createdAt;

            // Jobs without lidarrRef = Lidarr never grabbed = no sources found
            if (!job.lidarrRef) {
                if (startedAt < noSourceCutoff && !lidarrPaused) {
                    staleJobs.push(job);
                }
            } else if (snapshot) {
                // Jobs with lidarrRef = grabbed but potentially still downloading
                // Only check if we have a snapshot (Lidarr is available)
                if (startedAt < importCutoff) {
                    const downloadStatus = lidarrService.isDownloadActiveInSnapshot(
                        snapshot,
                        job.lidarrRef
                    );

                    if (downloadStatus.active) {
                        jobsToExtend.push({
                            id: job.id,
                            metadata: {
                                ...metadata,
                                startedAt: new Date().toISOString(),
                                extendedTimeout: true,
                            },
                        });
                        logger.debug(
                            `   ${job.subject}: Still downloading (${downloadStatus.progress || 0}%), extending timeout`
                        );
                    } else {
                        staleJobs.push(job);
                    }
                }
            }
            // Without a snapshot Lidarr's state is unknown, so grabbed jobs wait for the next cycle.
        }

        // Each job gets its own metadata, so these updates run one at a time.
        for (const { id, metadata } of jobsToExtend) {
            await prisma.downloadJob.update({
                where: { id },
                data: { metadata },
            });
        }
        if (jobsToExtend.length > 0) {
            await yieldToEventLoop();
        }

        if (staleJobs.length === 0) {
            return stalePendingJobs.length;
        }

        logger.debug(`\n⏰ Found ${staleJobs.length} stale download jobs`);
        sessionLog(
            "CLEANUP",
            `Found ${staleJobs.length} stale jobs to mark as failed`
        );

        const batchIds = new Set<string>();
        const downloadBatchIds = new Set<string>();

        for (const job of staleJobs) {
            const metadata = (job.metadata as any) || {};

            try {
                const policyDecision =
                    await notificationPolicyService.evaluateNotification(
                        job.id,
                        "timeout"
                    );

                if (
                    policyDecision.reason.includes("retry window") ||
                    policyDecision.reason.includes("extending timeout")
                ) {
                    logger.debug(
                        `   ${job.subject}: ${policyDecision.reason} - extending timeout`
                    );
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            metadata: {
                                ...metadata,
                                startedAt: new Date().toISOString(),
                                timeoutExtendedByPolicy: true,
                            },
                        },
                    });
                    continue; // Skip to next job
                }
            } catch (policyError) {
                logger.error(
                    `   Failed to evaluate policy for ${job.id}:`,
                    policyError
                );
            }

            const hasLidarrRef = !!job.lidarrRef;
            const errorMessage = hasLidarrRef
                ? `Import failed - download stuck for ${
                      this.IMPORT_TIMEOUT_MS / 60000
                  } minutes`
                : `No sources found - no indexer results`;

            logger.debug(
                `   Timing out: ${job.subject} (${
                    hasLidarrRef ? "stuck import" : "no sources"
                })`
            );
            sessionLog(
                "CLEANUP",
                `Marking stale: ${job.subject} - ${errorMessage}`
            );
            if (await this.completeFromDuplicate(job)) continue;

            if (job.lidarrAlbumId && job.lidarrRef) {
                await removeFailedDownload(job.lidarrRef, errorMessage, { searchAgain: false });
            }

            // Use same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system
            let replacementStarted = false;
            const artistMbid = job.artistMbid || metadata.artistMbid;

            if (artistMbid && !job.discoveryBatchId) {
                logger.debug(`   Attempting same-artist fallback...`);
                try {
                    const fallbackResult = await this.tryNextAlbumFromArtist(
                        { ...job, metadata },
                        errorMessage
                    );
                    if (fallbackResult.retried && fallbackResult.jobId) {
                        logger.debug(
                            `   Same-artist fallback started: ${fallbackResult.jobId}`
                        );
                        replacementStarted = true;
                    }
                } catch (fallbackErr: any) {
                    logger.error(
                        `   Same-artist fallback error: ${fallbackErr.message}`
                    );
                }
            } else if (job.discoveryBatchId) {
                logger.debug(
                    `   Discovery job - letting discovery system find new artist`
                );
            }

            if (!replacementStarted) {
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: errorMessage,
                        completedAt: new Date(),
                    },
                });
                eventBus.emit({
                    type: "download:failed",
                    userId: job.userId,
                    payload: { jobId: job.id, subject: job.subject, error: errorMessage },
                });
                await this.notifyFailure(job, errorMessage);
            }

            if (job.discoveryBatchId) {
                batchIds.add(job.discoveryBatchId);
            }

            if (metadata?.batchId) {
                downloadBatchIds.add(metadata.batchId);
            }
        }

        if (batchIds.size > 0) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            for (const batchId of batchIds) {
                logger.debug(
                    `   Checking discovery batch completion: ${batchId}`
                );
                await discoverWeeklyService.checkBatchCompletion(batchId);
                await yieldToEventLoop();
            }
        }

        return stalePendingJobs.length + staleJobs.length;
    }

    /**
     * Get statistics about current downloads
     */
    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.downloadJob.count({ where: { status: "pending" } }),
            prisma.downloadJob.count({ where: { status: "processing" } }),
            prisma.downloadJob.count({ where: { status: "completed" } }),
            prisma.downloadJob.count({ where: { status: "failed" } }),
        ]);

        this.updateActiveDownloadsMetric().catch(() => {});

        return { pending, processing, completed, failed };
    }

    /**
     * Reconcile processing jobs with Lidarr
     * Checks if albums in "processing" state are already available in Lidarr
     * and marks them as completed if so (fixes missed webhook completion events)
     *
     * IMPORTANT: Checks by both MBID and artist+album name to handle MBID mismatches
     */
    /**
     * Reconcile processing jobs with Lidarr using batch snapshot approach.
     * Fetches all Lidarr data once, then checks jobs against in-memory data.
     *
     * Optionally accepts a pre-fetched snapshot to avoid duplicate API calls
     * when called alongside other reconciliation methods.
     */
    async reconcileWithLidarr(
        existingSnapshot?: ReconciliationSnapshot | null
    ): Promise<{
        reconciled: number;
        errors: string[];
        snapshot?: ReconciliationSnapshot;
    }> {
        logger.debug(`\n[RECONCILE] Checking processing jobs against Lidarr...`);

        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: "processing" },
        });

        if (processingJobs.length === 0) {
            logger.debug(`   No processing jobs to reconcile`);
            return { reconciled: 0, errors: [] };
        }

        logger.debug(`   Found ${processingJobs.length} processing job(s)`);

        if (!existingSnapshot) {
            logger.debug(`   No Lidarr snapshot available, skipping reconciliation`);
            return { reconciled: 0, errors: [] };
        }
        const snapshot = existingSnapshot;

        const toComplete: string[] = [];
        const discoveryBatchIds = new Set<string>();

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const albumMbid = job.targetMbid || metadata?.albumMbid || metadata?.lidarrMbid;
            const artistName = metadata?.artistName;
            const albumTitle = metadata?.albumTitle;

            let isAvailable = lidarrService.isAlbumAvailableInSnapshot(
                snapshot,
                albumMbid,
                artistName,
                albumTitle
            );

            if (!isAvailable && metadata?.lidarrMbid && metadata.lidarrMbid !== albumMbid) {
                isAvailable = lidarrService.isAlbumAvailableInSnapshot(
                    snapshot,
                    metadata.lidarrMbid,
                    undefined,
                    undefined
                );
            }

            // Jobs without metadata names carry them in the "Artist - Album" subject.
            if (!isAvailable && !artistName && job.subject) {
                const parts = job.subject.split(" - ");
                if (parts.length >= 2) {
                    const parsedArtist = parts[0].trim();
                    const parsedAlbum = parts.slice(1).join(" - ").trim();
                    isAvailable = lidarrService.isAlbumAvailableInSnapshot(
                        snapshot,
                        undefined,
                        parsedArtist,
                        parsedAlbum
                    );
                }
            }

            if (isAvailable) {
                logger.debug(`   Job ${job.id}: Album "${job.subject}" found in Lidarr`);
                toComplete.push(job.id);
                if (job.discoveryBatchId) {
                    discoveryBatchIds.add(job.discoveryBatchId);
                }
            } else {
                // Only log for jobs older than 5 minutes
                const jobAge = Date.now() - (job.createdAt?.getTime() || 0);
                if (jobAge > 5 * 60 * 1000) {
                    logger.debug(
                        `   Job ${job.id}: "${job.subject}" not yet available (${Math.round(jobAge / 60000)}m old)`
                    );
                }
            }
        }

        if (toComplete.length > 0) {
            await prisma.downloadJob.updateMany({
                where: { id: { in: toComplete } },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    error: null,
                },
            });

            const completedSet = new Set(toComplete);
            for (const job of processingJobs) {
                if (completedSet.has(job.id)) {
                    eventBus.emit({
                        type: "download:complete",
                        userId: job.userId,
                        payload: { jobId: job.id, subject: job.subject },
                    });
                }
            }

            logger.debug(`   Batch updated ${toComplete.length} job(s) to completed`);
        }

        if (discoveryBatchIds.size > 0) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            for (const batchId of discoveryBatchIds) {
                await discoverWeeklyService.checkBatchCompletion(batchId);
                await yieldToEventLoop();
            }
        }

        logger.debug(`[RECONCILE] Reconciled ${toComplete.length} job(s)`);
        return { reconciled: toComplete.length, errors: [], snapshot };
    }

    /**
     * Sync with Lidarr's queue to catch cancelled or orphaned downloads. A missing
     * download is cancelled only after 3 checks (90 s), and a changed downloadId is
     * treated as a replacement, since Lidarr retries with new releases.
     */
    async syncWithLidarrQueue(
        existingSnapshot?: ReconciliationSnapshot | null
    ): Promise<{
        cancelled: number;
        errors: string[];
    }> {
        logger.debug(
            `\n[QUEUE-SYNC] Syncing processing jobs with Lidarr queue...`
        );

        const processingJobs = await prisma.downloadJob.findMany({
            where: {
                status: "processing",
                lidarrRef: { not: null },
            },
        });

        if (processingJobs.length === 0) {
            logger.debug(`   No processing jobs with lidarrRef to sync`);
            return { cancelled: 0, errors: [] };
        }

        logger.debug(
            `   Found ${processingJobs.length} processing job(s) with lidarrRef`
        );

        if (!existingSnapshot) {
            logger.debug(`   No Lidarr snapshot available, skipping queue sync`);
            return { cancelled: 0, errors: [] };
        }

        try {
            const snapshot = existingSnapshot;

            const queueDownloadIds = new Set(snapshot.queue.keys());
            const queueItems = Array.from(snapshot.queue.values());

            logger.debug(`   Lidarr queue has ${queueDownloadIds.size} item(s)`);

            let cancelled = 0;
            const errors: string[] = [];
            const discoveryBatchIds = new Set<string>();

            const jobsToResetCounter: { id: string; metadata: any }[] = [];
            const jobsToIncrementCounter: { id: string; metadata: any; count: number }[] = [];
            const jobsToUpdateDownloadId: { id: string; metadata: any; newDownloadId: string; oldDownloadId: string }[] = [];
            const jobsToComplete: { id: string; metadata: any }[] = [];
            const jobsToFail: { id: string; metadata: any; missingCount: number }[] = [];

            for (const job of processingJobs) {
                if (!job.lidarrRef) continue;

                const metadata = job.metadata as any;
                const artistName = metadata?.artistName;
                const albumTitle = metadata?.albumTitle;

                if (queueDownloadIds.has(job.lidarrRef)) {
                    if (metadata?.queueSyncMissingCount && metadata.queueSyncMissingCount > 0) {
                        jobsToResetCounter.push({ id: job.id, metadata });
                    }
                    continue;
                }

                // Download ID not found in queue - check grace period
                const missingCount = (metadata?.queueSyncMissingCount || 0) + 1;

                if (missingCount < 3) {
                    jobsToIncrementCounter.push({ id: job.id, metadata, count: missingCount });
                    continue;
                }

                // After 3 checks, check for replacement downloads
                const replacementDownload = queueItems.find((item) => {
                    if (!item.downloadId || !albumTitle) return false;
                    const queueTitle = item.title?.toLowerCase() || "";
                    const searchAlbum = albumTitle.toLowerCase();
                    const searchArtist = artistName?.toLowerCase() || "";
                    return (
                        queueTitle.includes(searchAlbum) &&
                        (searchArtist ? queueTitle.includes(searchArtist) : true)
                    );
                });

                if (replacementDownload && replacementDownload.downloadId) {
                    jobsToUpdateDownloadId.push({
                        id: job.id,
                        metadata,
                        newDownloadId: replacementDownload.downloadId,
                        oldDownloadId: job.lidarrRef,
                    });
                    continue;
                }

                // No replacement - check if album is already downloaded using snapshot
                const isAvailable = lidarrService.isAlbumAvailableInSnapshot(
                    snapshot,
                    job.targetMbid || undefined,
                    artistName,
                    albumTitle
                );

                if (isAvailable) {
                    jobsToComplete.push({ id: job.id, metadata });
                    cancelled++;
                } else {
                    jobsToFail.push({ id: job.id, metadata, missingCount });
                    if (job.discoveryBatchId) {
                        discoveryBatchIds.add(job.discoveryBatchId);
                    }
                    cancelled++;
                }
            }

            // Build lookup for SSE events (jobsToComplete/jobsToFail only store id + metadata)
            const jobLookup = new Map(processingJobs.map((j) => [j.id, j]));

            // Process updates (individual updates needed for different metadata per job)
            for (const { id, metadata } of jobsToResetCounter) {
                await prisma.downloadJob.update({
                    where: { id },
                    data: {
                        metadata: {
                            ...metadata,
                            queueSyncMissingCount: 0,
                            lastQueueSyncFound: new Date().toISOString(),
                        },
                    },
                });
            }

            for (const { id, metadata, count } of jobsToIncrementCounter) {
                await prisma.downloadJob.update({
                    where: { id },
                    data: {
                        metadata: {
                            ...metadata,
                            queueSyncMissingCount: count,
                            lastQueueSyncCheck: new Date().toISOString(),
                        },
                    },
                });
            }

            for (const { id, metadata, newDownloadId, oldDownloadId } of jobsToUpdateDownloadId) {
                logger.debug(`   Job ${id}: Replacement download found: ${newDownloadId}`);
                await prisma.downloadJob.update({
                    where: { id },
                    data: {
                        lidarrRef: newDownloadId,
                        error: null,
                        metadata: {
                            ...metadata,
                            previousDownloadId: oldDownloadId,
                            replacementDetected: true,
                            replacementDetectedAt: new Date().toISOString(),
                            queueSyncMissingCount: 0,
                        },
                    },
                });
            }

            for (const { id, metadata } of jobsToComplete) {
                logger.debug(`   Job ${id}: Album found in library - marking complete`);
                await prisma.downloadJob.update({
                    where: { id },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        error: null,
                        metadata: {
                            ...metadata,
                            completedAt: new Date().toISOString(),
                            queueSyncCompleted: true,
                            queueSyncMissingCount: 0,
                        },
                    },
                });
                const srcJob = jobLookup.get(id);
                if (srcJob) {
                    eventBus.emit({
                        type: "download:complete",
                        userId: srcJob.userId,
                        payload: { jobId: id, subject: srcJob.subject },
                    });
                }
            }

            for (const { id, metadata, missingCount } of jobsToFail) {
                logger.warn(`   Job ${id}: Download not found after 90s - marking as failed`);
                await prisma.downloadJob.update({
                    where: { id },
                    data: {
                        status: "failed",
                        error: "Lidarr queue sync: Download not found after 90s (3 checks).",
                        completedAt: new Date(),
                        lidarrRef: null,
                        metadata: {
                            ...metadata,
                            cancelledAt: new Date().toISOString(),
                            queueSyncCancelled: true,
                            queueSyncMissingCount: missingCount,
                        },
                    },
                });
                const srcJob = jobLookup.get(id);
                if (srcJob) {
                    eventBus.emit({
                        type: "download:failed",
                        userId: srcJob.userId,
                        payload: { jobId: id, subject: srcJob.subject, error: "Lidarr queue sync: Download not found after 90s (3 checks)." },
                    });
                }
            }

            if (discoveryBatchIds.size > 0) {
                const { discoverWeeklyService } = await import("./discoverWeekly");
                for (const batchId of discoveryBatchIds) {
                    await discoverWeeklyService.checkBatchCompletion(batchId);
                    await yieldToEventLoop();
                }
            }

            logger.debug(`[QUEUE-SYNC] Processed ${cancelled} orphaned job(s)`);
            return { cancelled, errors };
        } catch (error: any) {
            logger.error(
                `[QUEUE-SYNC] Failed to sync with Lidarr queue:`,
                error.message
            );
            return { cancelled: 0, errors: [error.message] };
        }
    }
}

export const simpleDownloadManager = new SimpleDownloadManager();
