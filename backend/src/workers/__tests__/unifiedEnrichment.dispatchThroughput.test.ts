/**
 * Each track phase has its own stage window, so analysis dispatches while
 * identification is still running, and no stage claims beyond its in-flight
 * cap, so a queued job never outlives its record's patience.
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

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        getFailure: jest.fn().mockResolvedValue(null),
        getFailureCounts: jest.fn().mockResolvedValue({}),
        skipFailures: jest.fn().mockResolvedValue(0),
        resetRetryCount: jest.fn().mockResolvedValue(0),
        deleteFailures: jest.fn().mockResolvedValue(0),
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
        handleRateLimit: jest.fn().mockResolvedValue(false),
        getPause: jest.fn().mockResolvedValue(null),
        windowMs: 60_000,
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

import { prisma } from "../../utils/db";
import {
    executeAudioPhase,
    executeVibePhase,
    STAGE_IN_FLIGHT_CAP,
} from "../../workers/unifiedEnrichment";

const PREFIX = "dthr";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Throughput Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Throughput Album", primaryType: "Album" },
    });
}

/** Bulk inserts: the caps are hundreds of tracks, too many for a row-by-row seed. */
async function seedTracks(count: number, stages: Array<[string, string]>): Promise<void> {
    const trackIds = Array.from({ length: count }, (_, n) => id(`t${n}`));
    await prisma.track.createMany({
        data: trackIds.map((trackId, n) => ({
            id: trackId,
            albumId: id("alb"),
            title: `Track ${n}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending",
            enrichmentTags: [],
        })),
    });
    for (const [stage, status] of stages) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
             SELECT t || '__' || $2, t, $2, $3, 'test', 0, true, '{}'::jsonb FROM unnest($1::text[]) AS t`,
            trackIds, stage, status,
        );
    }
}

async function workingCount(stage: string): Promise<number> {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "TrackStage" ts
          JOIN "Track" t ON t.id = ts."trackId"
         WHERE ts.stage = $1 AND ts.status = 'working' AND t.id LIKE $2`,
        stage, `${PREFIX}_%`,
    );
    return Number(row.n);
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("stages overlap instead of waving", () => {
    it("analysis dispatches while a bigger recording backlog is pending", async () => {
        // A mixed backlog: every
        // track still needs its recording AND its analysis. One shared
        // stage-ordered window made this window all-recording, so the
        // analyzer got nothing until identification finished.
        await seedTracks(30, [
            ["recording", "pending"],
            ["analysis", "pending"],
            ["fingerprint", "done"],
        ]);

        const queued = await executeAudioPhase();

        expect(queued).toBe(20);
        expect(mockRedis.rpush).toHaveBeenCalledTimes(20);
        expect(await workingCount("analysis")).toBe(20);
    });

    it("the analysis window refills the moment answers land", async () => {
        // One batch claimed; with no answers yet, the next cycle adds
        // nothing new (cap room is there, but the offered set is the same
        // pending rows — claimed rows are 'working', not re-offered).
        await seedTracks(25, [["analysis", "pending"]]);
        expect(await executeAudioPhase()).toBe(20);
        expect(await executeAudioPhase()).toBe(5);
        expect(await workingCount("analysis")).toBe(25);
        // A claimed question is not handed out again while its lease holds.
        expect(await executeAudioPhase()).toBe(0);
    });
});

describe("in-flight caps keep queues inside the record's patience", () => {
    it("analysis claims no deeper than its cap", async () => {
        const cap = STAGE_IN_FLIGHT_CAP.analysis ?? 0;
        expect(cap).toBeGreaterThan(0);
        await seedTracks(cap + 5, [["analysis", "pending"]]);

        // A cycle dispatches min(window, headroom); drive cycles until the
        // stage is at its cap and the queue goes quiet.
        let queued = 0;
        for (let cycle = 0; cycle < 15; cycle++) {
            const added = await executeAudioPhase();
            queued += added;
            if (added === 0) break;
        }

        expect(queued).toBe(cap);
        expect(await workingCount("analysis")).toBe(cap);
        const [stillPending] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "TrackStage" ts
              JOIN "Track" t ON t.id = ts."trackId"
             WHERE ts.stage = 'analysis' AND ts.status = 'pending' AND t.id LIKE $1`,
            `${PREFIX}_%`,
        );
        expect(Number(stillPending.n)).toBe(5);
    });

    it("embedding claims no deeper than its cap", async () => {
        const cap = STAGE_IN_FLIGHT_CAP.embedding ?? 0;
        expect(cap).toBeGreaterThan(0);
        // Embedding gates on the track's own analysis answer.
        await seedTracks(cap + 4, [
            ["analysis", "done"],
            ["embedding", "pending"],
        ]);

        const queued = await executeVibePhase();

        expect(queued).toBe(cap);
        expect(mockQueueAdd).toHaveBeenCalledTimes(cap);
        expect(await workingCount("embedding")).toBe(cap);
    });
});
