/**
 * identifyTrackByAcoustid: which file it opens, and what it trusts from tags.
 *
 * Two bugs pinned here:
 *
 * 1. `Track.filePath` is stored relative to the music folder. The identifier
 *    handed it straight to the tag reader and to fpcalc, whose working
 *    directory is not the music folder, so both failed to open the file and
 *    the failure was swallowed -- AcoustID never ran in enrichment.
 * 2. A file's `acoustid_id` tag was returned as the MusicBrainz recording id.
 *    It is AcoustID's own fingerprint-cluster id, a different namespace, so
 *    every tagged file was given a recording id that MusicBrainz does not have.
 *
 * The step answers with an Outcome: a refusal or a lookup failure is a
 * typed kind, never a null that looks like "the source had nothing".
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
        // Defect 2: the second fpcalc path is gone. The fingerprint is the
        // fingerprint stage's answer, and the recording stage is gated on
        // that question being SETTLED (PREREQUISITE_STAGE) — so a call that
        // still arrives with no fingerprint anywhere is a leaked gate, and
        // is refused (permanent NO_FINGERPRINT): never a lookup that matched
        // nothing, never another decode of the file, and never an "owed"
        // record the sweep would re-poll forever.
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

        expect(mockLookup).toHaveBeenCalledWith(200, "TAGFP");
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "file_tag", fingerprint: "TAGFP" }),
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
        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP");
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "stored", fingerprint: "STOREDFP" }),
            );
        }
    });

    it("answers from the stored fingerprint even when the tags are unreadable", async () => {
        mockParseFile.mockRejectedValue(new Error("unreadable"));

        const out = await identifyTrackByAcoustid(track("a.flac"), null, {
            fingerprint: "STOREDFP",
        });

        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP");
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(expect.objectContaining({ source: "stored" }));
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
