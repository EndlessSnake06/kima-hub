/**
 * Lidarr webhook handlers — the ONE implementation of what a Grab,
 * Download, or ImportFailure event does (the "one
 * implementation wins").
 *
 * Before this module, routes/webhooks.ts and jobs/webhookReconciliation.ts
 * each kept a copy of these handlers, and the reconciliation copy dropped
 * two side effects (the queueCleaner kick on a matched Grab and the library
 * scan after a Download), so a replayed event silently produced a
 * different end state than a live one. Both paths now call
 * dispatchWebhookEvent; each keeps only its own event-store bookkeeping.
 */

import { simpleDownloadManager } from "./simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { requestScan } from "../workers/scanRequest";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Run the side effects for one webhook event and return the correlation
 * id (download job id) when one was matched. Unknown event types return
 * undefined; "Health"/"Test" events are deliberately no-ops.
 */
export async function dispatchWebhookEvent(
    eventType: string,
    payload: any
): Promise<string | undefined> {
    switch (eventType) {
        case "Grab":
            return handleGrab(payload);

        case "Download":
        case "AlbumDownload":
        case "TrackRetag":
        case "Rename":
            return handleDownload(payload);

        case "ImportFailure":
        case "DownloadFailed":
        case "DownloadFailure":
            return handleImportFailure(payload);

        case "Health":
        case "HealthIssue":
        case "HealthRestored":
        case "Test":
            return undefined;

        default:
            logger.debug(`   Unhandled event: ${eventType}`);
            return undefined;
    }
}

/**
 * Handle Grab event (download started by Lidarr).
 * Kicks the queue cleaner so the stuck-queue sweep notices the grab.
 */
async function handleGrab(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
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
    const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

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
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const albumTitle = payload.album?.title || payload.release?.title;
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
