/**
 * Every queue and its worker read REDIS_URL the same way, database number
 * included, so a job is queued where its worker listens: here the test worker's
 * own Redis database, set by the test setup. Credentials are unescaped and
 * rediss:// turns TLS on.
 */

import { config } from "../../config";
import { queueConnection } from "../queueConnection";
import { scanQueue } from "../queues";
import { artistQueue, createWorkerConnection } from "../enrichmentQueues";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

afterAll(async () => {
    await closeEngineConnections();
});

it("puts every queue and worker on the database REDIS_URL names", () => {
    const db = Number(new URL(config.redisUrl).pathname.slice(1));
    expect(db).toBeGreaterThan(0);
    expect((scanQueue.opts.connection as { db?: number }).db).toBe(db);
    expect((artistQueue.opts.connection as { db?: number }).db).toBe(db);
    expect((createWorkerConnection() as { db?: number }).db).toBe(db);
});

it("reads credentials, database and TLS from the address", () => {
    const original = config.redisUrl;
    try {
        config.redisUrl = "rediss://kima:p%40ss@redis.example:6380/2";
        expect(queueConnection()).toMatchObject({
            host: "redis.example",
            port: 6380,
            username: "kima",
            password: "p@ss",
            db: 2,
            tls: {},
        });
        config.redisUrl = "redis://[::1]:6379/3";
        expect(queueConnection()).toMatchObject({ host: "::1", port: 6379, db: 3 });
        config.redisUrl = "redis://redis:6379";
        expect(queueConnection()).toMatchObject({ host: "redis", port: 6379, username: undefined, password: undefined, db: 0 });
        expect(queueConnection()).not.toHaveProperty("tls");
    } finally {
        config.redisUrl = original;
    }
});
