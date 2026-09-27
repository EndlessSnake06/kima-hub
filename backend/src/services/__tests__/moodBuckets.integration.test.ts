/**
 * Mood sorting, against the migrated test database.
 *
 * Moods are ranked within the library (moodBucketService): a track carries a
 * mood only when its head says yes (>= 0.5) AND it sits in the library's top
 * STANDOUT_SHARE on that mood. These tests pin that rule, that buckets are only
 * filled once BOTH audio analysis and CLAP are done, that the worker re-sorts
 * everything when the library changes (and only then), that the vibe map
 * serves the same decision, and that the inverted-heads migration re-queues
 * exactly the rows the broken analyzer wrote.
 *
 * Run with: npx jest moodBuckets.integration.test.ts
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

import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import {
    classifyMoods,
    MoodDistribution,
    MoodValues,
    moodBucketService,
    NEUTRAL,
    UNANALYZED,
} from "../moodBucketService";
import { syncMoodBuckets } from "../../workers/moodBucketWorker";
import { computeMapProjection } from "../umapProjection";

jest.setTimeout(60_000);

const quiet: MoodValues = { moodHappy: 0.2, moodSad: 0.2, moodRelaxed: 0.2, moodAggressive: 0.2, moodParty: 0.2 };

describe("classifyMoods (pure)", () => {
    // 10 tracks: values 0.0 .. 0.9 on every mood
    const lib: MoodValues[] = Array.from({ length: 10 }, (_, i) => ({
        moodHappy: i / 10, moodSad: i / 10, moodRelaxed: i / 10, moodAggressive: i / 10, moodParty: i / 10,
    }));
    const dist = new MoodDistribution(lib);

    it("ranks a value by the share of the library below it, ties counted half", () => {
        expect(dist.rank("moodHappy", 0.9)).toBeCloseTo(0.95);
        expect(dist.rank("moodHappy", 0.0)).toBeCloseTo(0.05);
        expect(dist.rank("moodHappy", 0.45)).toBeCloseTo(0.5);
    });

    it("gives a mood only to a track in the library's top fifth whose head says yes", () => {
        const v = classifyMoods({ ...quiet, moodParty: 0.9 }, dist);
        expect(v.dominant).toBe("moodParty");
        expect(v.moods).toEqual(["moodParty"]);
    });

    it("does not give a mood the head says no to, however high it ranks", () => {
        // Library where every sad value is tiny: 0.09 is the top, but P(sad) < 0.5.
        const low = new MoodDistribution(lib.map((r) => ({ ...r, moodSad: (r.moodSad as number) / 10 })));
        const v = classifyMoods({ ...quiet, moodSad: 0.09 }, low);
        expect(v.ranks.moodSad).toBeGreaterThan(0.8);
        expect(v.moods).not.toContain("moodSad");
    });

    it("has no single mood when nothing stands out", () => {
        const v = classifyMoods({ moodHappy: 0.5, moodSad: 0.5, moodRelaxed: 0.5, moodAggressive: 0.5, moodParty: 0.5 }, dist);
        expect(v.dominant).toBe(NEUTRAL);
        expect(v.score).toBe(0);
    });

    it("picks the mood the track stands out on most, and keeps every mood it has", () => {
        const v = classifyMoods({ ...quiet, moodHappy: 0.8, moodParty: 0.9 }, dist);
        expect(v.dominant).toBe("moodParty");
        expect(v.moods.sort()).toEqual(["moodHappy", "moodParty"]);
    });

    it("reports a track with any missing mood as not analysed, never as 0.5", () => {
        const v = classifyMoods({ ...quiet, moodSad: null }, dist);
        expect(v.dominant).toBe(UNANALYZED);
        expect(v.ranks).toEqual({});
        expect(v.moods).toEqual([]);
    });
});

async function seed() {
    const artist = await prisma.artist.create({ data: { id: "art_mood", name: "Mood Artist", identityKey: "a_mood" } });
    const album = await prisma.album.create({
        data: { id: "alb_mood", rgMbid: "rg_mood", artistId: artist.id, title: "Mood Album", primaryType: "Album" },
    });
    // 20 analysed tracks. t0..t3 are clearly Energetic (party 0.9), t4 clearly
    // Calm (relaxed 0.95); the rest are quiet. t3 has no CLAP yet.
    for (let i = 0; i < 20; i++) {
        const id = `trk_mood_${i}`;
        const moods = { ...quiet, moodParty: 0.1 + i * 0.001, moodRelaxed: 0.1 + i * 0.001 };
        if (i < 4) moods.moodParty = 0.9;
        if (i === 4) moods.moodRelaxed = 0.95;
        await prisma.track.create({
            data: {
                id, albumId: album.id, title: `M ${i}`, trackNo: i + 1, duration: 180,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                analysisStatus: "completed", analysisMode: "enhanced", analysisVersion: "2.1b6-enhanced-v3",
                analyzedAt: new Date(Date.UTC(2026, 8, 24, 0, i)),
                vibeAnalysisStatus: i === 3 ? "pending" : "completed",
                ...moods,
            },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, map_x, map_y, map_z) VALUES ($1, $2::vector, 0.5, 0.5, 0.5)`,
            id, `[${Array.from({ length: 512 }, (_, d) => (d === i ? 1 : 0)).join(",")}]`,
        );
    }
    // One track still waiting for analysis.
    await prisma.track.create({
        data: {
            id: "trk_mood_pending", albumId: album.id, title: "Pending", trackNo: 21, duration: 180,
            filePath: "/tmp/trk_mood_pending.flac", fileModified: new Date(), fileSize: 1000,
            analysisStatus: "pending",
        },
    });
}

describe("mood buckets (database)", () => {
    beforeAll(async () => {
        await seed();
    });

    // The worker DB is shared by every suite in this Jest worker: remove our rows.
    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, "trk\\_mood\\_%");
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_mood\\_%");
        await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, "alb_mood");
        await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, "art_mood");
        await prisma.$disconnect();
    });

    it("sorts every analysed track on the first run, bucketing only tracks with CLAP done", async () => {
        expect(await syncMoodBuckets()).toBe(true);
        const buckets = await prisma.moodBucket.findMany({ orderBy: [{ mood: "asc" }, { trackId: "asc" }] });
        expect(buckets.map((b) => `${b.mood}:${b.trackId}`)).toEqual([
            "chill:trk_mood_4",
            "party:trk_mood_0",
            "party:trk_mood_1",
            "party:trk_mood_2",
            // trk_mood_3 stands out too, but its CLAP analysis is not done
        ]);
        for (const b of buckets) expect(b.score).toBeGreaterThanOrEqual(0.8);
    });

    it("does not rebuild when nothing in the library changed", async () => {
        expect(await syncMoodBuckets()).toBe(false);
    });

    it("re-sorts when a track's CLAP finishes, and reports tracks awaiting analysis", async () => {
        await prisma.track.update({ where: { id: "trk_mood_3" }, data: { vibeAnalysisStatus: "completed" } });
        expect(await syncMoodBuckets()).toBe(true);
        expect(await prisma.moodBucket.count({ where: { mood: "party" } })).toBe(4);
        const presets = await moodBucketService.getMoodPresets();
        expect(presets.map((p) => p.name)).toEqual(["Upbeat", "Melancholic", "Calm", "Intense", "Energetic"]);
        expect(presets.find((p) => p.id === "party")!.trackCount).toBe(4);
        // Other suites in this Jest worker may leave pending rows; count them all.
        const pending = await prisma.track.count({ where: { analysisStatus: { in: ["pending", "queued", "processing"] } } });
        expect(pending).toBeGreaterThanOrEqual(1);
        expect(presets[0].pendingTracks).toBe(pending);
    });

    it("serves the same decision on the vibe map, and 'unanalyzed' once values are cleared", async () => {
        let map = await computeMapProjection();
        const byId = new Map(map.tracks.map((t) => [t.id, t]));
        expect(byId.get("trk_mood_0")!.dominantMood).toBe("moodParty");
        expect(byId.get("trk_mood_4")!.dominantMood).toBe("moodRelaxed");
        expect(byId.get("trk_mood_10")!.dominantMood).toBe(NEUTRAL);
        expect(Object.keys(byId.get("trk_mood_0")!.moods).sort()).toEqual(
            ["moodAggressive", "moodHappy", "moodParty", "moodRelaxed", "moodSad"],
        );

        await prisma.track.update({ where: { id: "trk_mood_0" }, data: { moodParty: null } });
        await syncMoodBuckets();
        map = await computeMapProjection();
        expect(map.tracks.find((t) => t.id === "trk_mood_0")!.dominantMood).toBe(UNANALYZED);
        expect(await prisma.moodBucket.count({ where: { trackId: "trk_mood_0" } })).toBe(0);
    });

    it("the inverted-heads migration re-queues exactly the rows the broken analyzer wrote", async () => {
        await prisma.track.update({
            where: { id: "trk_mood_5" },
            data: { analysisVersion: "2.1b6-enhanced-v2", danceabilityMl: 0.3, moodAcoustic: 0.4, moodTags: ["happy"], analysisRetryCount: 2 },
        });
        await prisma.track.update({
            where: { id: "trk_mood_6" },
            data: { analysisMode: "standard", analysisVersion: "2.1b6-enhanced-v2", moodTags: ["chill"] },
        });
        const sql = fs.readFileSync(
            path.join(__dirname, "../../../prisma/migrations/20260924120000_reset_inverted_mood_heads/migration.sql"),
            "utf8",
        );
        await prisma.$executeRawUnsafe(sql);

        const reset = await prisma.track.findUniqueOrThrow({ where: { id: "trk_mood_5" } });
        expect(reset.analysisStatus).toBe("pending");
        expect(reset.analysisRetryCount).toBe(0);
        expect([reset.moodHappy, reset.moodSad, reset.moodRelaxed, reset.moodAggressive, reset.moodParty,
            reset.moodAcoustic, reset.moodElectronic, reset.danceabilityMl]).toEqual(Array(8).fill(null));
        expect(reset.moodTags).toEqual([]);

        // Fixed-analyzer rows and standard-mode rows are left alone.
        const fixed = await prisma.track.findUniqueOrThrow({ where: { id: "trk_mood_7" } });
        expect(fixed.analysisStatus).toBe("completed");
        expect(fixed.moodParty).not.toBeNull();
        const standard = await prisma.track.findUniqueOrThrow({ where: { id: "trk_mood_6" } });
        expect(standard.analysisStatus).toBe("completed");
        expect(standard.moodTags).toEqual(["chill"]);
    });
});
