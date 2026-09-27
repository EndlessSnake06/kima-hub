import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { enrichSingleTrack, settleStageDone, settleStageFailed } from "./unifiedEnrichment";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

interface TrackJobData {
    trackId: string;
    trackTitle: string;
}

export async function startTrackEnrichmentWorker(): Promise<Worker> {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency ?? 5;

    const worker = new Worker<TrackJobData>(
        QUEUE_NAMES.TRACKS,
        async (job: Job<TrackJobData>) => {
            const { trackId, trackTitle } = job.data;
            logger.debug(`[TrackWorker] Processing ${trackId} (${trackTitle})`);
            const outcome = await enrichSingleTrack(trackId);

            if (outcome === "deferred") {
                // The question was parked by recordStageFailure (e.g. a
                // MusicBrainz rate limit): the record is pending until the
                // pause lifts. Settling here would clobber that truthful
                // state into a done/failed answer that was never given.
                logger.debug(
                    `[TrackWorker] ${trackId}: recording identity deferred (source paused or errored); record left as-is`,
                );
                return;
            }

            // Settle the recording stage record from the work's own output:
            // the `_not_found` sentinel means "asked, could not tell" (the
            // same verdict the migration seed gives it), anything else means
            // the recording was identified and the question is answered.
            const track = await prisma.track.findUnique({
                where: { id: trackId },
                select: { enrichmentTags: true },
            });
            if (track?.enrichmentTags?.includes("_not_found")) {
                await settleStageFailed(trackId, "recording", {
                    errorCode: "RECORDING_NOT_FOUND",
                    errorMessage: "No recording could be identified for this track",
                    failureClass: "INCONCLUSIVE",
                    retryable: true,
                    evidence: { outcome: "not_found" },
                });
            } else {
                await settleStageDone(trackId, "recording", {
                    outcome: "identified",
                });
            }
        },
        {
            connection: createWorkerConnection(),
            concurrency,
            lockDuration: 60000,
            stalledInterval: 30000,
            maxStalledCount: 2,
        },
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const { trackId, trackTitle } = job.data;

        if ((err as any).entityNotFound) {
            logger.info(`[TrackWorker] Track ${trackId} no longer exists, resolving silently`);
            return;
        }

        logger.error(`[TrackWorker] Track ${trackId} failed (attempt ${job.attemptsMade}): ${err.message}`);

        const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
        if (isFinalAttempt) {
            // The stage record owns the attempt: a settled failure is due
            // again after the backoff, so the queue itself re-picks this
            // track -- no sentinel juggling. It is also the ONLY record of
            // this failure: the failures API reads TrackStage for track
            // stages, so no second EnrichmentFailure write happens here
            // (two ledgers for one fact drifted apart until one was
            // superseded — migration 20260926150000).
            await settleStageFailed(trackId, "recording", {
                errorMessage: err.message,
                failureClass: "INCONCLUSIVE",
                retryable: true,
                evidence: { error: err.message },
            }).catch(() => {});
        }
    });

    worker.on("error", (err) => logger.error(`[TrackWorker] Error: ${err.message}`));
    logger.info(`[TrackWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
