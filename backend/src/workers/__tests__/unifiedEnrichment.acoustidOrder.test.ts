/**
 * AcoustID-first enrichment order.
 *
 * enrichSingleTrack identifies a
 * track without an ISRC via (1) the file's AcoustID tag, (2) a fresh
 * fpcalc fingerprint through the AcoustID lookup, and only (3) falls back
 * to the pre-existing MusicBrainz title/artist search. The fingerprint
 * behind a match is persisted on Track.acoustidFingerprint for intra-library
 * duplicate/version detection, and the whole path is gated on
 * featureDetection().fpcalc (binary present, not disabled).
 *
 * The identification layer itself is mocked here — its wire contract is
 * covered by acoustidService.test.ts. This suite proves the ORDER and the
 * fallback wiring in unifiedEnrichment.enrichSingleTrack.
 *
 * Run with: npx jest unifiedEnrichment.acoustidOrder --no-coverage
 */

// ── Mocks (must be before imports) ──────────────────────────────────

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

jest.mock("../../services/audioAnalysisCleanup", () => ({
    audioAnalysisCleanupService: {
        cleanupStaleProcessing: jest.fn().mockResolvedValue({
            reset: 0,
            permanentlyFailed: 0,
            recovered: 0,
        }),
        resetCircuitBreaker: jest.fn(),
        isCircuitOpen: jest.fn().mockReturnValue(false),
    },
}));

// fpcalc gate: on by default; individual tests flip it via the exported mock.
const mockGetFeatures = jest.fn().mockResolvedValue({ fpcalc: true });
jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: () => mockGetFeatures(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getTrackInfo: jest.fn().mockResolvedValue({ toptags: { tag: [] } }),
    },
}));

const mockIdentifyTrackByAcoustid = jest.fn().mockResolvedValue(null);
const mockPersistAcoustidFingerprint = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/acoustidIdentification", () => ({
    identifyTrackByAcoustid: (...args: unknown[]) =>
        mockIdentifyTrackByAcoustid(...args),
    persistAcoustidFingerprint: (...args: unknown[]) =>
        mockPersistAcoustidFingerprint(...args),
}));

const mockSearchRecording = jest.fn().mockResolvedValue(null);
const mockGetRecordingIsrc = jest.fn().mockResolvedValue(null);
const mockGetRecordingGenres = jest.fn().mockResolvedValue(null);
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: (...args: unknown[]) => mockSearchRecording(...args),
        getRecordingIsrc: (...args: unknown[]) => mockGetRecordingIsrc(...args),
        getRecordingGenres: (...args: unknown[]) => mockGetRecordingGenres(...args),
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
const FINGERPRINT = "AQAA0pMiRZkQ";

function seedTrack() {
    mockTrackFindUnique.mockResolvedValue({
        id: TRACK_ID,
        title: "Cheerleader Effect",
        filePath: "/music/artist/album/02 - Cheerleader Effect.mp3",
        duration: 218,
        isrc: null,
        album: { artist: { name: "Carpenter Brut" } },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFeatures.mockResolvedValue({ fpcalc: true });
    seedTrack();
});

describe("enrichSingleTrack: AcoustID-first identification order", () => {
    it("uses the MB recording APIs directly when AcoustID resolves via file tag", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            source: "file_tag",
            recordingMbid: RECORDING,
        });

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalledWith(
            expect.objectContaining({ id: TRACK_ID, filePath: expect.any(String) }),
        );
        expect(mockGetRecordingIsrc).toHaveBeenCalledWith(RECORDING);
        expect(mockGetRecordingGenres).toHaveBeenCalledWith(RECORDING);
        // AcoustID resolved: the MusicBrainz text search must NOT run.
        expect(mockSearchRecording).not.toHaveBeenCalled();
    });

    it("persists the fingerprint when the match came from one (fpcalc path)", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            source: "fpcalc",
            recordingMbid: RECORDING,
            fingerprint: FINGERPRINT,
        });

        await enrichSingleTrack(TRACK_ID);

        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(
            TRACK_ID,
            FINGERPRINT,
        );
        expect(mockSearchRecording).not.toHaveBeenCalled();
    });

    it("falls back to the MusicBrainz search when AcoustID returns null", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue(null);
        mockSearchRecording.mockResolvedValue({
            trackMbid: "mb-track-1",
            albumName: "Leather Teeth",
            albumMbid: "rg-1",
            artistMbid: "ar-1",
        });

        await enrichSingleTrack(TRACK_ID);

        expect(mockSearchRecording).toHaveBeenCalledWith(
            "Cheerleader Effect",
            "Carpenter Brut",
        );
        expect(mockGetRecordingIsrc).toHaveBeenCalledWith("mb-track-1");
        expect(mockPersistAcoustidFingerprint).not.toHaveBeenCalled();
    });

    it("skips AcoustID entirely when the fpcalc feature flag is off", async () => {
        mockGetFeatures.mockResolvedValue({ fpcalc: false });

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockPersistAcoustidFingerprint).not.toHaveBeenCalled();
        expect(mockSearchRecording).toHaveBeenCalledWith(
            "Cheerleader Effect",
            "Carpenter Brut",
        );
    });

    it("does not attempt any identification when the track already has an ISRC", async () => {
        mockTrackFindUnique.mockResolvedValue({
            id: TRACK_ID,
            title: "Cheerleader Effect",
            filePath: "/music/artist/album/02 - Cheerleader Effect.mp3",
            duration: 218,
            isrc: "FR10S1700001",
            album: { artist: { name: "Carpenter Brut" } },
        });

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockGetFeatures).not.toHaveBeenCalled();
    });
});
