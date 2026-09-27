import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { eventBus } from "../services/eventBus";
import { triggerEnrichmentNow, settleStageDone, settleStageFailed } from "../workers/unifiedEnrichment";
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

// Redis queue key for audio analysis (Essentia uses raw Redis BRPOP, not BullMQ)
const ANALYSIS_QUEUE = "audio:analysis:queue";

/**
 * GET /api/analysis/status
 * Get audio analysis status and progress
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        // Get counts by status
        const statusCounts = await prisma.track.groupBy({
            by: ["analysisStatus"],
            _count: true,
        });

        const rawTotal = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const completed = statusCounts.find(s => s.analysisStatus === "completed")?._count || 0;
        const failed = statusCounts.find(s => s.analysisStatus === "failed")?._count || 0;
        const processing = statusCounts.find(s => s.analysisStatus === "processing")?._count || 0;
        const pending = statusCounts.find(s => s.analysisStatus === "pending")?._count || 0;
        const permanentlyFailed = statusCounts.find(s => s.analysisStatus === "permanently_failed")?._count || 0;

        // Exclude permanently_failed, corrupt and missing-file tracks from
        // the progress denominator: none of them can be analysed.
        const corruptCount = await prisma.track.count({ where: { corrupt: true, analysisStatus: { not: "permanently_failed" } } });
        const missingCount = await prisma.track.count({ where: { missingSince: { not: null }, analysisStatus: { not: "permanently_failed" } } });
        const total = rawTotal - permanentlyFailed - corruptCount - missingCount;

        // Get queue length from Redis
        const queueLength = await redisClient.llen(ANALYSIS_QUEUE);

        // Get CLAP embedding count
        const embeddingCount = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;
        const withEmbeddings = Number(embeddingCount[0]?.count || 0);

        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        res.json({
            total,
            completed,
            failed,
            permanentlyFailed,
            processing,
            pending,
            queueLength,
            progress,
            isComplete: pending === 0 && processing === 0 && queueLength === 0,
            clap: {
                withEmbeddings,
                embeddingProgress: total > 0 ? Math.round((withEmbeddings / total) * 100) : 0,
            },
        });
    } catch (error: any) {
        logger.error("Analysis status error:", error);
        res.status(500).json({ error: "Failed to get analysis status" });
    }
});

/**
 * POST /api/analysis/start
 * Start audio analysis for pending tracks (admin only)
 */
router.post("/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 100, priority = "recent" } = req.body;
        const capped = Math.min(limit, 1000);
        const order = priority === "recent"
            ? `t."fileModified" DESC`
            : `t.title ASC`;

        // The stage queue owns the feed, so this control brings it forward
        // instead of pushing: analysis records whose retry backoff or claim
        // lease has not elapsed are reopened (nextRetryAt = NULL) so the next
        // cycle offers them immediately, ordered per the request.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" ts
                SET "nextRetryAt" = NULL
               FROM "Track" t
              WHERE ts."trackId" = t.id
                AND ts.id IN (
                    SELECT ts2.id FROM "TrackStage" ts2
                    JOIN "Track" t2 ON ts2."trackId" = t2.id
                    WHERE ts2.stage = 'analysis'
                      AND ts2.status IN ('pending', 'failed', 'working')
                      AND ts2.retryable = true
                      AND ts2."nextRetryAt" IS NOT NULL
                      AND ts2."nextRetryAt" > now()
                    ORDER BY ${order}
                    LIMIT ${capped})`,
        );

        // Whatever is due right now is what the next cycle will hand out.
        const dueRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) FROM "TrackStage"
              WHERE stage = 'analysis'
                AND status IN ('pending', 'failed', 'working')
                AND retryable = true
                AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())`,
        );
        const queued = Number(dueRows[0]?.count ?? 0);

        if (queued === 0) {
            return res.json({
                message: "No pending tracks to analyze",
                queued: 0,
            });
        }

        logger.debug(`Analysis start: ${queued} analysis records due`);

        res.json({
            message: `${queued} tracks queued for analysis`,
            queued,
        });
    } catch (error: any) {
        logger.error("Analysis start error:", error);
        res.status(500).json({ error: "Failed to start analysis" });
    }
});

/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Reopen the analysis questions on the record: failed+retryable
        // records become immediately due, and terminal answers are wiped --
        // the operator explicitly re-decided them. The cycle's stage queue
        // is the only producer; it picks these up on its next pass.
        const failedResult = await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending', "nextRetryAt" = NULL, retryable = true,
                    "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
                    "failureClass" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
                    evidence = jsonb_build_object('reopenedBy', 'retry-failed')
              WHERE stage = 'analysis' AND status = 'failed'`,
        );
        const permFailedResult = await prisma.$executeRawUnsafe(
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
 * POST /api/analysis/analyze/:trackId
 * Queue a specific track for analysis
 */
router.post("/analyze/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                filePath: true,
                duration: true,
                analysisStatus: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Don't disturb an attempt the stage queue has already claimed.
        const inFlight = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
            `SELECT status FROM "TrackStage"
              WHERE "trackId" = $1 AND stage = 'analysis' AND status = 'working'`,
            trackId,
        );
        if (inFlight.length > 0) {
            return res.json({
                message: "Track is already being analyzed",
                trackId,
            });
        }

        // Reopen the question on the record (a pending record with a null
        // nextRetryAt is immediately due) and mirror it on the columns the
        // analyzer claims and the UI reads. Reopen, not delete: the attempt
        // history survives the ask. The cycle's stage queue is the only
        // producer; it picks this up on its next pass, so there is nothing
        // to push here.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
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
              WHERE "trackId" = $1 AND stage = 'analysis'`,
            trackId,
        );
        await prisma.track.update({
            where: { id: trackId },
            data: {
                analysisStatus: "pending",
                // An explicit request to analyze this track is a request to start over.
                // Left alone, a count already at the ceiling would brand the retry
                // before the analyzer ever reached it.
                analysisRetryCount: 0,
                analysisError: null,
                analysisStartedAt: null,
            },
        });

        res.json({
            message: "Track queued for analysis",
            trackId,
        });
    } catch (error: any) {
        logger.error("Analyze track error:", error);
        res.status(500).json({ error: "Failed to queue track for analysis" });
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
 * GET /api/analysis/features
 * Get aggregated feature statistics for the library
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        // Get analyzed tracks
        const analyzed = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                bpm: { not: null },
            },
            select: {
                bpm: true,
                energy: true,
                danceability: true,
                valence: true,
                keyScale: true,
            },
        });

        if (analyzed.length === 0) {
            return res.json({
                count: 0,
                averages: null,
                distributions: null,
            });
        }

        // Calculate averages
        const avgBpm = analyzed.reduce((sum, t) => sum + (t.bpm || 0), 0) / analyzed.length;
        const avgEnergy = analyzed.reduce((sum, t) => sum + (t.energy || 0), 0) / analyzed.length;
        const avgDanceability = analyzed.reduce((sum, t) => sum + (t.danceability || 0), 0) / analyzed.length;
        const avgValence = analyzed.reduce((sum, t) => sum + (t.valence || 0), 0) / analyzed.length;

        // Key distribution
        const majorCount = analyzed.filter(t => t.keyScale === "major").length;
        const minorCount = analyzed.filter(t => t.keyScale === "minor").length;

        // BPM distribution (buckets)
        const bpmBuckets = {
            slow: analyzed.filter(t => (t.bpm || 0) < 90).length,
            moderate: analyzed.filter(t => (t.bpm || 0) >= 90 && (t.bpm || 0) < 120).length,
            upbeat: analyzed.filter(t => (t.bpm || 0) >= 120 && (t.bpm || 0) < 150).length,
            fast: analyzed.filter(t => (t.bpm || 0) >= 150).length,
        };

        res.json({
            count: analyzed.length,
            averages: {
                bpm: Math.round(avgBpm),
                energy: Math.round(avgEnergy * 100) / 100,
                danceability: Math.round(avgDanceability * 100) / 100,
                valence: Math.round(avgValence * 100) / 100,
            },
            distributions: {
                key: { major: majorCount, minor: minorCount },
                bpm: bpmBuckets,
            },
        });
    } catch (error: any) {
        logger.error("Get features error:", error);
        res.status(500).json({ error: "Failed to get feature statistics" });
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

        // Settle the embedding stage record with the failure the CLAP worker
        // reported: retryable with the standard backoff, so the stage queue
        // re-asks it instead of the claim's lease silently re-offering an
        // unanswered question.
        await settleStageFailed(trackId, "embedding", {
            errorCode: errorCode || null,
            errorMessage: errorMessage || "Vibe embedding generation failed",
            failureClass: "INCONCLUSIVE",
            retryable: true,
            evidence: { error: errorMessage || "Vibe embedding generation failed", trackName },
        });

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
 * POST /api/analysis/vibe/retry
 * Retry failed vibe embeddings (admin only)
 */
router.post("/vibe/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Get all vibe failures. Embedding failures live in TrackStage (the
        // record the queue decides from); the service maps them onto the
        // EnrichmentFailure shape, so the ids below are stage-record ids and
        // resetRetryCount clears their attempt budget.
        const { failures } = await enrichmentFailureService.getFailures({
            entityType: "vibe",
            includeSkipped: false,
            includeResolved: false,
        });

        if (failures.length === 0) {
            return res.json({
                message: "No vibe failures to retry",
                queued: 0,
            });
        }

        // Get track details for failed tracks
        const trackIds = failures.map(f => f.entityId);

        // Reset Track-level retry counts so the UI shows them as owed again
        await prisma.track.updateMany({
            where: { id: { in: trackIds } },
            data: { vibeAnalysisStatus: null, vibeAnalysisRetryCount: 0, vibeAnalysisStatusUpdatedAt: null },
        });

        // Reopen the embedding questions: a pending record is immediately
        // due, and the cycle's executeVibePhase is the only producer.
        // Reopen, not delete — the attempt history survives the ask.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
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
              WHERE stage = 'embedding' AND "trackId" = ANY($1)`,
            trackIds,
        );

        // Reset the stage records' retry budget (attempt = 0), mirroring the
        // ledger reset the old EnrichmentFailure ids used to get.
        await enrichmentFailureService.resetRetryCount(failures.map(f => f.id));

        // Restart the enrichment cycle so executeVibePhase feeds the queue
        await triggerEnrichmentNow();

        logger.info(`Retrying ${trackIds.length} failed vibe embeddings`);

        res.json({
            message: `Queued ${trackIds.length} failed tracks for vibe embedding retry`,
            queued: trackIds.length,
        });
    } catch (error: any) {
        logger.error("Retry vibe failures error:", error);
        res.status(500).json({ error: "Failed to retry vibe failures" });
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
        // record, and settleStageDone below answers it done — a
        // failed embedding simply disappears from the TrackStage-backed
        // failures list. Writing a second record was the drift this defect
        // removes.

        // Settle the embedding stage record: the CLAP worker landed the
        // embedding, so the question is answered done.
        await settleStageDone(trackId, "embedding", {
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
