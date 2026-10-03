import Redis from "ioredis";
import { vibeQueue } from "./enrichmentQueues";
import { prisma } from "../utils/db";
import { config } from "../config";
import { logger } from "../utils/logger";
import { recordStageFailure, recordStageSuccess } from "./unifiedEnrichment";

const CHANNEL = "audio:analysis:complete";
// Resume vibe embeddings after this many ms of Essentia silence.
// Keeps both ML models from loading simultaneously on low-RAM hosts.
const ESSENTIA_QUIET_MS = 30_000;

interface AudioCompletionEvent {
    trackId: string;
    filePath: string;
    status: string;
    /** Present when status is "failed": the analyzer's report of the error. */
    error?: string;
}

let subscriber: Redis | null = null;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let vibePaused = false;
let enrichmentHalted = false;

function pauseVibe(): void {
    if (!vibePaused) {
        vibePaused = true;
        vibeQueue.pause().catch((err: Error) => {
            logger.warn(`[AudioSub] Failed to pause vibe queue: ${err.message}`);
        });
        logger.debug("[AudioSub] Vibe queue paused (Essentia active)");
    }
}

function scheduleVibeResume(): void {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(async () => {
        quietTimer = null;
        // Only resume if audio analysis is truly idle -- not just between batches
        const audioRemaining = await prisma.track.count({
            where: { analysisStatus: { in: ["processing", "pending"] } },
        }).catch(() => 0);
        if (audioRemaining > 0) {
            logger.debug(`[AudioSub] ${audioRemaining} audio tracks still pending/processing, deferring vibe resume`);
            return;
        }
        vibePaused = false;
        vibeQueue.resume().catch((err: Error) => {
            logger.warn(`[AudioSub] Failed to resume vibe queue: ${err.message}`);
        });
        logger.info("[AudioSub] Essentia idle — vibe queue resumed");
    }, ESSENTIA_QUIET_MS);
}

/**
 * Halt vibe queuing and pause the vibe queue. Called on stop/pause.
 * Tracks completing audio analysis after this point will NOT be queued for vibe.
 */
export function haltVibeQueuing(): void {
    enrichmentHalted = true;
    // Cancel any pending vibe resume timer
    if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
    }
    // Pause the vibe BullMQ queue so CLAP stops picking up jobs
    vibeQueue.pause().catch((err: Error) => {
        logger.warn(`[AudioSub] Failed to pause vibe queue on halt: ${err.message}`);
    });
    logger.debug("[AudioSub] Vibe queuing halted (enrichment stopped/paused)");
}

/**
 * Resume vibe queuing and unpause the vibe queue. Called on resume/re-run.
 */
export function resumeVibeQueuing(): void {
    enrichmentHalted = false;
    vibeQueue.resume().catch((err: Error) => {
        logger.warn(`[AudioSub] Failed to resume vibe queue: ${err.message}`);
    });
    logger.debug("[AudioSub] Vibe queuing resumed");
}

export async function startAudioCompletionSubscriber(): Promise<void> {
    // Only resume the vibe queue if no audio analysis is in progress.
    // If audio is running, the pauseVibe/scheduleVibeResume mechanism
    // will handle resuming after Essentia goes quiet.
    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    }).catch(() => 0);

    if (audioProcessing === 0) {
        vibeQueue.resume().catch((err: Error) => {
            logger.warn(`[AudioSub] Failed to resume vibe queue at startup: ${err.message}`);
        });
    } else {
        logger.debug(`[AudioSub] ${audioProcessing} tracks in audio processing, keeping vibe queue paused`);
    }

    subscriber = new Redis(config.redisUrl);

    subscriber.subscribe(CHANNEL, (err) => {
        if (err) {
            logger.error(`[AudioSub] Subscribe failed: ${err.message}`);
            return;
        }
        logger.info(`[AudioSub] Subscribed to ${CHANNEL}`);
    });

    subscriber.on("message", async (_channel, message) => {
        let event: AudioCompletionEvent;
        try {
            event = JSON.parse(message);
        } catch {
            logger.warn(`[AudioSub] Invalid message: ${message}`);
            return;
        }

        if (!event.trackId) return;

        // The analyzer writes no state; this event is its report, and the
        // stage record (and the status columns it mirrors) is settled here.
        if (event.status === "failed") {
            await recordStageFailure(
                event.trackId,
                "analysis",
                "analyzer",
                new Error(event.error ?? "analysis failed"),
                { reported: "audio:analysis:complete" },
            ).catch((err: Error) =>
                logger.warn(`[AudioSub] Failed to record analysis failure: ${err.message}`),
            );
            return;
        }
        if (event.status !== "complete") return;

        await recordStageSuccess(event.trackId, "analysis", "analyzer", {
            syncedFrom: "audio:analysis:complete",
            answer: "completed",
        }).catch((err: Error) =>
            logger.warn(`[AudioSub] Failed to record analysis success: ${err.message}`),
        );

        // Skip vibe queuing when enrichment is stopped/paused
        if (enrichmentHalted) return;

        // Gate CLAP behind Essentia: pause vibe queue while Essentia is active,
        // resume after ESSENTIA_QUIET_MS of silence. Prevents both ML models
        // from loading simultaneously on low-RAM hosts.
        pauseVibe();
        scheduleVibeResume();

        // Don't enqueue vibe jobs from here -- the executeVibePhase sweep
        // in unifiedEnrichment.ts handles batch queuing after audio is fully
        // idle. Enqueueing per-track here races with audio batches and causes
        // both ML models to compete for resources simultaneously.
    });

    subscriber.on("error", (err) => {
        logger.error(`[AudioSub] Redis error: ${err.message}`);
    });
}

export async function stopAudioCompletionSubscriber(): Promise<void> {
    enrichmentHalted = false;
    if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
    }
    if (subscriber) {
        await subscriber.unsubscribe(CHANNEL).catch(() => {});
        await subscriber.quit().catch(() => {});
        subscriber = null;
    }
    // Don't leave the vibe queue paused in Redis across restarts
    if (vibePaused) {
        vibePaused = false;
        await vibeQueue.resume().catch(() => {});
    }
}
