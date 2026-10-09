/**
 * identifyTrackByAcoustid opens the file through the music folder (filePath is
 * stored relative to it), and never treats an `acoustid_id` tag as a
 * MusicBrainz recording id. Refusals and lookup failures are typed Outcomes.
 */

jest.mock("../../config", () => ({ config: { music: { musicPath: "/srv/music" } } }));
jest.mock("../../utils/db", () => ({ prisma: { track: { update: jest.fn() } } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../utils/metrics", () => ({ acoustidTrackIdentityTotal: { inc: jest.fn() } }));

const mockParseFile = jest.fn();
jest.mock("music-metadata", () => ({ parseFile: (...a: unknown[]) => mockParseFile(...a) }));

const mockFingerprintFile = jest.fn();
jest.mock("../fpcalc", () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(true),
        fingerprintFile: (...a: unknown[]) => mockFingerprintFile(...a),
    },
}));

const mockLookup = jest.fn();
jest.mock("../acoustidService", () => ({
    acoustidService: { lookup: (...a: unknown[]) => mockLookup(...a) },
}));

import { identifyTrackByAcoustid } from "../acoustidIdentification";
import { answered } from "../../utils/outcome";

const RECORDING = "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae";
const ACOUSTID_TRACK = "9ff43b6a-4f16-427c-93c2-92307ca505e0";

const track = (filePath: string) => ({ id: "t1", title: "Song", filePath, duration: 200 });
const tags = (common: Record<string, unknown>) => ({ common, format: { duration: 200 } });

beforeEach(() => {
    jest.clearAllMocks();
    mockParseFile.mockResolvedValue(tags({}));
    mockFingerprintFile.mockResolvedValue({ duration: 200, fingerprint: "FP" });
    mockLookup.mockResolvedValue(
        answered(
            {
                recordingMbid: RECORDING,
                artistMbid: "",
                releaseGroupMbid: "",
                title: "Song",
                artist: "",
                album: "",
            },
            { score: 0.9 },
        ),
    );
});

describe("identifyTrackByAcoustid: the file it opens", () => {
    it("with no fingerprint anywhere, the step refuses — fpcalc is never run, never a fake answer", async () => {
        // With no fingerprint anywhere the step refuses (permanent
        // NO_FINGERPRINT): no lookup and no second decode of the file.
        const out = await identifyTrackByAcoustid(
            track("Artist/Album/01 Song.flac"),
        );

        expect(mockParseFile).toHaveBeenCalledWith("/srv/music/Artist/Album/01 Song.flac");
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
        expect(out.kind).toBe("permanent");
        if (out.kind === "permanent") {
            expect(out.error.code).toBe("NO_FINGERPRINT");
        }
    });

    it("refuses a stored path that would escape the music folder", async () => {
        const out = await identifyTrackByAcoustid(track("../../etc/passwd"));

        expect(out.kind).toBe("permanent");
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();
    });
});

describe("identifyTrackByAcoustid: what it trusts from tags", () => {
    it("never returns an acoustid_id tag as the recording id", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_id: ACOUSTID_TRACK }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        // The tag names a fingerprint cluster, not a recording — and with no
        // fingerprint to ask with the step refuses rather than run fpcalc.
        expect(out.kind).toBe("permanent");
        if (out.kind === "permanent") {
            expect(out.error.code).toBe("NO_FINGERPRINT");
        }
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
    });

    it("takes a musicbrainz_recordingid tag as the recording, with no network call", async () => {
        const tagged = "0b3d3c4e-1111-2222-3333-444455556666";
        mockParseFile.mockResolvedValue(tags({ musicbrainz_recordingid: tagged }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "file_tag", recordingMbid: tagged }),
            );
        }
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();
    });

    it("looks up a stored acoustid_fingerprint tag instead of running fpcalc", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAGFP" }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(mockLookup).toHaveBeenCalledWith(200, "TAGFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "acoustid", fingerprintFrom: "file tag", fingerprint: "TAGFP" }),
            );
        }
    });
});

describe("identifyTrackByAcoustid: the stored fingerprint", () => {
    it("answers from Track.acoustidFingerprint and never calls fpcalc", async () => {
        mockParseFile.mockResolvedValue(tags({}));

        const out = await identifyTrackByAcoustid(track("a.flac"), null, {
            fingerprint: "STOREDFP",
        });

        // One lookup with the fingerprint the stage already measured.
        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "acoustid", fingerprintFrom: "stored", fingerprint: "STOREDFP" }),
            );
        }
    });

    it("answers from the stored fingerprint even when the tags are unreadable", async () => {
        mockParseFile.mockRejectedValue(new Error("unreadable"));

        const out = await identifyTrackByAcoustid(track("a.flac"), null, {
            fingerprint: "STOREDFP",
        });

        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(expect.objectContaining({ source: "acoustid", fingerprintFrom: "stored" }));
        }
    });

    it("passes a lookup failure through as the same kind — the question stays open", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAGFP" }));
        mockLookup.mockResolvedValue({
            kind: "transient",
            error: { code: "REQUEST_FAILED", message: "ECONNREFUSED" },
        });

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(out.kind).toBe("transient");
        if (out.kind === "transient") {
            expect(out.error.message).toBe("ECONNREFUSED");
        }
    });
});
