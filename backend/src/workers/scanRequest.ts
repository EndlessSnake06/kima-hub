/**
 * Scan Request — the single producer for the library-scan queue.
 *
 * "one producer per queue": every code
 * path that wants the library scanned calls requestScan() instead of
 * touching scanQueue itself. Dedup: the dedupe key is the scan's scope
 * (download/album/import id, or "full" for unscoped requests), so a second
 * request for the same scope while one is still waiting, delayed, or
 * active is a no-op — the pending scan already covers it. A stale
 * completed/failed marker is replaced so a genuinely new request always
 * gets a run; nothing can be swallowed by a leftover jobId.
 *
 * Every scope is a full walk of the music path. The per-album fields only
 * carry download-accounting ids (the processor closes those jobs after the
 * walk); no code maps an album to a folder, so there is no narrower scan
 * to request.
 */

import type { Job } from "bullmq";
import { scanQueue } from "./queues";
import { config } from "../config";
import type { ScanJobData } from "./processors/scanProcessor";

export interface ScanRequest {
    userId?: string;
    /** What asked for this scan, e.g. "lidarr-webhook", "auto-sync". */
    source: string;
    /** Download/album/import ids to reconcile after the walk. */
    downloadId?: string;
    albumMbid?: string;
    artistMbid?: string;
    spotifyImportJobId?: string;
    discoveryBatchId?: string;
    /** BullMQ priority (lower runs sooner); default 2 (BullMQ default). */
    priority?: number;
    /** Prune the job once done; default follows the queue options. */
    removeOnComplete?: boolean;
}

export type ScanRequestResult =
    | { queued: true; jobId: string }
    /** Not enqueued as a new job, but `jobId` still resolves to the
     *  scan covering this scope (wait/delayed/active). */
    | { queued: false; jobId: string; reason: string };

const LIVE_STATES = new Set(["waiting", "delayed", "active", "paused", "prioritized", "created"]);

export function scanDedupeKey(req: ScanRequest): string {
    const scopeId =
        req.downloadId ??
        req.albumMbid ??
        req.artistMbid ??
        req.spotifyImportJobId ??
        req.discoveryBatchId;
    return scopeId ? `scan:${scopeId}` : "scan:full";
}

/**
 * Enqueue a library scan, deduplicated by scope. Returns queued:false with
 * a reason when an identical scan is already live; never throws on that
 * account, but queue-connection errors propagate.
 */
export async function requestScan(req: ScanRequest): Promise<ScanRequestResult> {
    const jobId = scanDedupeKey(req);

    const existing: Job | undefined = await scanQueue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (LIVE_STATES.has(state)) {
            return {
                queued: false,
                jobId,
                reason: `identical scan already ${state}`,
            };
        }
        // Stale completed/failed marker for this scope — a fresh request
        // means fresh work, so clear the marker and re-run. Without this,
        // BullMQ would dedupe against the old marker and silently swallow
        // every later request for the same id.
        await existing.remove();
    }

    const data: ScanJobData = {
        userId: req.userId,
        musicPath: config.music.musicPath,
        source: req.source,
        downloadId: req.downloadId,
        albumMbid: req.albumMbid,
        artistMbid: req.artistMbid,
        spotifyImportJobId: req.spotifyImportJobId,
        discoveryBatchId: req.discoveryBatchId,
    };

    await scanQueue.add("scan", data, {
        jobId,
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.removeOnComplete !== undefined
            ? { removeOnComplete: req.removeOnComplete }
            : {}),
    });
    return { queued: true, jobId };
}
