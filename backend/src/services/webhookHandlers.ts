/**
 * What each Lidarr webhook event does, shared by the live webhook route and the
 * reconciliation replay so both end in the same state.
 */

import { simpleDownloadManager } from "./simpleDownloadManager";
import { rejectSingleTrackPost } from "./lidarrFailures";
import { queueCleaner } from "../jobs/queueCleaner";
import { requestScan } from "../workers/scanRequest";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { webhookEventStore } from "./webhookEventStore";
import { webhookEventsTotal, webhookProcessingDuration } from "../utils/metrics";

/**
 * Run the side effects for one webhook event and return the correlation
 * id (download job id) when one was matched. Event names are Lidarr's
 * WebhookEventType; Health and Test events are no-ops.
 */
export async function dispatchWebhookEvent(
    eventType: string,
    payload: any
): Promise<string | undefined> {
    switch (eventType) {
        case "Grab":
            return handleGrab(payload);

        case "Download":
            return handleDownload(payload);

        case "ImportFailure":
        case "DownloadFailure":
            return handleImportFailure(payload);

        case "AlbumDelete":
            return handleAlbumDelete(payload);

        case "Rename":
        case "Retag":
            await requestScan({ source: "lidarr-rename" });
            return undefined;

        case "Health":
        case "HealthRestored":
        case "Test":
            return undefined;

        default:
            logger.debug(`   Unhandled event: ${eventType}`);
            return undefined;
    }
}

/** Dispatch a stored event and record the outcome on it; never throws. */
export async function processStoredEvent(
    id: string,
    eventType: string,
    payload: any
): Promise<void> {
    const startTime = Date.now();
    let status = "success";
    try {
        const correlationId = await dispatchWebhookEvent(eventType, payload);
        await webhookEventStore.markProcessed(id, correlationId);
    } catch (error: any) {
        status = "failed";
        logger.error(`[WEBHOOK] ${eventType} event ${id} failed:`, error.message);
        try {
            await webhookEventStore.markFailed(id, error.message);
        } catch (markError: any) {
            logger.error(`[WEBHOOK] Could not record the failure of ${id}:`, markError.message);
        }
    } finally {
        webhookEventsTotal.inc({ event_type: eventType, status });
        webhookProcessingDuration.observe({ event_type: eventType }, (Date.now() - startTime) / 1000);
    }
}

/**
 * Handle Grab event (download started by Lidarr).
 * Kicks the queue cleaner so the stuck-queue sweep notices the grab.
 */
async function handleGrab(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumMbid = payload.albums?.[0]?.mbId;
    const albumTitle = payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const lidarrAlbumId = payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   MBID: ${albumMbid}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onDownloadGrabbed(
        downloadId,
        albumMbid || "",
        albumTitle || "",
        artistName || "",
        lidarrAlbumId || 0
    );

    if (result.matched) {
        await rejectSingleTrackPost(downloadId, payload.release?.releaseTitle);
        queueCleaner.start();
        return result.jobId;
    }

    return undefined;
}

/**
 * Handle Download event (download complete + imported).
 * A matched job scans under that job's id; an unmatched one still gets a
 * full scan — the files exist whether or not we tracked the download.
 */
async function handleDownload(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title;
    const artistName = payload.artist?.name;
    const albumMbid = payload.album?.mbId;
    const lidarrAlbumId = payload.album?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Album MBID: ${albumMbid}`);
    logger.debug(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onDownloadComplete(
        downloadId,
        albumMbid,
        artistName,
        albumTitle,
        lidarrAlbumId
    );

    if (result.jobId) {
        const downloadJob = await prisma.downloadJob.findUnique({
            where: { id: result.jobId },
            select: { userId: true, id: true },
        });

        logger.debug(
            `   Triggering library scan for: ${artistName} - ${albumTitle}`
        );
        await requestScan({
            userId: downloadJob?.userId || undefined,
            source: "lidarr-webhook",
            albumMbid: albumMbid,
            downloadId: result.jobId,
        });

        return result.jobId;
    } else {
        logger.debug(`   No matching job, triggering full scan anyway...`);
        await requestScan({
            source: "lidarr-import-external",
        });
        return undefined;
    }
}

/**
 * Handle import failure with automatic retry.
 */
async function handleImportFailure(
    payload: any
): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumMbid = payload.album?.mbId;
    const albumTitle = payload.album?.title;
    const reason = payload.message || "Import failed";

    logger.debug(`   Album: ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Reason: ${reason}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onImportFailed(
        downloadId,
        reason,
        albumMbid
    );
    return result.jobId;
}

/**
 * Lidarr removed an album: a download running for it can never import, and
 * Discover must not try to delete the album again.
 */
async function handleAlbumDelete(payload: any): Promise<string | undefined> {
    const lidarrAlbumId = payload.album?.id;
    if (!lidarrAlbumId) return undefined;

    logger.debug(`   Album removed: ${payload.artist?.name} - ${payload.album?.title}`);
    return simpleDownloadManager.onAlbumDeleted(lidarrAlbumId);
}
