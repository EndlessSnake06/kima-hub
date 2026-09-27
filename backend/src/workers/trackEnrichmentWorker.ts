import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import {
    enrichSingleTrack,
    recordStageFailure,
} from "./unifiedEnrichment";
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
            // `enrichSingleTrack` answers the question AND settles the
            // stage record itself: identified → done, "sources have
            // nothing" → absent (done), a source failure → recorded with
            // its real cause, a paused source → left pending. Settling
            // again here from `enrichmentTags` was a second writer with
            // different semantics; the record would flip to a fresh
            // retryable failure instead of keeping the truthful answer.
            const outcome = await enrichSingleTrack(trackId);
            logger.debug(`[TrackWorker] ${trackId}: recording question settled (${outcome})`);
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
            // The stage record owns the attempt: the record's ladder (one
            // rung per dispatch, closed at the cap) decides when this
            // question stops being re-asked — a hardcoded `retryable:
            // true` would re-offer a dead question forever. This is also
            // the ONLY record of this failure: the failures API reads
            // TrackStage for track stages (two ledgers for one fact
            // drifted apart until one was superseded — migration
            // 20260926150000).
            await recordStageFailure(
                trackId,
                "recording",
                "worker",
                err,
                { queueJobId: job.id, attemptsMade: job.attemptsMade },
            ).catch(() => {});
        }
    });

    worker.on("error", (err) => logger.error(`[TrackWorker] Error: ${err.message}`));
    logger.info(`[TrackWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
