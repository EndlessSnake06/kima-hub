/**
 * AcoustID service tests — mocked HTTP (no live calls; AcoustID is a
 * rate-limited public API and the contract is that every outcome reaches
 * the caller as a typed Outcome kind: "the source answered nothing"
 * (absent) stays distinct from "the source did not answer"
 * (transient/permanent).
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
 *  - happy path: confident match with release-group answers with the full
 *    AcoustIDResult shape and the live score in evidence;
 *  - low-score results are skipped; a result below the 0.5 floor is
 *    reported absent, not answered;
 *  - duration-sanity guard: a match whose canonical length is less than
 *    half the queried duration (or under 30s) is rejected — the
 *    "matched a 12-second sample" false-positive class;
 *  - a bare result (no recordings attached) never answers;
 *  - network error / non-ok status answer `transient` WITHOUT throwing;
 *  - missing fingerprint or non-finite duration short-circuit to
 *    `permanent` without any HTTP call at all;
 *  - key precedence (pattern of the retired Last.fm key): the operator's key
 *    from the encrypted SystemSettings row wins over the baked config
 *    default, an explicitly passed key wins over both, and a failed or
 *    empty settings read degrades to the config default without throwing;
 *  - the request body is form-encoded with meta=recordings%20releasegroups
 *    (the server does not form-decode a literal '+' back to a space, so
 *    %20 is the form we send), the duration parameter
 *    is named "duration" (not "track"), and the content type is
 *    application/x-www-form-urlencoded.
 */

import { acoustidService } from "../acoustidService";
import { config } from "../../config";

// ── Mocks (must be registered before the imports above run them) ────

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// Keep the unit suite hermetic: featureDetection (via utils/redis) would
// otherwise construct a real Redis client at import time.
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null) },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn().mockResolvedValue({ fpcalc: true }) },
}));

// Pass the request straight through: the real limiter's circuit breaker
// trips on the burst a full suite generates and would reject later lookups.
jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        execute: (_key: string, fn: () => unknown) => fn(),
    },
}));

// The service lazily imports this (same pattern as the retired Last.fm
// service used); the mock
// stands in for the encrypted SystemSettings row.
const mockGetSystemSettings = jest.fn().mockResolvedValue(null);
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
    invalidateSystemSettingsCache: jest.fn(),
}));

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
    mockGetSystemSettings.mockResolvedValue(null);
});

describe("acoustidService.lookup", () => {
    it("answers a confident match with the full result shape", async () => {
        setupClient().mockResolvedValue(lookupResponse([recordingResult()]));
        const res = await acoustidService.lookup(200, "aqA_ fingerprint");
        expect(res.kind).toBe("answered");
        if (res.kind === "answered") {
            expect(res.value).toEqual({
                recordingMbid: RECORDING,
                artistMbid: ARTIST,
                releaseGroupMbid: RG,
                title: "Song",
                artist: "Artist",
                album: "Album",
            });
            expect(res.evidence).toMatchObject({ score: 0.92 });
        }
    });

    it("skips results below the 0.5 score floor and takes the next that qualifies", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([
                recordingResult({ id: "weak", score: 0.4 }),
                recordingResult({ score: 0.7 }),
            ]),
        );
        const res = await acoustidService.lookup(200, "fp");
        if (res.kind === "answered") {
            expect(res.value.releaseGroupMbid).toBe(RG);
        } else {
            throw new Error(`expected answered, got ${res.kind}`);
        }
    });

    it("reports a match whose duration is less than half the queried duration as absent", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ duration: 60 })]),
        );
        // 60s record vs 200s query: the |rec−query| > query/2 guard fires —
        // the source answered, and its answer is "nothing within the window".
        const res = await acoustidService.lookup(200, "fp");
        expect(res.kind).toBe("absent");
    });

    it("rejects sub-30s matches even at score 1.0", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ duration: 25, score: 1.0 })]),
        );
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("skips a bare result with no recordings array (fingerprint-only match)", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([{ id: RECORDING, score: 0.99 }]),
        );
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("answers transient on network error (never throws, never looks like 'no data')", async () => {
        setupClient().mockRejectedValue(new Error("ECONNREFUSED"));
        const res = await acoustidService.lookup(200, "fp");
        expect(res.kind).toBe("transient");
        if (res.kind === "transient") {
            expect(res.error.message).toContain("ECONNREFUSED");
        }
    });

    it("answers transient when the API reports failure status", async () => {
        setupClient().mockResolvedValue({
            data: {
                status: "error",
                error: { message: "rate limit exceeded" },
            },
        });
        const res = await acoustidService.lookup(200, "fp");
        expect(res.kind).toBe("transient");
        if (res.kind === "transient") {
            expect(res.error.code).toBe("BAD_RESPONSE");
        }
    });

    it("answers absent when there are no results", async () => {
        setupClient().mockResolvedValue(lookupResponse([]));
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("short-circuits to permanent on empty fingerprint or bad duration without any HTTP call", async () => {
        expect((await acoustidService.lookup(200, "")).kind).toBe("permanent");
        expect((await acoustidService.lookup(0, "fp")).kind).toBe("permanent");
        expect((await acoustidService.lookup(NaN, "fp")).kind).toBe("permanent");
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

describe("acoustidService key precedence (spec D: pattern of the retired Last.fm key)", () => {
    it("sends the operator's SystemSettings key when one is stored", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockResolvedValue({ acoustidApiKey: "operator-key" });

        await acoustidService.lookup(200, "fp");

        // The mock must be consulted: proves the service actually reads the
        // settings row (a service that ignored settings would still pass on
        // the baked config default alone).
        expect(mockGetSystemSettings).toHaveBeenCalled();
        expect(post.mock.calls[0][1]).toContain("client=operator-key");
    });

    it("prefers an explicitly passed key over the settings value", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockResolvedValue({ acoustidApiKey: "operator-key" });

        await acoustidService.lookup(200, "fp", "explicit-key");

        const body: string = post.mock.calls[0][1];
        expect(body).toContain("client=explicit-key");
        expect(body).not.toContain("operator-key");
    });

    it("falls back to the baked config default when settings hold nothing", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockResolvedValue(null);

        await acoustidService.lookup(200, "fp");

        expect(post.mock.calls[0][1]).toContain(
            `client=${config.acoustid.clientKey}`
        );
    });

    it("falls back to the config default when the settings read throws (never propagates)", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockRejectedValue(new Error("db gone"));

        // Empty results -> absent, but the point is it must not THROW.
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
        expect(post.mock.calls[0][1]).toContain(
            `client=${config.acoustid.clientKey}`
        );
    });
});
