import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

/**
 * Connection settings for every BullMQ queue and worker, read from REDIS_URL as
 * the main Redis client reads it (database number, credentials, TLS), so a job
 * is queued on the same database its worker listens on.
 */
export function queueConnection(): ConnectionOptions {
    const url = new URL(config.redisUrl);
    return {
        host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: Number(url.port) || 6379,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: Number(url.pathname.slice(1)) || 0,
        ...(url.protocol === "rediss:" && { tls: {} }),
        maxRetriesPerRequest: null, // required by BullMQ
        enableReadyCheck: false,
    };
}
