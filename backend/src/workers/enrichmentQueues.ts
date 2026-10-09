import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

function getConnectionOptions(): ConnectionOptions {
    const url = new URL(config.redisUrl);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 6379,
        password: url.password || undefined,
        maxRetriesPerRequest: null, // Required by BullMQ
        enableReadyCheck: false,
    };
}

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
    connection: getConnectionOptions(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

// One delivery per job: the stage record runs the retries.
export const trackQueue = new Queue(QUEUE_NAMES.TRACKS, {
    connection: getConnectionOptions(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

// Consumed by the CLAP analyzer. One delivery per job: the stage record runs the retries.
export const vibeQueue = new Queue(QUEUE_NAMES.VIBE, {
    connection: getConnectionOptions(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

export const podcastQueue = new Queue(QUEUE_NAMES.PODCASTS, {
    connection: getConnectionOptions(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// Factory for Worker connection options — each BullMQ Worker must have its own connection
export function createWorkerConnection(): ConnectionOptions {
    return getConnectionOptions();
}

export async function closeEnrichmentQueues(): Promise<void> {
    await Promise.all([
        artistQueue.close(),
        trackQueue.close(),
        vibeQueue.close(),
        podcastQueue.close(),
    ]);
}
