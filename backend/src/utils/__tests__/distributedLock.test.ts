/**
 * A held lock stays held while it is kept alive, and frees on its own once renewal stops,
 * so a process that dies mid-cycle cannot block the next one for long.
 */
import { distributedLock } from "../distributedLock";
import { redisClient } from "../redis";
import { closeClient } from "../closeRedisClient";

const KEY = "test:keepalive";

beforeAll(async () => {
    if (redisClient.status !== "ready") await new Promise((r) => redisClient.once("ready", r));
});

afterAll(async () => {
    await closeClient(redisClient);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("distributedLock.keepAlive", () => {
    it("keeps the lock past its expiry while renewed, and lets it expire once stopped", async () => {
        await redisClient.del(`lock:${KEY}`);
        expect(await distributedLock.acquire(KEY, 300)).toBe(true);
        const stop = distributedLock.keepAlive(KEY, 300);
        await wait(900);
        expect(await distributedLock.acquire(KEY, 300)).toBe(false);
        stop();
        await wait(450);
        expect(await distributedLock.acquire(KEY, 300)).toBe(true);
        await distributedLock.release(KEY);
    });

    it("does not renew a lock another holder took", async () => {
        await redisClient.set(`lock:${KEY}`, "someone-else", "PX", 300);
        const stop = distributedLock.keepAlive(KEY, 300);
        await wait(450);
        stop();
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });
});
