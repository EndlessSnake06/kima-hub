import Redis from "ioredis";
import { logger } from "./logger";
import { config } from "../config";

const redisClient = new Redis(config.redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 100, 3000),
});

redisClient.on("error", (err: Error) => {
    logger.error("  Redis error:", err.message);
});

redisClient.on("close", () => {
    logger.debug("  Redis disconnected - caching disabled");
});

redisClient.on("reconnecting", () => {
    logger.debug(" Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

/** How long Redis may take to connect at boot before the container fails, so a missing Redis does not hang a
 * deployment. */
const REDIS_READY_TIMEOUT_MS = 10_000;

/** Wait for Redis to reach "ready": it may still be starting alongside us. */
export async function waitForRedisReady(): Promise<void> {
    if (redisClient.status === "ready") return;

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    `Redis did not become ready within ${REDIS_READY_TIMEOUT_MS}ms ` +
                        `(last status: ${redisClient.status})`
                )
            );
        }, REDIS_READY_TIMEOUT_MS);

        const onReady = () => {
            cleanup();
            resolve();
        };
        // A connection error is not fatal on its own -- ioredis retries -- so it
        // is logged and the timeout above remains the decider.
        const onError = (err: Error) => {
            logger.debug(`Redis still connecting: ${err.message}`);
        };
        function cleanup() {
            clearTimeout(timer);
            redisClient.off("ready", onReady);
            redisClient.off("error", onError);
        }

        redisClient.on("ready", onReady);
        redisClient.on("error", onError);
    });
}

export { redisClient };
