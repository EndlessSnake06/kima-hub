/**
 * Per-track stage gating.
 *
 * The chain is per track: recording -> analysis -> embedding. A track that
 * is failed, parked, or still waiting must never hold another track's stage
 * behind it, and an unanalysed track must never be embedded.
 *
 * These drive the real phase functions against this checkout's own test DB
 * (the harness clones one per worker), with BullMQ/Redis/services mocked so
 * the assertions are about which work each phase offers. They fail on the
 * current code — where a global `audioInFlight` count and status-column
 * sweeps decide everything — and pass once the stage queue lands.
 *
 * Run: cd backend && npx jest src/workers/__tests__/stageGating.test.ts --forceExit --maxWorkers=1
 */

// ── Queue + Redis mocks: observe what gets offered ───────────────────────

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../enrichmentQueues", () => ({
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
jest.mock("../../config", () => ({ config: { redisUrl: "redis://localhost:6379" } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// NOTE: `../../utils/db` is deliberately NOT mocked — the gating must be
// proven against the real TrackStage table that the migration creates.

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
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        clearAllFailures: jest.fn().mockResolvedValue(0),
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
}));

jest.mock("../../services/artistSimilarity", () => ({
    MIN_LOCAL_TRACKS: 5,
    rebuildArtistCentroid: jest.fn().mockResolvedValue({ trackCount: 0 }),
}));

jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));

import { prisma } from "../../utils/db";
import {
    executeVibePhase,
    executeAudioPhase,
    executeMoodTagsPhase,
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "../unifiedEnrichment";

const PREFIX = "gate";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                attempt = EXCLUDED.attempt,
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status, "analyzer",
        opts.attempt ?? 0, opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
}

/** Full chain: recording done -> analysis `analysisStatus` -> embedding owed. */
async function seedTrack(
    trackId: string,
    opts: {
        analysisStatus?: string;
        recordingStatus?: string;
        analysisStatusOfRecord?: string;
        embeddingStatus?: string;
        retryCount?: number;
        recordRetryable?: boolean;
        nextRetryAt?: Date | null;
    } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: opts.analysisStatus ?? "pending",
            analysisRetryCount: opts.retryCount ?? 0,
            enrichmentTags: [],
        },
    });
    await putStage(trackId, "recording", opts.recordingStatus ?? "done", { attempt: 1 });
    await putStage(trackId, "analysis", opts.analysisStatusOfRecord ?? "pending", {
        attempt: opts.retryCount ?? 0,
        retryable: opts.recordRetryable ?? true,
        nextRetryAt: opts.nextRetryAt ?? null,
    });
    await putStage(trackId, "embedding", opts.embeddingStatus ?? "pending");
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function seedFkChain(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Gate Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Gate Album", primaryType: "Album" },
    });
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(mockQueueGetJob).mockResolvedValue(null as never);
    jest.mocked(mockRedis.llen).mockResolvedValue(0);
    jest.mocked(mockRedis.get).mockResolvedValue(null as never);
    await wipe();
    await seedFkChain();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("per-track stage gating", () => {
    describe("a failed or pending track never blocks another track's stage", () => {
        it("embeds the ready track while another track's analysis is dead", async () => {
            // A's analysis is terminal (not retryable) — the old code counted
            // it in `audioInFlight` and returned 0 for the whole phase, so B
            // was never embedded while A sat failed.
            await seedTrack(id("dead"), {
                analysisStatus: "failed",
                analysisStatusOfRecord: "failed",
                retryCount: 3,
            });
            await seedTrack(id("ready"), {
                analysisStatus: "completed",
                analysisStatusOfRecord: "done",
            });

            const queued = await executeVibePhase();

            expect(queued).toBe(1);
            const embedded = mockQueueAdd.mock.calls
                .filter((c) => c[0] === "embed")
                .map((c) => (c[1] as { trackId: string }).trackId);
            expect(embedded).toEqual([id("ready")]);
        });

        it("still offers work when a track is merely pending, not failed", async () => {
            await seedTrack(id("slow"), { analysisStatus: "pending" });
            await seedTrack(id("ready"), {
                analysisStatus: "completed",
                analysisStatusOfRecord: "done",
            });

            await expect(executeVibePhase()).resolves.toBe(1);
        });

        it("never embeds a track whose analysis record is not done", async () => {
            // Embedding still says 'pending', but the analysis record is
            // terminal — gating must read the record, not offer embedding.
            await seedTrack(id("unanalysed"), {
                analysisStatus: "pending",
                analysisStatusOfRecord: "failed",
            });

            const queued = await executeVibePhase();
            expect(queued).toBe(0);
        });

        it("keys each attempt with its own jobId, not the shared stage key", async () => {
            await seedTrack(id("t1"), {
                analysisStatus: "completed",
                analysisStatusOfRecord: "done",
            });

            await executeVibePhase();

            // A failed job still holds `vibe-<id>`; attempt 1 must not reuse it.
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "embed",
                expect.objectContaining({ trackId: id("t1") }),
                expect.objectContaining({ jobId: `track-${id("t1")}-embedding-1` }),
            );
        });
    });

    describe("the deleted workarounds", () => {
        it("does not drain a purgatory track to permanently_failed", async () => {
            // A track past its retry cap: the old purgatory drain condemned it
            // (or "recovered" it) by rewriting analysisStatus.
            await seedTrack(id("stuck"), {
                analysisStatus: "pending",
                analysisStatusOfRecord: "failed",
                retryCount: 5,
            });

            await executeAudioPhase();

            const track = await prisma.track.findUnique({
                where: { id: id("stuck") },
                select: { analysisStatus: true },
            });
            // The record holds the answer (failed + retryable); the column is
            // never rewritten to a status the record contradicts.
            expect(track?.analysisStatus).toBe("pending");
        });

        it("does not flush audio:analysis:queue on a stale analyzer heartbeat", async () => {
            // Stale heartbeat with work queued: the old dead-analyzer reset
            // flushed the whole list and flipped every 'queued' row to pending.
            jest.mocked(mockRedis.get).mockResolvedValue(
                String(Date.now() - 10 * 60_000),
            );
            jest.mocked(mockRedis.llen).mockResolvedValue(50);
            await seedTrack(id("t1"), { analysisStatus: "queued" });

            await executeAudioPhase();

            const flushed = mockRedis.del.mock.calls.some(
                (call) => call[0] === "audio:analysis:queue",
            );
            expect(flushed).toBe(false);
        });

        it("does not reset processing/queued rows on startup", async () => {
            await seedTrack(id("mid"), { analysisStatus: "processing" });

            await startUnifiedEnrichmentWorker();
            await stopUnifiedEnrichmentWorker();

            const track = await prisma.track.findUnique({
                where: { id: id("mid") },
                select: { analysisStatus: true },
            });
            // Crash recovery is replaced by the stage queue: the record owns
            // the attempt, so startup does not flip the column back.
            expect(track?.analysisStatus).toBe("processing");
        });

        it("does not re-queue tracks from the enrichmentTags record", async () => {
            // The record-driven re-queue selected tracks whose enrichmentTags
            // was empty and re-added `track-<id>`. Selection now comes from
            // the stage record, so a track whose recording stage is answered
            // is not re-offered just because its tags are empty.
            await seedTrack(id("answered"), {
                analysisStatus: "completed",
                recordingStatus: "done",
            });

            await executeMoodTagsPhase();

            const trackJobs = mockQueueAdd.mock.calls
                .filter((c) => c[0] === "enrich")
                .map((c) => c[2] as { jobId: string });
            expect(trackJobs).not.toContain(`track-${id("answered")}`);
        });
    });

    describe("the stage queue replaces the recurring re-sweep", () => {
        it("offers each stage from its own record, gated per track", async () => {
            // A: recording answered, analysis owed. B: analysis answered,
            // embedding owed. Both must be offered for their owed stage only.
            await seedTrack(id("a"), {
                analysisStatus: "pending",
                recordingStatus: "done",
                analysisStatusOfRecord: "pending",
                embeddingStatus: "pending",
            });
            await seedTrack(id("b"), {
                analysisStatus: "completed",
                recordingStatus: "done",
                analysisStatusOfRecord: "done",
                embeddingStatus: "pending",
            });

            await executeAudioPhase();

            const pushed = mockRedis.rpush.mock.calls.map(
                (c) => (JSON.parse(c[1] as string) as { trackId: string }).trackId,
            );
            // Only the analysis stage feeds this queue, and A's record is the
            // only one that owes it — B's analysis is answered, so its owed
            // stage is embedding and must not appear here.
            expect(pushed).toEqual([id("a")]);
        });

        it("re-offers a failed track whose record is due, and never re-asks an answered one", async () => {
            // Selection must come from the stage RECORD, not from Track's
            // status column. Current code selects on
            // `analysisStatus: "pending"`, so `stuck` (column 'failed') is
            // never offered again while `answered` (column 'pending', record
            // done) is re-asked forever.
            await seedTrack(id("stuck"), {
                analysisStatus: "failed",
                analysisStatusOfRecord: "failed",
                recordRetryable: true,
                nextRetryAt: new Date(Date.now() - 60_000),
            });
            await seedTrack(id("answered"), {
                analysisStatus: "pending",
                analysisStatusOfRecord: "done",
            });

            await executeAudioPhase();

            const pushed = mockRedis.rpush.mock.calls.map(
                (c) => (JSON.parse(c[1] as string) as { trackId: string }).trackId,
            );
            expect(pushed).toEqual([id("stuck")]);
        });

        it("re-claims a record whose lease expired and advances its attempt", async () => {
            // First cycle: the record is claimed 'working' with a lease, so
            // a second cycle must NOT double-offer it while the lease holds.
            await seedTrack(id("t1"), {
                analysisStatus: "pending",
                analysisStatusOfRecord: "pending",
            });

            expect(await executeAudioPhase()).toBe(1);
            const claimed = await prisma.$queryRawUnsafe<
                Array<{ status: string; attempt: number; nextRetryAt: Date | null }>
            >(
                `SELECT status, attempt, "nextRetryAt" FROM "TrackStage"
                  WHERE "trackId" = $1 AND stage = 'analysis'`,
                id("t1"),
            );
            expect(claimed[0]?.status).toBe("working");
            expect(claimed[0]?.nextRetryAt).not.toBeNull();
            expect(await executeAudioPhase()).toBe(0);

            // The lease elapses (the analyzer died mid-attempt): the record
            // comes back with a fresh attempt number in the pushed entry.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage" SET "nextRetryAt" = now() - interval '1 minute'
                  WHERE "trackId" = $1 AND stage = 'analysis'`,
                id("t1"),
            );
            expect(await executeAudioPhase()).toBe(1);
            const pushed = mockRedis.rpush.mock.calls.map(
                (c) => JSON.parse(c[1] as string) as { jobId: string },
            );
            expect(pushed[0]?.jobId).toBe(`track-${id("t1")}-analysis-1`);
            expect(pushed[1]?.jobId).toBe(`track-${id("t1")}-analysis-2`);
        });

        it("declares exactly the four stages of the graph", async () => {
            const { STAGE_ORDER, PREREQUISITE_STAGE } = await import("../unifiedEnrichment");
            expect(STAGE_ORDER).toEqual(["recording", "analysis", "embedding", "fingerprint"]);
            // The map states what each stage READS, not the order stages are
            // listed in. Recording waits for the fingerprint QUESTION to be
            // settled — a done answer (use the stored fingerprint) or a
            // closed permanent failure (skip AcoustID, record the skip).
            // Embedding waits for analysis's OUTPUT: only a done answer
            // unblocks it, a closed analysis failure wrote no valence.
            expect(PREREQUISITE_STAGE.recording).toEqual({
                stage: "fingerprint", wait: "settled",
            });
            expect(PREREQUISITE_STAGE.analysis).toBeNull();
            expect(PREREQUISITE_STAGE.embedding).toEqual({
                stage: "analysis", wait: "output",
            });
            // The fingerprint sweep covers every track — nothing gates it.
            expect(PREREQUISITE_STAGE.fingerprint).toBeNull();
        });
    });

    describe("the real dependency graph (principle 4: each stage waits only for what it reads)", () => {
        it("still offers analysis for a track whose recording stage failed", async () => {
            // MusicBrainz never answered the identity question, but the file
            // itself is fine: analysis reads only the audio. The 25 tracks the
            // old engine stranded are exactly this shape — recording failed,
            // retry due, and analysis never offered behind it.
            await seedTrack(id("unheard"), {
                recordingStatus: "failed",
                analysisStatus: "pending",
                analysisStatusOfRecord: "pending",
            });

            const queued = await executeAudioPhase();

            expect(queued).toBe(1);
            const pushed = mockRedis.rpush.mock.calls.map(
                (c) => (JSON.parse(c[1] as string) as { trackId: string }).trackId,
            );
            expect(pushed).toEqual([id("unheard")]);
        });

        it("embeds a track whose analysis is done even though its recording failed", async () => {
            // Embedding waits only for analysis (it blends the Essentia
            // valence/arousal analysis wrote). The open recording question is
            // this track's own unanswered identity, not a gate for anything.
            await seedTrack(id("lone"), {
                recordingStatus: "failed",
                analysisStatus: "completed",
                analysisStatusOfRecord: "done",
                embeddingStatus: "pending",
            });

            await expect(executeVibePhase()).resolves.toBe(1);
            const embedded = mockQueueAdd.mock.calls
                .filter((c) => c[0] === "embed")
                .map((c) => (c[1] as { trackId: string }).trackId);
            expect(embedded).toEqual([id("lone")]);
        });
    });
});