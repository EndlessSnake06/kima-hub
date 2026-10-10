/**
 * The analyzer writes no engine state; its completion channel is its report.
 * These tests publish reports the way the analyzer does and verify the
 * subscriber settles the stage record and the status columns it mirrors.
 */

const mockListeners: Array<(channel: string, message: string) => Promise<void> | void> = [];
jest.mock("ioredis", () =>
    jest.fn().mockImplementation(() => ({
        subscribe: jest.fn(),
        unsubscribe: jest.fn(async () => undefined),
        on: jest.fn((event: string, cb: (channel: string, message: string) => void) => {
            if (event === "message") mockListeners.push(cb);
        }),
        quit: jest.fn(async () => undefined),
    })),
);
jest.mock("../enrichmentQueues", () => {
    const queueStub = () => ({
        add: jest.fn(async () => ({ id: "job-1" })),
        clean: jest.fn(async () => []),
        getJob: jest.fn(async () => null),
        resume: jest.fn(async () => undefined),
        pause: jest.fn(async () => undefined),
    });
    return {
        QUEUE_NAMES: {
            ARTISTS: "enrichment-artists",
            TRACKS: "enrichment-tracks",
            VIBE: "enrichment-vibe",
            PODCASTS: "enrichment-podcasts",
        },
        artistQueue: queueStub(),
        trackQueue: queueStub(),
        vibeQueue: queueStub(),
        podcastQueue: queueStub(),
        createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
        closeEnrichmentQueues: jest.fn(async () => undefined),
    };
});
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { startAudioCompletionSubscriber, stopAudioCompletionSubscriber } from "../audioCompletionSubscriber";

jest.setTimeout(30_000);

async function emit(event: Record<string, unknown>) {
    for (const listener of mockListeners) await listener("audio:analysis:complete", JSON.stringify(event));
}

async function seedTrack(id: string, status: string) {
    const artist = await prisma.artist.create({ data: { id: `art_${id}`, name: `A ${id}`, identityKey: `k_${id}` } });
    const album = await prisma.album.create({
        data: { id: `alb_${id}`, rgMbid: `rg_${id}`, artistId: artist.id, title: `Alb ${id}`, primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id, albumId: album.id, title: `T ${id}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: status, analysisStartedAt: new Date(Date.now() - 60_000),
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, "startedAt")
         VALUES ($1, $2, 'analysis', 'working', 'analyzer', 1, now() - interval '1 minute')`,
        `${id}__analysis`, id,
    );
}

async function unseed(id: string) {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" = $1`, id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id = $1`, id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, `alb_${id}`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, `art_${id}`);
}

describe("audio completion reports: the analyzer reports, the backend writes", () => {
    beforeAll(async () => {
        await startAudioCompletionSubscriber();
        expect(mockListeners.length).toBeGreaterThan(0);
    });
    afterAll(async () => {
        await stopAudioCompletionSubscriber();
    });

    it("a completion closes the record and mirrors the column", async () => {
        await seedTrack("trk_sub_done", "processing");
        await emit({ trackId: "trk_sub_done", filePath: "/tmp/trk_sub_done.flac", status: "complete" });

        const record = await prisma.trackStage.findFirst({ where: { trackId: "trk_sub_done", stage: "analysis" } });
        expect(record?.status).toBe("done");
        const track = await prisma.track.findUnique({ where: { id: "trk_sub_done" } });
        expect(track?.analysisStatus).toBe("completed");
        expect(track?.analysisStartedAt).toBeNull();
        await unseed("trk_sub_done");
    });

    it("an inconclusive failure consumes the attempt and mirrors failed", async () => {
        await seedTrack("trk_sub_fail", "processing");
        await emit({ trackId: "trk_sub_fail", status: "failed", error: "analysis exceeded 15 minutes" });

        const record = await prisma.trackStage.findFirst({ where: { trackId: "trk_sub_fail", stage: "analysis" } });
        expect(record?.status).toBe("failed");
        expect(record?.retryable).toBe(true);
        // The working claim already counted this attempt, so it stays 1.
        expect(record?.attempt).toBe(1);
        const track = await prisma.track.findUnique({ where: { id: "trk_sub_fail" } });
        expect(track?.analysisStatus).toBe("failed");
        expect(track?.analysisRetryCount).toBe(1);
        await unseed("trk_sub_fail");
    });

    it("a corruption signature closes the record and mirrors permanently_failed", async () => {
        await seedTrack("trk_sub_dmg", "processing");
        await emit({ trackId: "trk_sub_dmg", status: "failed", error: "corrupted audio data [DAMAGED]" });

        const record = await prisma.trackStage.findFirst({ where: { trackId: "trk_sub_dmg", stage: "analysis" } });
        expect(record?.status).toBe("failed");
        expect(record?.retryable).toBe(false);
        expect(record?.failureClass).toBe("DAMAGED");
        const track = await prisma.track.findUnique({ where: { id: "trk_sub_dmg" } });
        expect(track?.analysisStatus).toBe("permanently_failed");
        await unseed("trk_sub_dmg");
    });

    it("a success after a failure reopens and closes the ladder", async () => {
        await seedTrack("trk_sub_retry", "processing");
        await emit({ trackId: "trk_sub_retry", status: "failed", error: "decode frame failed: transient" });
        await emit({ trackId: "trk_sub_retry", filePath: "/tmp/x.flac", status: "complete" });

        const record = await prisma.trackStage.findFirst({ where: { trackId: "trk_sub_retry", stage: "analysis" } });
        expect(record?.status).toBe("done");
        const track = await prisma.track.findUnique({ where: { id: "trk_sub_retry" } });
        expect(track?.analysisStatus).toBe("completed");
        expect(track?.analysisError).toBeNull();
        await unseed("trk_sub_retry");
    });
});
