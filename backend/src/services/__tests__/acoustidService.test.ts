/**
 * AcoustID service tests — mocked HTTP (no live calls; AcoustID is a
 * rate-limited public API and the contract is that failures fall through
 * silently to the MusicBrainz path).
 *
 * The mocked wire shape here is NOT invented: it is copied from a live
 * lookup against api.acoustid.org/v2/lookup (2026-09-10, Carpenter Brut
 * track, score 0.9986) —
 *   {status: "ok", results: [{id, score, recordings:
 *     [{id, title, artists: [{id, name}], releasegroups: [{id, title}]}]}]}
 * Results WITHOUT a "recordings" array occur in the wild (bare fingerprint
 * match) and must be skipped — covered below.
 *
 * Proves:
 *  - happy path: confident match with release-group resolves to the full
 *    AcoustIDResult shape;
 *  - low-score results are skipped; a result below the 0.5 floor never
 *    resolves;
 *  - duration-sanity guard: a match whose canonical length is less than
 *    half the queried duration (or under 30s) is rejected — the
 *    "matched a 12-second sample" false-positive class;
 *  - a bare result (no recordings attached) never resolves;
 *  - network error / non-ok status / empty results all resolve to null
 *    WITHOUT throwing (the silent-fallthrough contract);
 *  - missing fingerprint or non-finite duration short-circuits to null
 *    without any HTTP call at all;
 *  - the request body is form-encoded with meta=recordings%20releasegroups
 *    (a literal '+' is NOT form-decoded by the AcoustID server — verified
 *    live: it silently drops the recording data), the duration parameter
 *    is named "duration" (not "track"), and the content type is
 *    application/x-www-form-urlencoded.
 */

import { acoustidService } from "../acoustidService";

/**
 * The service builds its own axios instance in the constructor; tests inject
 * a mock client directly (same pattern as audiobookshelf.test.ts).
 */
function setupClient() {
    const post = jest.fn();
    (acoustidService as any).client = { post };
    return post;
}

const RECORDING = "8f6a1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const ARTIST = "11111111-1111-1111-1111-111111111111";
const RG = "0e5df449-0e51-4f4f-9a33-6a17e7c6b717";

/** Live wire shape: results carry recordings; recordings carry the metadata. */
function lookupResponse(results: unknown[]) {
    return { data: { status: "ok", results } };
}

function recordingResult(overrides: Record<string, unknown> = {}) {
    return {
        id: RECORDING,
        score: 0.92,
        duration: 200,
        recordings: [
            {
                id: RECORDING,
                title: "Song",
                artists: [{ id: ARTIST, name: "Artist" }],
                releasegroups: [{ id: RG, title: "Album" }],
            },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe("acoustidService.lookup", () => {
    it("resolves a confident match to the full result shape", async () => {
        setupClient().mockResolvedValue(lookupResponse([recordingResult()]));
        const res = await acoustidService.lookup(200, "aqA_ fingerprint");
        expect(res).toEqual({
            recordingMbid: RECORDING,
            artistMbid: ARTIST,
            releaseGroupMbid: RG,
            title: "Song",
            artist: "Artist",
            album: "Album",
        });
    });

    it("skips results below the 0.5 score floor and takes the next that qualifies", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([
                recordingResult({ id: "weak", score: 0.4 }),
                recordingResult({ score: 0.7 }),
            ]),
        );
        const res = await acoustidService.lookup(200, "fp");
        expect(res?.releaseGroupMbid).toBe(RG);
    });

    it("rejects a match whose duration is less than half the queried duration", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ duration: 60 })]),
        );
        // 60s record vs 200s query: the |rec−query| > query/2 guard fires.
        const res = await acoustidService.lookup(200, "fp");
        expect(res).toBeNull();
    });

    it("rejects sub-30s matches even at score 1.0", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ duration: 25, score: 1.0 })]),
        );
        expect(await acoustidService.lookup(200, "fp")).toBeNull();
    });

    it("skips a bare result with no recordings array (fingerprint-only match)", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([{ id: RECORDING, score: 0.99 }]),
        );
        expect(await acoustidService.lookup(200, "fp")).toBeNull();
    });

    it("returns null without throwing on network error (silent fallthrough)", async () => {
        setupClient().mockRejectedValue(new Error("ECONNREFUSED"));
        await expect(acoustidService.lookup(200, "fp")).resolves.toBeNull();
    });

    it("returns null when the API reports failure status", async () => {
        setupClient().mockResolvedValue({
            data: {
                status: "error",
                error: { message: "rate limit exceeded" },
            },
        });
        expect(await acoustidService.lookup(200, "fp")).toBeNull();
    });

    it("returns null when there are no results", async () => {
        setupClient().mockResolvedValue(lookupResponse([]));
        expect(await acoustidService.lookup(200, "fp")).toBeNull();
    });

    it("short-circuits to null on empty fingerprint or bad duration without any HTTP call", async () => {
        expect(await acoustidService.lookup(200, "")).toBeNull();
        expect(await acoustidService.lookup(0, "fp")).toBeNull();
        expect(await acoustidService.lookup(NaN, "fp")).toBeNull();
        expect(setupClient()).not.toHaveBeenCalled();
    });

    it("sends the live-verified request shape: form-encoded, duration param, %20 meta", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        await acoustidService.lookup(123, "fp123");

        expect(post).toHaveBeenCalledTimes(1);
        const [url, body, config] = post.mock.calls[0];
        expect(url).toBe("/v2/lookup");
        expect(typeof body).toBe("string");
        expect(body).toContain("duration=123");
        expect(body).not.toContain("track=");
        expect(body).toContain("fingerprint=fp123");
        expect(body).toContain("meta=recordings%20releasegroups");
        expect(body).not.toContain("recordings%2Breleasegroups");
        expect(body).toContain("client=");
        expect(config.headers["Content-Type"]).toBe(
            "application/x-www-form-urlencoded",
        );
    });
});
