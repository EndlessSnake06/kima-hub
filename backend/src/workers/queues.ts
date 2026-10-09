import { Queue } from "bullmq";
import { logger } from "../utils/logger";
import { queueConnection } from "./queueConnection";

const defaultJobOptions = {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
};

// v2 suffix avoids key conflict with old Bull v4 data still in Redis
export const scanQueue = new Queue("library-scan-v2", {
    connection: queueConnection(),
    defaultJobOptions,
});

export const discoverQueue = new Queue("discover-weekly-v2", {
    connection: queueConnection(),
    defaultJobOptions,
});

export const importQueue = new Queue("playlist-import", {
    connection: queueConnection(),
    defaultJobOptions: {
        ...defaultJobOptions,
        attempts: 1, // Import jobs should not auto-retry (downloads are not idempotent)
        removeOnComplete: { count: 50, age: 86400 },
        removeOnFail: { count: 50, age: 86400 },
    },
});

export const queues = [scanQueue, discoverQueue, importQueue];

logger.debug("BullMQ queues initialized (library-scan-v2, discover-weekly-v2, playlist-import)");
