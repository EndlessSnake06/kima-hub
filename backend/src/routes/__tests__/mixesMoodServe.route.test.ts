/**
 * GET /mixes/mood/buckets/:mood stores the ids it served on the caller's
 * UserMoodMix and excludes them from the next serving.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return "OK"; }),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
        multi: jest.fn(() => {
            const ops: Array<() => void> = [];
            const chain = {
                setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                sadd: () => chain,
                expire: () => chain,
                exec: async () => { ops.forEach((op) => op()); return []; },
            };
            return chain;
        }),
    },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import mixRoutes from "../mixes";
import { prisma } from "../../utils/db";

jest.setTimeout(60_000);

const USER_ID = "mmsr_user";
const BUCKET_ROWS = 40; // 15 served + 3 saved + 15 fresh leaves >= 7 spare

function trackId(i: number): string {
    return `mmsr_trk_${i}`;
}

function makeApp() {
    const app = express();
    app.use(express.json());
    // The route reads req.user directly rather than going through middleware.
    app.use((req: any, _res, next) => {
        req.user = { id: USER_ID, username: "mmsr-tester", role: "user" };
        next();
    });
    app.use("/mixes", mixRoutes);
    return app;
}

async function servedTrackIds(): Promise<string[]> {
    const row = await prisma.userMoodMix.findUnique({ where: { userId: USER_ID } });
    return row?.servedTrackIds ?? [];
}

describe("GET /mixes/mood/buckets/:mood remembers what it served (database)", () => {
    let app: express.Application;

    beforeAll(async () => {
        const artist = await prisma.artist.create({ data: { id: "mmsr_art", name: "Serve Route Artist", identityKey: "mmsr_a" } });
        const album = await prisma.album.create({
            data: { id: "mmsr_alb", rgMbid: "mmsr_rg", artistId: artist.id, title: "Serve Route Album", primaryType: "Album" },
        });
        await prisma.user.create({
            data: { id: USER_ID, username: "mmsr-tester", passwordHash: "x" },
        });
        const bucketRows = [];
        for (let i = 0; i < BUCKET_ROWS; i++) {
            const id = trackId(i);
            await prisma.track.create({
                data: {
                    id, albumId: album.id, title: `SR ${i}`, trackNo: i + 1, duration: 180,
                    filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                },
            });
            bucketRows.push({ trackId: id, mood: "chill", score: 0.9999 - i * 0.001 });
        }
        await prisma.moodBucket.createMany({ data: bucketRows });
        // A mix the user already saved, before any serving is recorded.
        await prisma.userMoodMix.create({
            data: {
                userId: USER_ID,
                mood: "chill",
                trackIds: [trackId(0), trackId(1), trackId(2)],
                coverUrls: [],
                generatedAt: new Date(),
            },
        });
        app = makeApp();
    });

    afterAll(async () => {
        await prisma.userMoodMix.deleteMany({ where: { userId: { startsWith: "mmsr_" } } });
        await prisma.user.deleteMany({ where: { id: { startsWith: "mmsr_" } } });
        await prisma.moodBucket.deleteMany({ where: { trackId: { startsWith: "mmsr_trk_" } } });
        await prisma.track.deleteMany({ where: { id: { startsWith: "mmsr_trk_" } } });
        await prisma.album.deleteMany({ where: { id: "mmsr_alb" } });
        await prisma.artist.deleteMany({ where: { id: "mmsr_art" } });
        await prisma.$disconnect();
    });

    it("records the exact ids it served on the user's mix", async () => {
        const res = await request(app).get("/mixes/mood/buckets/chill");

        expect(res.status).toBe(200);
        expect(res.body.trackIds).toHaveLength(15);
        expect(await servedTrackIds()).toEqual(res.body.trackIds);
    });

    it("does not repeat remembered ids on the next serving", async () => {
        const first = await servedTrackIds();
        const saved = [trackId(0), trackId(1), trackId(2)];

        const res = await request(app).get("/mixes/mood/buckets/chill");

        expect(res.status).toBe(200);
        expect(res.body.trackIds).toHaveLength(15);
        const given = new Set([...saved, ...first]);
        for (const id of res.body.trackIds) {
            expect(given.has(id)).toBe(false);
        }
    });
});
