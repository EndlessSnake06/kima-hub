/**
 * The one place Kima removes a download from Lidarr's queue. Each download id is
 * removed at most once, and only downloads belonging to a Kima job are swept.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lidarrService } from "./lidarr";
import { simpleDownloadManager } from "./simpleDownloadManager";
import type { LidarrQueueItem } from "../types/lidarr";

const FAILED_IMPORT_PATTERNS = [
    "No files found are eligible for import",
    "Not an upgrade for existing",
    "Not a Custom Format upgrade",
    "missing tracks",
    "Album match is not close enough",
    "Artist name mismatch",
    "automatic import is not possible",
    "Unable to extract",
    "Failed to extract",
    "Unpacking failed",
    "unpack error",
    "Error extracting",
    "extraction failed",
    "corrupt archive",
    "invalid archive",
    "CRC failed",
    "bad archive",
    "Download failed",
    "import failed",
    "Sample",
].map((p) => p.toLowerCase());

/** Why a queue item will not finish on its own, or null while it still might. */
export function failureReason(item: LidarrQueueItem): string | null {
    if (item.trackedDownloadState === "importFailed") return "Import failed";
    const message = (item.statusMessages ?? [])
        .flatMap((sm) => sm.messages)
        .find((m) => FAILED_IMPORT_PATTERNS.some((p) => m.toLowerCase().includes(p)));
    if (message) return message;
    if (item.trackedDownloadStatus === "warning" && item.trackedDownloadState === "importPending") {
        return "Import blocked";
    }
    return null;
}

/**
 * Blocklist a download's release and remove it from Lidarr; with searchAgain Lidarr
 * then looks for another release. False when already removed or Lidarr refused.
 */
export async function removeFailedDownload(
    downloadId: string,
    reason: string,
    opts: { searchAgain: boolean; item?: { id: number; title?: string } }
): Promise<boolean> {
    const claim = await prisma.handledDownload.createMany({
        data: [{ downloadId, reason }],
        skipDuplicates: true,
    });
    if (claim.count === 0) return false;

    let removed = false;
    try {
        const target =
            opts.item ?? (await lidarrService.getQueueItems()).find((q) => q.downloadId === downloadId);
        removed = target
            ? await lidarrService.removeItemAndBlocklist(target, { skipRedownload: !opts.searchAgain })
            : true;
    } catch (error: any) {
        logger.warn(`[LIDARR] Could not remove download ${downloadId}: ${error.message}`);
    }
    if (!removed) {
        await prisma.handledDownload.deleteMany({ where: { downloadId } });
    }
    return removed;
}

async function ownedDownloadIds(): Promise<Set<string>> {
    const jobs = await prisma.downloadJob.findMany({
        where: { status: "processing" },
        select: { lidarrRef: true, metadata: true },
    });
    const ids = new Set<string>();
    for (const job of jobs) {
        if (job.lidarrRef) ids.add(job.lidarrRef);
        for (const id of ((job.metadata as any)?.previousDownloadIds ?? []) as string[]) ids.add(id);
    }
    return ids;
}

/** Remove Kima's failed downloads from the queue and count each against its job. */
export async function sweepFailedDownloads(): Promise<{ removed: number }> {
    const owned = await ownedDownloadIds();
    if (owned.size === 0) return { removed: 0 };

    let removed = 0;
    for (const item of await lidarrService.getQueueItems()) {
        if (!owned.has(item.downloadId)) continue;
        const reason = failureReason(item);
        if (!reason) continue;
        if (await removeFailedDownload(item.downloadId, reason, { searchAgain: true, item })) {
            removed++;
            await simpleDownloadManager.onImportFailed(item.downloadId, reason);
        }
    }
    return { removed };
}
