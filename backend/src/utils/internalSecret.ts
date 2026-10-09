/**
 * The secret the analyzers send with their reports. Each server makes its own at random and keeps it in
 * Redis, which the backend and the analyzers already share, so no install runs with a value anyone knows.
 * Whichever side needs it first makes it; a Redis that lost it gets a new one the same way.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { redisClient } from "./redis";

export const INTERNAL_SECRET_KEY = "kima:internal-secret";

export async function internalSecret(): Promise<string> {
    await redisClient.set(INTERNAL_SECRET_KEY, randomBytes(32).toString("hex"), "NX");
    const stored = await redisClient.get(INTERNAL_SECRET_KEY);
    if (!stored) throw new Error("internal secret missing from Redis");
    return stored;
}

/** Whether a report carries this server's secret, compared in constant time. */
export async function isInternalSecret(value: unknown): Promise<boolean> {
    if (typeof value !== "string" || value.length === 0) return false;
    const given = Buffer.from(value);
    const wanted = Buffer.from(await internalSecret());
    return given.length === wanted.length && timingSafeEqual(given, wanted);
}
