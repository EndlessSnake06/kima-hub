/**
 * getMoodMix samples uniformly from the whole mood bucket (tied scores are as
 * likely as any) and stores what it served on UserMoodMix so the next mix
 * can skip it.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
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

import { prisma } from "../../utils/db";
import { moodBucketService, MoodType } from "../moodBucketService";

jest.setTimeout(60_000);

const TRACKS = 240;
// 30 draws x 15 tracks over a 240-row bucket: expected 205.4 distinct ids
// (sigma ~5.4), so >=150 proves rows well beyond any top-100 cutoff are drawn.
const DRAWS_WHOLE = 30;
const MIN_UNION_WHOLE = 150;
// A bucket where every score is tied (Calm's real shape): 60 draws x 15 are
// enough that all but ~5 of the 240 rows should surface at least once.
const DRAWS_TIED = 60;
const MIN_UNION_TIED = 220;

function trackId(i: number): string {
    return `mmp_trk_${i}`;
}

async function seed() {
    const artist = await prisma.artist.create({ data: { id: "mmp_art", name: "Mix Pool Artist", identityKey: "mmp_a" } });
    const album = await prisma.album.create({
        data: { id: "mmp_alb", rgMbid: "mmp_rg", artistId: artist.id, title: "Mix Pool Album", primaryType: "Album" },
    });
    // chill mimics a real bucket's top-heavy scores: the old code's top-100
    // cutoff lands exactly on tracks 0..99. party is one big tie instead.
    const bucketRows = [] as Array<{ trackId: string; mood: string; score: number }>;
    for (let i = 0; i < TRACKS; i++) {
        const id = trackId(i);
        await prisma.track.create({
            data: {
                id, albumId: album.id, title: `MP ${i}`, trackNo: i + 1, duration: 180,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            },
        });
        bucketRows.push({ trackId: id, mood: "chill", score: 0.9999 - i * 0.001 });
        bucketRows.push({ trackId: id, mood: "party", score: 0.924885 });
    }
    await prisma.moodBucket.createMany({ data: bucketRows });
}

const drawIds = async (mood: MoodType, draws: number, exclude?: string[]) => {
    const union = new Set<string>();
    for (let d = 0; d < draws; d++) {
        const mix = await moodBucketService.getMoodMix(mood, 15, exclude);
        expect(mix).not.toBeNull();
        for (const id of mix!.trackIds) union.add(id);
    }
    return union;
};

describe("getMoodMix draws from the whole bucket (database)", () => {
    beforeAll(async () => {
        await seed();
    });

    // The worker DB is shared by every suite in this Jest worker: remove our rows.
    afterAll(async () => {
        await prisma.userMoodMix.deleteMany({ where: { userId: { startsWith: "mmp_user" } } });
        await prisma.user.deleteMany({ where: { id: { startsWith: "mmp_user" } } });
        await prisma.moodBucket.deleteMany({ where: { trackId: { startsWith: "mmp_trk_" } } });
        await prisma.track.deleteMany({ where: { id: { startsWith: "mmp_trk_" } } });
        await prisma.album.deleteMany({ where: { id: "mmp_alb" } });
        await prisma.artist.deleteMany({ where: { id: "mmp_art" } });
        await prisma.$disconnect();
    });

    it("samples the whole bucket, not just the top 100", async () => {
        const union = await drawIds("chill", DRAWS_WHOLE);
        // The old take:100 pool can never surface more than 100 distinct ids.
        expect(union.size).toBeGreaterThanOrEqual(MIN_UNION_WHOLE);
    });

    it("serves every row of a fully tied bucket, not an arbitrary top slice", async () => {
        const union = await drawIds("party", DRAWS_TIED);
        expect(union.size).toBeGreaterThanOrEqual(MIN_UNION_TIED);
    });

    it("excludes previously served ids from the next mix", async () => {
        // Exclude the old top-100 outright: every drawn id must come from 100+.
        const excluded = Array.from({ length: 100 }, (_, i) => trackId(i));
        const mix = await moodBucketService.getMoodMix("chill", 15, excluded);
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);
        expect(new Set(mix!.trackIds).size).toBe(15);
        for (const id of mix!.trackIds) {
            expect(excluded).not.toContain(id);
        }
    });

    it("starts over from the full bucket when exclusions leave too few rows", async () => {
        const excluded = Array.from({ length: TRACKS }, (_, i) => trackId(i));
        const mix = await moodBucketService.getMoodMix("chill", 15, excluded);
        // A thin fallback mix would be worse than repeating: the draw falls
        // back to the whole bucket rather than returning null or 4 tracks.
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);
        expect(new Set(mix!.trackIds).size).toBe(15);
    });

    it("persists the served track ids alongside the saved mix", async () => {
        const userId = "mmp_user_save";
        await prisma.user.create({
            data: { id: userId, username: "mmp-save", passwordHash: "x" },
        });
        const saved = await moodBucketService.saveUserMoodMix(userId, "chill", 15, [
            trackId(0), trackId(1), trackId(2),
        ]);
        expect(saved).not.toBeNull();

        const row = await prisma.userMoodMix.findUnique({ where: { userId } });
        expect(row!.trackIds).toEqual([trackId(0), trackId(1), trackId(2)]);
        // What the user was given is remembered next to the saved mix itself.
        expect(row!.servedTrackIds).toEqual([trackId(0), trackId(1), trackId(2)]);
    });

    it("remembers what a serving gave the user and skips it on the next mix", async () => {
        const userId = "mmp_user_serve";
        await prisma.user.create({
            data: { id: userId, username: "mmp-serve", passwordHash: "x" },
        });
        // Save first, then record a later serving, as the route does.
        await moodBucketService.saveUserMoodMix(userId, "chill", 15, [trackId(0)]);
        await moodBucketService.recordServedTracks(userId, "chill", [trackId(1), trackId(2)]);

        const remembered = await moodBucketService.getRememberedTrackIds(userId, "chill");
        expect(new Set(remembered)).toEqual(new Set([trackId(0), trackId(1), trackId(2)]));

        // A mix for a different mood must not inherit this mood's history.
        expect(await moodBucketService.getRememberedTrackIds(userId, "party")).toEqual([]);
    });
});
