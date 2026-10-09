import { Queue } from "bullmq";
import { queueConnection } from "./queueConnection";

// Queue names — BullMQ v5 forbids colons; use hyphens instead
export const QUEUE_NAMES = {
    ARTISTS: "enrichment-artists",
    TRACKS: "enrichment-tracks",
    VIBE: "enrichment-vibe",
    PODCASTS: "enrichment-podcasts",
} as const;

const DEFAULT_JOB_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
};

// One delivery per job: the artist's own failure count and the cycle's re-queue run the retries.
export const artistQueue = new Queue(QUEUE_NAMES.ARTISTS, {
    connection: queueConnection(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

// One delivery per job: the stage record runs the retries.
export const trackQueue = new Queue(QUEUE_NAMES.TRACKS, {
    connection: queueConnection(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

// Consumed by the CLAP analyzer. One delivery per job: the stage record runs the retries.
export const vibeQueue = new Queue(QUEUE_NAMES.VIBE, {
    connection: queueConnection(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

export const podcastQueue = new Queue(QUEUE_NAMES.PODCASTS, {
    connection: queueConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// Factory for Worker connection options — each BullMQ Worker must have its own connection
export function createWorkerConnection() {
    return queueConnection();
}

export async function closeEnrichmentQueues(): Promise<void> {
    await Promise.all([
        artistQueue.close(),
        trackQueue.close(),
        vibeQueue.close(),
        podcastQueue.close(),
    ]);
}
