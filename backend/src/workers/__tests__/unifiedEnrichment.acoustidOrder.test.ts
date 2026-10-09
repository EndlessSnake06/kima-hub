/**
 * enrichSingleTrack identifies a recording in this order: the file's recording id
 * tag (no network), its ISRC, the album's MusicBrainz tracklist, the name search,
 * then AcoustID for the remainder, storing the fingerprint even on a no-match.
 * Every candidate must be this track before it is accepted. The identification
 * services are mocked; the order, the fallbacks and the agreement check are tested.
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

const mockIdentifyRecording = jest.fn();
const mockGetRecordingIsrc = jest.fn();
const mockGetRecordingGenres = jest.fn();
const mockLookupRecordingsByIsrc = jest.fn();
const mockGetAlbumCatalogue = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        identifyRecording: (...args: unknown[]) => mockIdentifyRecording(...args),
        getRecordingGenres: (...args: unknown[]) => mockGetRecordingGenres(...args),
        // The real one makes one request for both; here it answers from the two mocks.
        getRecordingIsrcAndGenres: async (id: string) => ({
            isrc: await mockGetRecordingIsrc(id),
            genres: await mockGetRecordingGenres(id),
        }),
        lookupRecordingsByIsrc: (...args: unknown[]) => mockLookupRecordingsByIsrc(...args),
        getAlbumCatalogue: (...args: unknown[]) => mockGetAlbumCatalogue(...args),
        normalizeForSearch: (s: string) => s,
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
const mockAlbumUpdate = jest.fn().mockResolvedValue({});
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
        album: {
            update: (...args: unknown[]) => mockAlbumUpdate(...args),
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
// Daft Punk "Discovery" — real ids verified against the API; nothing here
// hits the network, the service is mocked.
const RG_MBID = "48117b90-a16e-34ca-a514-19c702df1158";
const REL_MBID = "d073287b-d1bd-4f11-a933-a4386f8cf701";

function seedTrack(
    overrides?: { isrc?: string | null; isrcSource?: string | null; rgMbid?: string | null },
) {
    mockTrackFindUnique.mockResolvedValue({
        id: TRACK_ID,
        title: "Cheerleader Effect",
        filePath: "/music/artist/album/02 - Cheerleader Effect.mp3",
        duration: 218,
        isrc: overrides?.isrc ?? null,
        isrcSource: overrides?.isrcSource ?? (overrides?.isrc ? "id3" : null),
        acoustidFingerprint: null,
        album: {
            id: "album-1",
            title: "Leather Teeth",
            artist: { name: "Carpenter Brut" },
            // A placeholder id is locally made up — with it the chain step
            // is skipped and the per-track ladder runs.
            rgMbid: overrides?.rgMbid ?? "temp-1693-abc",
            year: null,
            label: null,
            genres: null,
        },
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
        artists: [],
        duration: 218,
    });
    mockIdentifyTrackByAcoustid.mockResolvedValue({
        kind: "absent",
        evidence: { reason: "mocked: nothing to match" },
    });
    mockIdentifyRecording.mockResolvedValue(noData);
    mockGetRecordingIsrc.mockResolvedValue(noData);
    mockGetRecordingGenres.mockResolvedValue(noData);
    mockLookupRecordingsByIsrc.mockResolvedValue(noData);
    seedTrack();
});

describe("enrichSingleTrack: the identification order", () => {
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
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
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

    it("runs the name search before AcoustID, with the track's title, artist and length", async () => {
        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalledWith({
            title: "Cheerleader Effect",
            artists: ["Carpenter Brut"],
            durationSec: 218,
        });
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect(mockIdentifyRecording.mock.invocationCallOrder[0]).toBeLessThan(
            mockIdentifyTrackByAcoustid.mock.invocationCallOrder[0],
        );
    });

    it("never asks AcoustID for a track the name search answered", async () => {
        mockIdentifyRecording.mockResolvedValue(answeredWith({ id: MB_TRACK, title: "Cheerleader Effect", lengthMs: 218000, artists: ["Carpenter Brut"] }));

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: MB_TRACK }) }),
        );
    });

    it("stores the fingerprint and answers the question as Absent when nothing matches", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "absent",
            evidence: { fingerprint: FINGERPRINT },
        });

        const result = await enrichSingleTrack(TRACK_ID);

        // Nothing matched — an answer, not a failure: the record settles
        // `done` on the no-match evidence, and the Track row is not written.
        expect(result).toBe("no_match");
        expect(mockTrackUpdate).not.toHaveBeenCalled();
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(TRACK_ID, FINGERPRINT);
        expect(stageWrittenDone("acoustid")).toBe(true);
    });

    it("answers from the album's tracklist before the name search", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            answeredWith({
                releaseMbid: REL_MBID,
                originalYear: 1997,
                label: "Some Labels",
                genres: [
                    { name: "electronic", count: 5 },
                    { name: "ambient", count: 2 },
                ],
                recordings: [
                    {
                        recordingId: MB_TRACK,
                        title: "Cheerleader Effect",
                        durationMs: 218000,
                        isrcs: ["GBAYE0601498"],
                        genres: [{ name: "trip-hop", count: 3 }],
                        artists: ["Carpenter Brut"],
                    },
                ],
            }),
        );

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetAlbumCatalogue).toHaveBeenCalledWith(RG_MBID);
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        // The ISRC and the genres come from the tracklist row; the album row gets
        // its year, label and genres filled from the same fetch.
        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: TRACK_ID },
            data: { isrc: "GBAYE0601498", isrcSource: "musicbrainz" },
        });
        expect(mockPopulateTrackGenres).toHaveBeenCalledWith(TRACK_ID, ["trip-hop"]);
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: {
                year: 1997,
                label: "Some Labels",
                genres: ["electronic", "ambient"],
            },
        });
        expect(stageWrittenDone("musicbrainz")).toBe(true);
    });

    it("does not take a tracklist entry whose length says it is another version", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            answeredWith({
                releaseMbid: REL_MBID,
                originalYear: null,
                label: null,
                genres: [],
                recordings: [
                    { recordingId: "radio-edit", title: "Cheerleader Effect", durationMs: 160000, isrcs: [], genres: [], artists: ["Carpenter Brut"] },
                ],
            }),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect(mockTrackUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "radio-edit" }) }),
        );
    });

    it("defers without falling through to the search when the tracklist call fails", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue({
            kind: "transient",
            error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 },
        });

        const result = await enrichSingleTrack(TRACK_ID);

        // MusicBrainz failing outright defers with the real cause; the rest of
        // the ladder is not asked while the source is down.
        expect(result).toBe("deferred");
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(mockTrackUpdate).not.toHaveBeenCalled();
    });

    it("asks AcoustID even with the fpcalc flag off — the step needs a fingerprint, not the binary", async () => {
        mockGetFeatures.mockResolvedValue({ fpcalc: false });

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
    });

    it("reads the file's recording id before its ISRC", async () => {
        seedTrack({ isrc: "USRC17607839" });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });

        await enrichSingleTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: RECORDING }) }),
        );
    });

    it("takes the ISRC's recording that is this track, not the first one listed", async () => {
        seedTrack({ isrc: "USRC17607839" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([
                { id: "live-2014", title: "Cheerleader Effect (Live 2014)", lengthMs: 240000, artists: ["Carpenter Brut"] },
                { id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Carpenter Brut"] },
                { id: "studio", title: "Cheerleader Effect", lengthMs: 218400, artists: ["Carpenter Brut"] },
            ]),
        );

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "studio" }) }),
        );
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        // The file's own ISRC is never replaced.
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
    });

    it("goes on down the ladder when none of the ISRC's recordings is this track", async () => {
        seedTrack({ isrc: "USRC17607839" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([{ id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Paramore"] }]),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect(mockTrackUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "other-song" }) }),
        );
    });

    it("never sends a code that is not an ISRC", async () => {
        seedTrack({ isrc: "PMEDIA" });

        await enrichSingleTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect(mockIdentifyRecording).toHaveBeenCalled();
    });

    it("replaces an ISRC MusicBrainz gave for an earlier answer with the new answer's", async () => {
        seedTrack({ isrc: "GBAYE0601498", isrcSource: "musicbrainz" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([{ id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Paramore"] }]),
        );
        mockIdentifyRecording.mockResolvedValue(answeredWith({ id: MB_TRACK, title: "Cheerleader Effect", lengthMs: 218000, artists: ["Carpenter Brut"] }));
        mockGetRecordingIsrc.mockResolvedValue(answeredWith("FRX451500123"));

        await enrichSingleTrack(TRACK_ID);

        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: TRACK_ID },
            data: { isrc: "FRX451500123", isrcSource: "musicbrainz" },
        });
    });
});

describe("the album's tracklist answers before any per-track MusicBrainz call", () => {
    const tracklist = (
        recordings: Array<{ recordingId: string; title: string; durationMs: number; isrcs: string[]; artists?: string[] }>,
    ) =>
        answeredWith({
            releaseMbid: REL_MBID,
            originalYear: 2015,
            label: null,
            genres: [{ name: "synthwave", count: 3 }],
            recordings: recordings.map((r) => ({
                artists: ["Carpenter Brut"],
                ...r,
                genres: [{ name: "synthwave", count: 2 }],
            })),
        });

    it("finds an ISRC track in its album's tracklist without looking the ISRC up", async () => {
        seedTrack({ rgMbid: RG_MBID, isrc: "USRC17607839" });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "other", title: "Decode", durationMs: 218000, isrcs: ["USRC17600001"] },
                { recordingId: "studio", title: "Cheerleader Effect", durationMs: 218400, isrcs: ["USRC17607839"] },
            ]),
        );

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "studio" }) }),
        );
    });

    it("on a compilation, the row credited to the track's artist wins over a same-titled song", async () => {
        for (const order of [0, 1]) {
            jest.clearAllMocks();
            seedTrack({ rgMbid: RG_MBID });
            const rows = [
                { recordingId: "someone-else", title: "Cheerleader Effect", durationMs: 217000, isrcs: [], artists: ["Other Band"] },
                { recordingId: "ours", title: "Cheerleader Effect", durationMs: 219500, isrcs: [], artists: ["Carpenter Brut"] },
            ];
            mockGetAlbumCatalogue.mockResolvedValue(tracklist(order ? rows.reverse() : rows));

            await enrichSingleTrack(TRACK_ID);

            expect(mockTrackUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "ours" }) }),
            );
        }
    });

    it("the album vouches for a credit written another way when one row alone is the track", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "studio", title: "Cheerleader Effect", durationMs: 218400, isrcs: [], artists: ["カーペンター・ブルート"] },
                { recordingId: "other", title: "Decode", durationMs: 218000, isrcs: [], artists: ["カーペンター・ブルート"] },
            ]),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "studio" }) }),
        );
    });

    it("two uncredited rows that could both be the track: the album vouches for neither", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "first", title: "Cheerleader Effect", durationMs: 217000, isrcs: [], artists: ["Other Band"] },
                { recordingId: "second", title: "Cheerleader Effect", durationMs: 219500, isrcs: [], artists: ["Third Band"] },
            ]),
        );
        mockIdentifyRecording.mockResolvedValue(noData);

        await enrichSingleTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect(mockTrackUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: expect.stringMatching(/first|second/) }) }),
        );
    });

    it("an ISRC row that is another recording is not taken; the ISRC lookup comes next", async () => {
        seedTrack({ rgMbid: RG_MBID, isrc: "USRC17607839" });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([{ recordingId: "mislabelled", title: "Decode", durationMs: 300000, isrcs: ["USRC17607839"] }]),
        );

        await enrichSingleTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).toHaveBeenCalledWith("USRC17607839");
        expect(mockTrackUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: "mislabelled" }) }),
        );
    });

    it("a file's recording tag takes its ISRC and genres from its row in the tracklist", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([{ recordingId: RECORDING, title: "Cheerleader Effect", durationMs: 218400, isrcs: ["FRX451500123"] }]),
        );

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect(mockTrackUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ recordingMbid: RECORDING }) }),
        );
    });

    it("a file's recording tag still answers when the album's tracklist cannot be fetched", async () => {
        seedTrack({ rgMbid: RG_MBID });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });
        mockGetAlbumCatalogue.mockResolvedValue({
            kind: "transient",
            error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 },
        });
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetRecordingGenres).toHaveBeenCalledWith(RECORDING);
    });
});

describe("AcoustID paused", () => {
    it("the question waits for the pause to end and uses up no retry", async () => {
        const { sourcePauseController } = await import("../../services/sourcePauseController");
        const until = new Date(Date.now() + 30 * 60_000);
        const pause = jest.spyOn(sourcePauseController, "getPause").mockResolvedValue({
            source: "acoustid", until, code: "RATE_LIMITED", message: null,
        } as any);

        const result = await enrichSingleTrack(TRACK_ID);

        expect(result).toBe("deferred");
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        const writes = mockExecuteRawUnsafe.mock.calls.map((call) => String(call[0]));
        expect(writes.some((sql) => sql.includes(`INSERT INTO "TrackStage"`) && sql.includes("'RATE_LIMITED'"))).toBe(true);
        expect(writes.some((sql) => sql.includes("SET status = 'failed'"))).toBe(false);
        pause.mockRestore();
    });
});
