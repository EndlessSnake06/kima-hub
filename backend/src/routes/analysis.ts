import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { eventBus } from "../services/eventBus";
import { triggerEnrichmentNow, recordStageSuccess, recordStageFailure } from "../workers/unifiedEnrichment";
import { appendTrackToProjection } from "../services/umapProjection";
import os from "os";

/**
 * Is the analyzer that owns this control channel actually running?
 *
 * Both Python analyzers write a millisecond timestamp to a Redis key every
 * thirty seconds while they are alive; featureDetection already reads the same
 * keys to decide whether a feature is available. Reusing them here is what
 * lets the settings screen say "the analyzer is offline" instead of accepting
 * a worker count and reporting success to nobody.
 *
 * A stale key counts as offline. The window is generous -- ten heartbeats --
 * because a busy analyzer running CLAP inference can be slow to loop.
 */
const ANALYZER_HEARTBEAT_TTL_MS = 300_000; // 5 minutes

async function analyzerIsOnline(heartbeatKey: string): Promise<boolean> {
    try {
        const beat = await redisClient.get(heartbeatKey);
        if (!beat) return false;
        const at = parseInt(beat, 10);
        return !isNaN(at) && Date.now() - at < ANALYZER_HEARTBEAT_TTL_MS;
    } catch {
        // Redis being unreachable is not evidence the analyzer is up.
        return false;
    }
}

/**
 * Send a worker-count change and report honestly what happened to it.
 *
 * Redis PUBLISH returns how many subscribers received the message. Every one
 * of these endpoints used to discard that number and answer 200 regardless, so
 * an admin moving the slider with no analyzer running was told it had worked.
 * The count is the only delivery evidence available, so it is passed on.
 */
/**
 * The sentence the settings screen shows under the slider.
 *
 * It used to always read "Using N of M available CPU cores" whether or not any
 * analyzer existed, which is the whole reason the control looked functional
 * while doing nothing.
 */
function describeWorkers(
    workers: number,
    cpuCores: number,
    online: boolean,
    delivered: number,
): string {
    if (delivered > 0) {
        return `Using ${workers} of ${cpuCores} available CPU cores`;
    }
    if (online) {
        return `Saved. The analyzer is running but did not acknowledge the change; it will use ${workers} core(s) after its next restart.`;
    }
    return `Saved, but no analyzer is running. It will use ${workers} of ${cpuCores} core(s) when it starts.`;
}

async function dispatchWorkerCount(
    channel: string,
    heartbeatKey: string,
    workers: number,
): Promise<{ online: boolean; delivered: number }> {
    const delivered = await redisClient.publish(
        channel,
        JSON.stringify({ command: "set_workers", count: workers }),
    );
    const online = await analyzerIsOnline(heartbeatKey);
    if (delivered === 0) {
        logger.warn(
            `[Analysis] set_workers=${workers} published to ${channel} but no analyzer received it`,
        );
    }
    return { online, delivered };
}

const router = Router();

/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Reopen the analysis questions on the record: failed+retryable
        // records become immediately due, and records whose ladder is
        // spent (retryable = false) are re-opened with a fresh budget —
        // the operator explicitly re-decided them. The first UPDATE must
        // skip the spent rows or the second one would never match
        // anything, and spent records would restart with their budget
        // already consumed.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending', "nextRetryAt" = NULL, retryable = true,
                    "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
                    "failureClass" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
                    evidence = jsonb_build_object('reopenedBy', 'retry-failed')
              WHERE stage = 'analysis' AND status = 'failed' AND retryable = true`,
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending', attempt = 0, "nextRetryAt" = NULL, retryable = true,
                    "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
                    "failureClass" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
                    evidence = jsonb_build_object('reopenedBy', 'retry-failed')
              WHERE stage = 'analysis' AND status = 'failed' AND retryable = false`,
        );

        // Mirror the re-ask on the columns the analyzer claims and the UI
        // reads, so record and columns agree while the retry runs.
        const failedTracks = await prisma.track.updateMany({
            where: { analysisStatus: "failed" },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                scanStatus: "pending",
            },
        });

        const permFailedTracks = await prisma.track.updateMany({
            where: { analysisStatus: "permanently_failed" },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                scanStatus: "pending",
            },
        });

        // Mark related enrichment failures as resolved
        await prisma.enrichmentFailure.updateMany({
            where: {
                entityType: "audio",
                resolved: false,
            },
            data: {
                resolved: true,
                resolvedAt: new Date(),
            },
        });

        const totalReset = failedTracks.count + permFailedTracks.count;
        res.json({
            message: `Reset ${totalReset} failed tracks to pending`,
            reset: totalReset,
            failed: failedTracks.count,
            permanentlyFailed: permFailedTracks.count,
        });
    } catch (error: any) {
        logger.error("Retry failed error:", error);
        res.status(500).json({ error: "Failed to retry analysis" });
    }
});


/**
 * GET /api/analysis/track/:trackId
 * Get analysis data for a specific track
 */
router.get("/track/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                title: true,
                analysisStatus: true,
                analysisError: true,
                analyzedAt: true,
                analysisVersion: true,
                analysisMode: true,
                bpm: true,
                beatsCount: true,
                key: true,
                keyScale: true,
                keyStrength: true,
                energy: true,
                loudness: true,
                dynamicRange: true,
                danceability: true,
                valence: true,
                arousal: true,
                instrumentalness: true,
                acousticness: true,
                // MusiCNN mood predictions
                moodHappy: true,
                moodSad: true,
                moodRelaxed: true,
                moodAggressive: true,
                moodParty: true,
                moodAcoustic: true,
                moodElectronic: true,
                moodTags: true,
                essentiaGenres: true,
                enrichmentTags: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        res.json(track);
    } catch (error: any) {
        logger.error("Get track analysis error:", error);
        res.status(500).json({ error: "Failed to get track analysis" });
    }
});


/**
 * GET /api/analysis/workers
 * Get current audio analyzer worker configuration
 */
router.get("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.audioAnalyzerWorkers || 2;
        const online = await analyzerIsOnline("audio:worker:heartbeat");

        // Recommended: 50% of CPU cores, min 2, max 8
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            description: describeWorkers(currentWorkers, cpuCores, online, online ? 1 : 0),
        });
    } catch (error: any) {
        logger.error("Get workers config error:", error);
        res.status(500).json({ error: "Failed to get worker configuration" });
    }
});

/**
 * PUT /api/analysis/workers
 * Update audio analyzer worker count
 */
router.put("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;
        
        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({ 
                error: "Workers must be a number between 1 and 8" 
            });
        }
        
        // Update SystemSettings
        // upsert, not update: SystemSettings has no row until something writes
        // one, so on a fresh install `update` threw and the endpoint answered
        // 500 -- the worker count could never be changed on a new deployment.
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", audioAnalyzerWorkers: workers },
            update: { audioAnalyzerWorkers: workers },
        });
        invalidateSystemSettingsCache();

        const { online, delivered } = await dispatchWorkerCount(
            "audio:analysis:control",
            "audio:worker:heartbeat",
            workers,
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(
            `Audio analyzer workers set to ${workers} (delivered to ${delivered} listener(s))`,
        );

        res.json({
            workers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            delivered,
            description: describeWorkers(workers, cpuCores, online, delivered),
        });
    } catch (error: any) {
        logger.error("Update workers config error:", error);
        res.status(500).json({ error: "Failed to update worker configuration" });
    }
});

/**
 * GET /api/analysis/clap-workers
 * Get current CLAP analyzer worker configuration
 */
router.get("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.clapWorkers || 2;
        const online = await analyzerIsOnline("clap:worker:heartbeat");

        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            description: describeWorkers(currentWorkers, cpuCores, online, online ? 1 : 0),
        });
    } catch (error: any) {
        logger.error("Get CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to get CLAP worker configuration" });
    }
});

/**
 * PUT /api/analysis/clap-workers
 * Update CLAP analyzer worker count
 */
router.put("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;

        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({
                error: "CLAP workers must be a number between 1 and 8"
            });
        }

        // Update SystemSettings
        // upsert, not update: SystemSettings has no row until something writes
        // one, so on a fresh install `update` threw and the endpoint answered
        // 500 -- the worker count could never be changed on a new deployment.
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", clapWorkers: workers },
            update: { clapWorkers: workers },
        });
        invalidateSystemSettingsCache();

        const { online, delivered } = await dispatchWorkerCount(
            "audio:clap:control",
            "clap:worker:heartbeat",
            workers,
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(
            `CLAP analyzer workers set to ${workers} (delivered to ${delivered} listener(s))`,
        );

        res.json({
            workers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            delivered,
            description: describeWorkers(workers, cpuCores, online, delivered),
        });
    } catch (error: any) {
        logger.error("Update CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to update CLAP worker configuration" });
    }
});

/**
 * POST /api/analysis/vibe/failure
 * Record a vibe embedding failure (called by CLAP analyzer)
 */
router.post("/vibe/failure", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (!process.env.INTERNAL_API_SECRET || internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // The stage record is the ONLY record of this failure:
        // the failures API reads TrackStage for track stages, so no second
        // EnrichmentFailure write happens here — two ledgers for one fact
        // drifted apart until one was superseded.

        // Record the failure the CLAP worker reported on the stage
        // record's own ladder: the error is classified, the attempt that
        // was dispatched is consumed once, and the record closes when the
        // ladder runs out — a reported failure that stays `retryable:
        // true` forever re-asks a dead question every cycle.
        await recordStageFailure(
            trackId,
            "embedding",
            "clap",
            new Error(errorMessage || "Vibe embedding generation failed"),
            { reportedCode: errorCode, trackName },
        );

        res.json({ message: "Failure recorded" });
        eventBus.emit({ type: "enrichment:progress", userId: "*", payload: { phase: "vibe" } });
    } catch (error: any) {
        logger.error("Record vibe failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * POST /api/analysis/vibe/start
 * Queue tracks for vibe embedding generation (admin only)
 *
 * @param force - If true, delete all embeddings and re-queue all tracks
 */
router.post("/vibe/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 500, force = false } = req.body;

        if (force) {
            // Force = "re-decide everything the vibe engine ever answered".
            // Step 2's rule: re-asking must never delete the data first.
            // The existing embeddings stay readable — the vibe map keeps
            // working while the rebuild runs — and the embedding worker
            // OVERWRITES each track's row as its new embedding lands. So
            // the only thing force does is re-open every embedding
            // question (the same reopen `redecideEverything` performs):
            // the embedding rows are not removed, no failure clearing, no
            // status nulling, no record deletion. A record saying `done`
            // would keep the stage queue from ever re-asking; a `pending`
            // one with the old answer still on disk asks again while
            // nothing is lost.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage"
                    SET status = 'pending',
                        attempt = 0,
                        "lastErrorCode" = NULL,
                        "lastErrorMessage" = NULL,
                        "failureClass" = NULL,
                        retryable = true,
                        "nextRetryAt" = NULL,
                        "startedAt" = NULL,
                        "finishedAt" = NULL,
                        "decidedAt" = NULL,
                        "decidedBy" = NULL
                  WHERE stage = 'embedding'`,
            );
            logger.info(
                "Re-opened every vibe embedding question for re-generation (existing embeddings stay readable until each is overwritten)",
            );
        } else {
            // Reopen the embedding questions for analysed tracks whose row is
            // missing, so the stage queue (the only producer) offers them.
            // Gating reads the analysis RECORD, not the status column.
            // Reopen, not delete: "ask again" is a pending record, and the
            // attempt history survives the ask.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage" ts
                    SET status = 'pending',
                        "lastErrorCode" = NULL,
                        "lastErrorMessage" = NULL,
                        "failureClass" = NULL,
                        retryable = true,
                        "nextRetryAt" = NULL,
                        "startedAt" = NULL,
                        "finishedAt" = NULL,
                        "decidedAt" = NULL,
                        "decidedBy" = NULL
                   FROM "TrackStage" a, "Track" t
                  WHERE ts.stage = 'embedding'
                    AND a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                    AND t.id = ts."trackId"
                    AND ts.status <> 'pending'
                    AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId")
                    ${limit ? `AND ts.ctid IN (
                        SELECT ts2.ctid FROM "TrackStage" ts2
                        JOIN "TrackStage" a2 ON a2."trackId" = ts2."trackId" AND a2.stage = 'analysis' AND a2.status = 'done'
                        WHERE ts2.stage = 'embedding'
                          AND ts2.status <> 'pending'
                          AND NOT EXISTS (SELECT 1 FROM track_embeddings te2 WHERE te2.track_id = ts2."trackId")
                        LIMIT ${Math.min(Number(limit) || 500, 10000)})` : ""}`,
            );
        }

        // Count what is now owed: an analysis-done track whose embedding
        // question is open. After a force re-decide the answers still exist
        // (they are being REPLACED, not deleted), so the NOT EXISTS filter
        // that counts only missing answers must not apply — the reopened
        // questions are owed precisely because they were re-opened.
        const owedRows = force
            ? await prisma.$queryRaw<Array<{ count: bigint }>>`
                  SELECT count(*) FROM "TrackStage" ts
                  JOIN "TrackStage" a ON a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                  WHERE ts.stage = 'embedding'
                    AND ts.status IN ('pending', 'failed', 'working')
                    AND ts.retryable = true
                    AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= now())
              `
            : await prisma.$queryRaw<Array<{ count: bigint }>>`
                  SELECT count(*) FROM "TrackStage" ts
                  JOIN "TrackStage" a ON a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                  WHERE ts.stage = 'embedding'
                    AND ts.status IN ('pending', 'failed', 'working')
                    AND ts.retryable = true
                    AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= now())
                    AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId")
              `;
        const queued = Number(owedRows[0]?.count ?? 0);

        if (queued === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // Restart the enrichment cycle so executeVibePhase feeds the queue
        await triggerEnrichmentNow();

        logger.info(`${queued} tracks owed vibe embedding${force ? " (force reset)" : ""}`);

        res.json({
            message: `Queued ${queued} tracks for vibe embedding`,
            queued,
        });
    } catch (error: any) {
        logger.error("Start vibe embedding error:", error);
        res.status(500).json({ error: "Failed to start vibe embedding" });
    }
});


/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (!process.env.INTERNAL_API_SECRET || internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // No ledger resolve here: the embedding stage record IS the failure
        // record, and the CLAP worker's success answers it —
        // a failed embedding simply disappears from the TrackStage-backed
        // failures list. Writing a second record was the drift this defect
        // removes.
        await recordStageSuccess(trackId, "embedding", "clap", {
            outcome: "embedded",
        });

        // Incrementally add to vibe map projection (non-blocking)
        appendTrackToProjection(trackId).catch(e =>
            logger.debug(`[VIBE-MAP] Incremental append skipped for ${trackId}:`, (e as Error).message)
        );

        res.json({ message: "Stale failures resolved" });
        eventBus.emit({ type: "enrichment:progress", userId: "*", payload: { phase: "vibe" } });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

export default router;
