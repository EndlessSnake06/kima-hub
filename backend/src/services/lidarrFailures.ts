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
].map((p) => p.toLowerCase());

const ALREADY_OWNED_PATTERNS = ["not an upgrade for existing", "not a custom format upgrade"];
const PARTIAL_IMPORT = "has missing tracks";
const PARTIAL_GRACE_MS = 15 * 60 * 1000;
const SINGLE_TRACK_POST = /\[\s*\d+\s*(?:\/|of|\+)\s*\d+\s*\]/i;

export type QueueVerdict = { action: "reject" | "owned" | "failed"; reason: string };

/**
 * What to do with a queue item: reject a single-track post (not an attempt),
 * close a job whose album the library already has, or count a real failure.
 * Null while the item may still finish, including a partial import's first 15 min.
 */
export function judgeQueueItem(item: LidarrQueueItem, now = Date.now()): QueueVerdict | null {
    if (SINGLE_TRACK_POST.test(item.title ?? "")) return { action: "reject", reason: "Single-track post" };

    const messages = (item.statusMessages ?? []).flatMap((sm) => sm.messages);
    const has = (patterns: string[]) =>
        messages.find((m) => patterns.some((p) => m.toLowerCase().includes(p)));

    const owned = has(ALREADY_OWNED_PATTERNS);
    if (owned) return { action: "owned", reason: owned };

    if (has([PARTIAL_IMPORT])) {
        const added = item.added ? Date.parse(item.added) : NaN;
        if (now - added < PARTIAL_GRACE_MS) return null;
        return { action: "failed", reason: "Has missing tracks" };
    }

    if (item.trackedDownloadState === "importFailed") return { action: "failed", reason: "Import failed" };
    const failed = has(FAILED_IMPORT_PATTERNS);
    if (failed) return { action: "failed", reason: failed };
    if (item.trackedDownloadStatus === "warning" && item.trackedDownloadState === "importPending") {
        return { action: "failed", reason: "Import blocked" };
    }
    return null;
}

/**
 * Remove a download from Lidarr, blocklisting its release unless told not to;
 * with searchAgain Lidarr looks for another. False when another caller already
 * removed it, it is not in the queue, or Lidarr refused.
 */
export async function removeFailedDownload(
    downloadId: string,
    reason: string,
    opts: { searchAgain: boolean; blocklist?: boolean; item?: { id: number; title?: string } }
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
        if (target) {
            removed = await lidarrService.removeQueueItem(target, {
                blocklist: opts.blocklist ?? true,
                skipRedownload: !opts.searchAgain,
            });
        }
    } catch (error: any) {
        logger.warn(`[LIDARR] Could not remove download ${downloadId}: ${error.message}`);
    }
    if (!removed) {
        await prisma.handledDownload.deleteMany({ where: { downloadId } });
    }
    return removed;
}

/** Turn a single-track post away as soon as Lidarr grabs it; the sweep retries later. */
export async function rejectSingleTrackPost(downloadId: string, releaseTitle?: string): Promise<boolean> {
    if (!releaseTitle || !SINGLE_TRACK_POST.test(releaseTitle)) return false;
    logger.debug(`[LIDARR] Rejecting single-track post: ${releaseTitle}`);
    await removeFailedDownload(downloadId, "Single-track post", { searchAgain: true });
    return true;
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

async function settle(item: LidarrQueueItem, verdict: QueueVerdict): Promise<boolean> {
    const { downloadId } = item;
    if (verdict.action === "reject") {
        return removeFailedDownload(downloadId, verdict.reason, { searchAgain: true, item });
    }
    if (verdict.action === "owned") {
        const removed = await removeFailedDownload(downloadId, verdict.reason, {
            searchAgain: false,
            blocklist: false,
            item,
        });
        if (removed) await simpleDownloadManager.onDownloadComplete(downloadId);
        return removed;
    }
    const { searchAgain } = await simpleDownloadManager.onImportFailed(downloadId, verdict.reason);
    return removeFailedDownload(downloadId, verdict.reason, { searchAgain, item });
}

/**
 * Settle each of Kima's stuck downloads. A real failure counts against its job
 * first, and Lidarr searches again only while the job is under its retry limit.
 */
export async function sweepFailedDownloads(): Promise<{ removed: number }> {
    const owned = await ownedDownloadIds();
    if (owned.size === 0) return { removed: 0 };

    let removed = 0;
    for (const item of await lidarrService.getQueueItems()) {
        if (!owned.has(item.downloadId)) continue;
        const verdict = judgeQueueItem(item);
        if (verdict && (await settle(item, verdict))) removed++;
    }
    return { removed };
}
