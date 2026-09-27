/**
 * The failure-ledger controls RESOLVE, they do not delete
 * (never delete a failure record to "fix" it).
 *
 * DELETE /enrichment/failures and DELETE /enrichment/failures/:id hard-deleted
 * EnrichmentFailure rows through deleteFailures/clearAllFailures — one click
 * erased the history the ledger exists to keep. Migration
 * 20260925150000_settle_stale_enrichment_failures already established the
 * truthful semantics: `resolved = true, "resolvedAt" = now()` on UNRESOLVED
 * rows only (idempotent — never rewrites resolvedAt), and never a delete.
 *
 * The controls now do the same:
 *   POST /enrichment/failures/resolve       { ids }      — was DELETE /:id
 *   POST /enrichment/failures/resolve-all   ?entityType= — was DELETE /
 * The DELETE routes are gone (404, like the other removed controls), the
 * dead delete methods are gone, and a skipped record keeps its human
 * disposition (resolve-all does not touch it).
 *
 * Run: cd backend && npx jest src/routes/__tests__/enrichment.failuresResolve.test.ts --forceExit --maxWorkers=1
 */

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    trackQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    vibeQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    podcastQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

const mockRedis = {
    rpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    status: "ready",
};

jest.mock("ioredis", () => jest.fn().mockImplementation(() => mockRedis));
jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue(null),
        initializeState: jest.fn().mockResolvedValue({}),
        clear: jest.fn().mockResolvedValue(undefined),
        detectHang: jest.fn().mockResolvedValue(false),
        clearGate: jest.fn().mockResolvedValue(undefined),
        publishToChannel: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        waitForStatus: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
}));

jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
        storeIsrc: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        lookupByIsrc: jest.fn().mockResolvedValue(null),
        getRecordingIsrc: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/acoustidIdentification", () => ({
    identifyTrackByAcoustid: jest.fn().mockResolvedValue(null),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/umapProjection", () => ({
    precomputeProjection: jest.fn().mockResolvedValue(undefined),
    appendTrackToProjection: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/artistSimilarity", () => ({
    MIN_LOCAL_TRACKS: 5,
    rebuildArtistCentroid: jest.fn().mockResolvedValue({ trackCount: 0 }),
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../../workers/audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../../workers/artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));

jest.mock("../../services/enrichment", () => ({
    enrichmentService: {
        enrichArtist: jest.fn(), enrichAlbum: jest.fn(), enrichTrack: jest.fn(),
    },
}));
jest.mock("../../services/imageBackfill", () => ({ repairBrokenCovers: jest.fn() }));
jest.mock("../../services/mbidReassign", () => ({
    DuplicateMbidError: class extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));
jest.mock("../../services/artistIdentity", () => ({ artistSortName: jest.fn() }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ autoEnrichMetadata: true }),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../../services/rateLimiter", () => ({ rateLimiter: {} }));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn(), set: jest.fn() },
}));

// NOTE: enrichmentFailureService is deliberately NOT mocked — the point is
// to prove the REAL service resolves rows in the REAL database.

import request from "supertest";
import express from "express";

import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import enrichmentRouter from "../../routes/enrichment";

const PREFIX = "resolve";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedFailures(): Promise<{ f1: string; f2: string; fArtist: string; fSkipped: string; fResolved: string }> {
    const base = {
        entityName: "Resolve Test",
        errorMessage: "boom",
        errorCode: "NO_MATCH",
        retryCount: 1,
        maxRetries: 3,
    };
    const f1 = await prisma.enrichmentFailure.create({
        data: { ...base, id: id("f1"), entityType: "track", entityId: id("e1") },
    });
    const f2 = await prisma.enrichmentFailure.create({
        data: { ...base, id: id("f2"), entityType: "track", entityId: id("e2") },
    });
    const fArtist = await prisma.enrichmentFailure.create({
        data: { ...base, id: id("fa"), entityType: "artist", entityId: id("ea") },
    });
    const fSkipped = await prisma.enrichmentFailure.create({
        data: { ...base, id: id("fs"), entityType: "audio", entityId: id("es"), skipped: true, skippedAt: new Date() },
    });
    const resolvedAt = new Date(Date.now() - 86_400_000);
    const fResolved = await prisma.enrichmentFailure.create({
        data: { ...base, id: id("fr"), entityType: "vibe", entityId: id("ev"), resolved: true, resolvedAt },
    });
    return { f1: f1.id, f2: f2.id, fArtist: fArtist.id, fSkipped: fSkipped.id, fResolved: fResolved.id };
}

async function wipe(): Promise<void> {
    await prisma.enrichmentFailure.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${PREFIX}_%`);
}

let app: express.Express;

async function makeAdmin(userId: string): Promise<string> {
    await prisma.user.create({
        data: { id: userId, username: userId, passwordHash: "x", role: "admin", tokenVersion: 0 },
    });
    return generateToken({ id: userId, username: userId, role: "admin", tokenVersion: 0 });
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    app = express();
    app.use(express.json());
    app.use("/enrichment", enrichmentRouter);
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("failure-ledger controls resolve instead of delete", () => {
    it("POST /failures/resolve resolves the named records and keeps every row", async () => {
        const token = await makeAdmin(id("boss"));
        const { f1, f2 } = await seedFailures();
        const before = new Date();

        const res = await request(app)
            .post("/enrichment/failures/resolve")
            .set("Authorization", `Bearer ${token}`)
            .send({ ids: [f1, f2] });

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);

        // The records still exist -- resolved, not deleted.
        const rows = await prisma.enrichmentFailure.findMany({
            where: { id: { in: [f1, f2] } },
        });
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.resolved).toBe(true);
            expect(row.resolvedAt).not.toBeNull();
            expect(row.resolvedAt!.getTime()).toBeGreaterThanOrEqual(
                before.getTime() - 1000
            );
        }
    });

    it("POST /failures/resolve-all resolves only unresolved rows of the type, leaves skipped and other types alone", async () => {
        const token = await makeAdmin(id("boss2"));
        const { f1, f2, fArtist, fSkipped } = await seedFailures();

        // Track-stage failures live in TrackStage: resolve-all
        // for a track-kind type parks the STAGE records, and the superseded
        // track-kind ledger rows are history the route never touches.
        await prisma.artist.create({
            data: { id: id("art"), name: "Resolve Artist", identityKey: id("a") },
        });
        await prisma.album.create({
            data: {
                id: id("alb"), rgMbid: id("rg"), artistId: id("art"),
                title: "Resolve Album", primaryType: "Album",
            },
        });
        await prisma.track.create({
            data: {
                id: id("stage1"), albumId: id("alb"), title: `Track ${id("stage1")}`,
                trackNo: 1, duration: 180, filePath: `/tmp/${id("stage1")}.flac`,
                fileModified: new Date(), fileSize: 1000, analysisStatus: "pending",
                enrichmentTags: [],
            },
        });
        const stageId = `${id("stage1")}__recording`;
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'recording', 'failed', 'musicbrainz', 1, true, $3::jsonb)`,
            stageId, id("stage1"), JSON.stringify({ probe: "mb-search" }),
        );

        const res = await request(app)
            .post("/enrichment/failures/resolve-all?entityType=track")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        const stage = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
            `SELECT status FROM "TrackStage" WHERE id = $1`,
            stageId,
        );
        expect(stage[0]?.status).toBe("blocked");
        // The superseded ledger rows are untouched by the track-kind route —
        // migration 20260926150000 already resolved them as history.
        for (const fid of [f1, f2]) {
            const row = await prisma.enrichmentFailure.findUnique({ where: { id: fid } });
            expect(row).not.toBeNull();
            expect(row!.resolved).toBe(false);
        }

        // The ledger type still works for entities without a stage record:
        // resolving artists resolves ONLY unresolved artist rows.
        const resArtist = await request(app)
            .post("/enrichment/failures/resolve-all?entityType=artist")
            .set("Authorization", `Bearer ${token}`);
        expect(resArtist.status).toBe(200);
        expect(resArtist.body.count).toBe(1);
        const artist = await prisma.enrichmentFailure.findUnique({ where: { id: fArtist } });
        expect(artist!.resolved).toBe(true);
        expect(artist!.resolvedAt).not.toBeNull();
        // A skipped record keeps its human disposition.
        const skipped = await prisma.enrichmentFailure.findUnique({ where: { id: fSkipped } });
        expect(skipped!.resolved).toBe(false);
        expect(skipped).not.toBeNull();
    });

    it("is idempotent: an already-resolved record's resolvedAt is never rewritten", async () => {
        const token = await makeAdmin(id("boss3"));
        const { fResolved } = await seedFailures();
        const original = (
            await prisma.enrichmentFailure.findUnique({ where: { id: fResolved } })
        )!.resolvedAt!;

        const res = await request(app)
            .post("/enrichment/failures/resolve")
            .set("Authorization", `Bearer ${token}`)
            .send({ ids: [fResolved] });

        // Migration semantics: only unresolved rows are touched.
        expect(res.body.count).toBe(0);
        const row = await prisma.enrichmentFailure.findUnique({ where: { id: fResolved } });
        expect(row!.resolvedAt!.getTime()).toBe(original.getTime());
    });

    it("the DELETE routes are gone: 404 even for an admin", async () => {
        const token = await makeAdmin(id("boss4"));
        await seedFailures();

        const all = await request(app)
            .delete("/enrichment/failures")
            .set("Authorization", `Bearer ${token}`);
        expect(all.status).toBe(404);

        const one = await request(app)
            .delete(`/enrichment/failures/${id("f1")}`)
            .set("Authorization", `Bearer ${token}`);
        expect(one.status).toBe(404);

        // And nothing was deleted by those attempts.
        expect(
            await prisma.enrichmentFailure.count({ where: { id: { startsWith: PREFIX } } })
        ).toBe(5);
    });
});
