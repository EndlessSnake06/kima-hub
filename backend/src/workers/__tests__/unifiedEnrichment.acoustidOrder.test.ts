/**
 * Identification order (supersedes the earlier
 * "AcoustID first").
 *
 * Pins the order in unifiedEnrichment.enrichSingleTrack:
 *   1. The file's own identity tags — a musicbrainz_recordingid tag answers
 *      the recording question with no network call at all.
 *   2. The title-checked MusicBrainz name search — runs when the tags did
 *      not answer, and answers before AcoustID is ever asked.
 *   3. AcoustID for the remainder — only when tags and search both failed
 *      does the fingerprint path run, and its computed or tagged fingerprint
 *      is persisted even when the lookup does not match (dedupe value).
 *
 * The identification layer itself is mocked here — its wire contract is
 * covered by acoustidService.test.ts and the storage outcome by
 * src/__tests__/acoustid-fingerprint.test.ts. This suite proves the ORDER
 * and the fallback wiring in enrichSingleTrack.
 *
 * Run with: npx jest unifiedEnrichment.acoustidOrder --no-coverage
 */

// ── Mocks (must be before imports) ──────────────────────────────────

const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue(null),
        initializeState: jest.fn().mockResolvedValue({}),
        clear: jest.fn().mockResolvedValue(undefined),
        detectHang: jest.fn().mockResolvedValue(false),
        clearGate: jest.fn().mockResolvedValue(undefined),
        publishToChannel: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        recordFailure: jest.fn().mockResolvedValue({}),
        resolveByEntity: jest.fn().mockResolvedValue(true),
        clearFailure: jest.fn().mockResolvedValue(true),
        clearAllFailures: jest.fn().mockResolvedValue(0),
    },
}));

// fpcalc gate: on by default; individual tests flip it via the exported mock.
const mockGetFeatures = jest.fn().mockResolvedValue({ fpcalc: true });
jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: () => mockGetFeatures(),
    },
}));

const mockReadTags = jest.fn();
const mockIdentifyTrackByAcoustid = jest.fn();
const mockPersistAcoustidFingerprint = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/acoustidIdentification", () => ({
    readIdentityTags: (...args: unknown[]) => mockReadTags(...args),
    identifyTrackByAcoustid: (...args: unknown[]) =>
        mockIdentifyTrackByAcoustid(...args),
    persistAcoustidFingerprint: (...args: unknown[]) =>
        mockPersistAcoustidFingerprint(...args),
}));

const mockSearchRecording = jest.fn();
const mockGetRecordingIsrc = jest.fn();
const mockGetRecordingGenres = jest.fn();
const mockLookupByIsrc = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: (...args: unknown[]) => mockSearchRecording(...args),
        getRecordingIsrc: (...args: unknown[]) => mockGetRecordingIsrc(...args),
        getRecordingGenres: (...args: unknown[]) => mockGetRecordingGenres(...args),
        lookupByIsrc: (...args: unknown[]) => mockLookupByIsrc(...args),
    },
}));

const mockStoreIsrc = jest.fn().mockResolvedValue(undefined);
const mockPopulateTrackGenres = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        storeIsrc: (...args: unknown[]) => mockStoreIsrc(...args),
        populateTrackGenres: (...args: unknown[]) => mockPopulateTrackGenres(...args),
    },
}));

const mockRedisPublish = jest.fn().mockResolvedValue(1);
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);
const mockRedisSubscribe = jest.fn().mockResolvedValue(undefined);
const mockRedisOn = jest.fn();
const mockRedisSet = jest.fn().mockResolvedValue("OK");
const mockRedisRpush = jest.fn().mockResolvedValue(1);
const mockRedisLlen = jest.fn().mockResolvedValue(0);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisGet = jest.fn().mockResolvedValue(null);

jest.mock("ioredis", () => {
    return jest.fn().mockImplementation(() => ({
        publish: mockRedisPublish,
        quit: mockRedisQuit,
        subscribe: mockRedisSubscribe,
        on: mockRedisOn,
        set: mockRedisSet,
        rpush: mockRedisRpush,
        llen: mockRedisLlen,
        del: mockRedisDel,
        get: mockRedisGet,
        status: "ready",
    }));
});

jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379" },
}));

jest.mock("../enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: { add: jest.fn() },
    trackQueue: { add: jest.fn() },
    vibeQueue: { add: jest.fn() },
    podcastQueue: { add: jest.fn() },
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

const mockTrackFindUnique = jest.fn();
const mockTrackUpdate = jest.fn().mockResolvedValue({});
const mockExecuteRawUnsafe = jest.fn().mockResolvedValue(1);

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        track: {
            findUnique: (...args: unknown[]) => mockTrackFindUnique(...args),
            findMany: jest.fn().mockResolvedValue([]),
            update: (...args: unknown[]) => mockTrackUpdate(...args),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            count: jest.fn().mockResolvedValue(0),
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        // Source pause reads and stage-record writes (SourceAttempt / TrackStage).
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
        $executeRawUnsafe: (...args: unknown[]) => mockExecuteRawUnsafe(...args),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { enrichSingleTrack } from "../unifiedEnrichment";

const TRACK_ID = "track-1";
const RECORDING = "rec-aaaa-bbbb";
const MB_TRACK = "mb-track-1";
const FINGERPRINT = "AQAA0pMiRZkQ";

function seedTrack(overrides?: { isrc?: string | null }) {
    mockTrackFindUnique.mockResolvedValue({
        id: TRACK_ID,
        title: "Cheerleader Effect",
        filePath: "/music/artist/album/02 - Cheerleader Effect.mp3",
        duration: 218,
        isrc: overrides?.isrc ?? null,
        album: { artist: { name: "Carpenter Brut" } },
    });
}

/** True when the TrackStage row was written `done` by `source`. */
function stageWrittenDone(source: string): boolean {
    return mockExecuteRawUnsafe.mock.calls.some(
        (call) =>
            String(call[0]).includes(`INSERT INTO "TrackStage"`) &&
            String(call[0]).includes("'done'") &&
            call.includes(source),
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFeatures.mockResolvedValue({ fpcalc: true });
    mockReadTags.mockResolvedValue({
        recordingMbid: null,
        fingerprint: null,
        duration: 218,
    });
    mockIdentifyTrackByAcoustid.mockResolvedValue({
        kind: "absent",
        evidence: { reason: "mocked: nothing to match" },
    });
    mockSearchRecording.mockResolvedValue(noData);
    mockGetRecordingIsrc.mockResolvedValue(noData);
    mockGetRecordingGenres.mockResolvedValue(noData);
    mockLookupByIsrc.mockResolvedValue(noData);
    seedTrack();
});

describe("enrichSingleTrack: the 2026-09-24 identification order", () => {
    it("answers from the file's recording-id tag without any network call", async () => {
        mockReadTags.mockResolvedValue({
            recordingMbid: RECORDING,
            fingerprint: FINGERPRINT,
            duration: 218,
        });

        await enrichSingleTrack(TRACK_ID);

        expect(mockReadTags).toHaveBeenCalledWith(
            expect.objectContaining({ id: TRACK_ID, filePath: expect.any(String) }),
        );
        // Tags answered — neither the search nor the fingerprint path runs.
        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        // The tag's fingerprint is stored too (dedupe value, zero cost).
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(
            TRACK_ID,
            FINGERPRINT,
        );
        // The answer lands on Track and on the stage record.
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ recordingMbid: RECORDING }),
            }),
        );
        expect(stageWrittenDone("file_tag")).toBe(true);
    });

    it("runs the title-checked MusicBrainz search before AcoustID when there are no tags", async () => {
        mockSearchRecording.mockResolvedValue(
            answeredWith({
                trackMbid: MB_TRACK,
                albumName: "Leather Teeth",
                albumMbid: "rg-1",
                artistMbid: "ar-1",
            }),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockSearchRecording).toHaveBeenCalledWith(
            "Cheerleader Effect",
            "Carpenter Brut",
        );
        // The search answered, so AcoustID is never asked — this is the
        // reversal of the 2026-09-01 order.
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ recordingMbid: MB_TRACK }),
            }),
        );
        expect(stageWrittenDone("musicbrainz")).toBe(true);
    });

    it("asks AcoustID only for the track the name search could not answer", async () => {
        mockReadTags.mockResolvedValue({
            recordingMbid: null,
            fingerprint: FINGERPRINT,
            duration: 218,
        });
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({
                source: "fpcalc",
                recordingMbid: RECORDING,
                fingerprint: FINGERPRINT,
            }),
        );

        await enrichSingleTrack(TRACK_ID);

        // Tags had no recording id → search ran first → only now AcoustID.
        expect(mockSearchRecording).toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect(
            mockIdentifyTrackByAcoustid.mock.invocationCallOrder[0],
        ).toBeGreaterThan(mockSearchRecording.mock.invocationCallOrder[0]);
        // It used the tag's fingerprint, and the answer lands on Track.
        // (Third argument: no stored fingerprint on the track yet — this is
        // the run that produces the one the fingerprint stage will store.)
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalledWith(
            expect.objectContaining({ id: TRACK_ID }),
            expect.objectContaining({ fingerprint: FINGERPRINT }),
            null,
        );
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ recordingMbid: RECORDING }),
            }),
        );
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(
            TRACK_ID,
            FINGERPRINT,
        );
    });

    it("stores the fingerprint and answers the question as Absent when the lookup does not match", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "absent",
            evidence: { fingerprint: FINGERPRINT },
        });

        await enrichSingleTrack(TRACK_ID);

        // Nothing matched — an answer, not a failure: the record
        // settles `done` on the no-match evidence, and the track keeps
        // the no-tags sentinel.
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ enrichmentTags: ["_not_found"] }),
            }),
        );
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(
            TRACK_ID,
            FINGERPRINT,
        );
        expect(stageWrittenDone("acoustid")).toBe(true);
    });

    it("asks AcoustID even with the fpcalc flag off — the step needs a fingerprint, not the binary", async () => {
        mockGetFeatures.mockResolvedValue({ fpcalc: false });

        await enrichSingleTrack(TRACK_ID);

        // features.fpcalc gates the FINGERPRINT stage; the recording stage's
        // AcoustID step reads Track.acoustidFingerprint (the stage's stored
        // answer) — the local binary is irrelevant to it.
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        // The name search still answers first what it can.
        expect(mockSearchRecording).toHaveBeenCalledWith(
            "Cheerleader Effect",
            "Carpenter Brut",
        );
    });

    it("does not attempt any identification when the track already has an ISRC", async () => {
        seedTrack({ isrc: "FR10S1700001" });
        mockLookupByIsrc.mockResolvedValue(
            answeredWith({
                recordingId: RECORDING,
                title: "Cheerleader Effect",
                artistName: "Carpenter Brut",
                artistMbid: "ar-1",
            }),
        );
        mockGetRecordingGenres.mockResolvedValue(
            answeredWith({
                genres: [{ name: "electronic", count: 3 }],
                tags: [],
            }),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockReadTags).not.toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockSearchRecording).not.toHaveBeenCalled();
        // Known identifier: the recording is looked up from the ISRC
        // directly, and mood tags come from that same recording.
        expect(mockLookupByIsrc).toHaveBeenCalledWith("FR10S1700001");
        expect(mockGetRecordingGenres).toHaveBeenCalledWith(RECORDING);
        // ISRC already known — no point fetching it again.
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        // And the recording answer lands on Track.
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ recordingMbid: RECORDING }),
            }),
        );
    });
});
