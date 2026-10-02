/**
 * Similar-podcast lookups go through the iTunes limiter, which runs one request
 * at a time. A lookup that waits on the limiter from inside its own slot never
 * returns, so the limiter here enforces the same one-at-a-time rule.
 */

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
    },
}));

jest.mock("../../services/rateLimiter", () => {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        rateLimiter: {
            execute: (_key: string, fn: () => Promise<unknown>) => {
                const run = tail.then(fn);
                tail = run.catch(() => undefined);
                return run;
            },
        },
    };
});

const get = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: { create: () => ({ get }) },
}));

import { itunesService } from "../itunes";

const podcast = (id: number, name: string) => ({
    collectionId: id,
    collectionName: name,
    artistName: "Someone",
    feedUrl: `https://example.com/${id}.xml`,
    genres: [],
});

describe("itunesService.getSimilarPodcasts", () => {
    beforeEach(() => get.mockReset());

    it("returns under a one-at-a-time limiter and leaves out the original", async () => {
        get.mockResolvedValue({
            data: {
                results: [
                    podcast(1, "History Hour Extra"),
                    podcast(2, "Ancient Worlds"),
                    podcast(3, "Medieval Lives"),
                ],
            },
        });

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("similar lookup never returned")), 2000);
        });
        const found = await Promise.race([
            itunesService.getSimilarPodcasts("History Hour", "Stories from history", "BBC", 2),
            timeout,
        ]).finally(() => clearTimeout(timer));

        expect(found).toEqual([podcast(2, "Ancient Worlds"), podcast(3, "Medieval Lives")]);
        expect(get).toHaveBeenCalledTimes(1);
    });
});
