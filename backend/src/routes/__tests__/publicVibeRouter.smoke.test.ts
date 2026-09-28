/**
 * Router-level smoke for /api/public/vibe — mounted EXACTLY as index.ts does it,
 * so this proves the wiring end to end: a disabled feature 404s, an enabled
 * feature serves 200, the SSE /stream opens and emits a data frame, and /map
 * carries an ETag.
 *
 * This exercises the REAL publicVibe router (withPublic gate + handlers), not a
 * re-implementation. prisma, the service layer, the embedding path, and remote
 * artwork lookups are mocked at their boundaries, so the assertions sit
 * on the routing/gate/response-shape logic — the mount + gate that a plain DB
 * run cannot reach. /cover additionally walks the REAL filesystem under a
 * per-run temp covers root (see smokeRoot), so its resolution/ETag/304/escape
 * contract is asserted against actual bytes, not a stand-in. The disabled
 * surface 404s from the gate (not a missing
 * route), and every enabled path is asserted against the full
 * /api/public/vibe mount path, just like chevron7.io.
 */

const enabledPayload = {
    id: "default",
    publicVibeEnabled: true,
    publicVibeUserId: "public-user-1",
};

// A Proxy-backed prisma: `systemSettings.findUnique` returns our gate row, and
// every other model/method the router might touch ($queryRaw, track.findFirst,
// ...) yields a benign empty so the gate/handler logic we're testing is what
// runs, not an unexpected NotFound deep in a model we aren't exercising.
const prismaMock: any = new Proxy(
    {
        systemSettings: {
            findUnique: jest.fn(async () => enabledPayload),
        },
        // resolveCoverBytes reads the cover reference through track.findFirst;
        // the /cover cases arm this per test so the route resolves real files.
        track: {
            findFirst: jest.fn(async () => null),
        },
    },
    {
        get(target: any, key: string) {
            if (key in target) return target[key];
            // Every other model/method: any chain (model.findFirst(...)) must be
            // callable AND awaitable — return a callable object whose own props
            // are stubs too, so deep chains like track.findFirst(...) resolve.
            if (key === "$queryRaw" || key === "$executeRaw" || key === "$transaction") {
                return jest.fn(async () => []);
            }
            const modelStub: any = new Proxy(
                { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), findMany: jest.fn(async () => [] as any[]) },
                {
                    get(t2: any, k2: string) {
                        if (k2 in t2) return t2[k2];
                        return jest.fn(async () => []);
                    },
                },
            );
            return modelStub;
        },
    },
);
jest.mock("../../utils/db", () => ({
    __esModule: true,
    prisma: prismaMock,
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: { ping: jest.fn(async () => "pong"), getClient: jest.fn(() => redisClientMock) },
}));
const redisClientMock: any = {};

// Service layer: controlled payloads. Every enabled endpoint reads from here.
jest.mock("../../services/publicVibeService", () => ({
    getPublicLiveCached: jest.fn(async () => ({
        nowPlaying: {
            trackId: "clivefix0000000000000000001",
            x: 0.4,
            y: 0.6,
            title: "Seed Track",
            artist: "Seed Artist",
            coverUrl: "native:clivefix0000000000000000001.jpg",
            position: 1000,
            duration: 2000,
        },
    })),
    getPublicQueue: jest.fn(async () => [
        { trackId: "cq1fix0000000000000000000001", x: 0.45, y: 0.65, title: "Queued One", artist: "Seed Artist", index: 0 },
    ]),
    getPublicMap: jest.fn(async () => ({
        tracks: [
            { id: "clivefix0000000000000000001", x: 0.4, y: 0.6, title: "Seed Track", artist: "Seed Artist", coverUrl: "native:clivefix0000000000000000001.jpg" },
        ],
        trackCount: 1,
        fullCount: 1,
        sampled: false,
        computedAt: new Date().toISOString(),
    })),
}));

// Similar returns a canned neighbour.
jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(async () => [
        {
            id: "csim1fix00000000000000000001",
            title: "Neighbor",
            distance: 0.1,
            similarity: 0.9,
            albumId: "a1",
            albumTitle: "Al",
            albumCoverUrl: "native:a1.jpg",
            artistId: "ar1",
            artistName: "Ar",
        },
    ]),
}));

// Text search returns a single ranked row so /search has something to reshape.
const SEARCH_ROW = {
    id: "csrch1fix000000000000000001",
    title: "Match",
    duration: 200,
    trackNo: 1,
    distance: 0.3,
    albumId: "a1",
    albumTitle: "Al",
    albumCoverUrl: "native:a1.jpg",
    artistId: "ar1",
    artistName: "Ar",
};
jest.mock("../../services/textEmbeddingBridge", () => ({
    searchTracksByText: jest.fn(),
}));

jest.mock("../../services/imageStorage", () => ({
    getResizedImagePath: jest.fn(() => null),
    resizeImageBuffer: jest.fn(async () => Buffer.from("iVBORw0KGgoAAA")),
}));

// The /cover handler resolves a cover image from disk or the recovery path.
jest.mock("../../services/artwork", () => ({
    findAlbumArtwork: jest.fn(async () => null),
}));

// getNativeCoverPath resolves `native:` refs against
// resolve(config.music.transcodeCachePath, "../covers") on the REAL filesystem,
// so the config mock points that root at a per-run temp dir. Hoisted function:
// jest.mock factories run before the file body executes.
function smokeRoot(): string {
    return require("path").join(require("os").tmpdir(), `kima-pubvibe-smoke-${process.pid}`);
}
jest.mock("../../config", () => ({
    USER_AGENT: "kima-public-vibe-smoke-test",
    config: {
        music: { transcodeCachePath: require("path").join(smokeRoot(), "transcodes") },
    },
}));

jest.mock("../../middleware/rateLimiter", () => {
    // Identity-limiting passthrough limiter for the smoke test: it must NOT
    // throttle the handful of requests we make, and must not mutate the response.
    return {
        apiLimiter: (req: any, res: any, next: any) => next(),
    };
});

import fs from "fs";
import path from "path";
import crypto from "crypto";
import request from "supertest";
import express from "express";
import http from "http";
import { apiLimiter } from "../../middleware/rateLimiter";
import publicVibeRouter, { __resetPublicAccess } from "../publicVibe";
import {
    getPublicLiveCached,
    getPublicQueue,
    getPublicMap,
} from "../../services/publicVibeService";
import { findSimilarTracks } from "../../services/hybridSimilarity";
import { searchTracksByText } from "../../services/textEmbeddingBridge";

const app = express();
app.use(express.json());
// Mount exactly as backend/src/index.ts does: same path, same limiter.
app.use("/api/public/vibe", apiLimiter, publicVibeRouter);
// Surface route throws like production's errorHandler would (index.ts mounts it).
app.use(((err: any, _req: any, res: any, _next: any) => {
    console.error("[smoke] unhandled route error:", err?.message, err?.stack);
    res.status(500).json({ error: "Internal error" });
}) as any);

// A 200-byte synthetic JPEG we serve when the cover resolution succeeds.
const FAKE_JPEG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
        "0000000d49444154789c6360000002000154a25fdd0000000049454e44ae426082",
    "hex",
);

// ----- supertest only resolves when the response ENDS; /stream never ends. ----
// So the /stream case talks to a real loopback socket we shut ourselves.
function readFrames(port: number, path: string, ms = 300): Promise<{ headers: any; body: string }> {
    return new Promise((resolve, reject) => {
        let headers: any = {};
        const chunks: string[] = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            // /stream never ends on its own: without destroying the client
            // request here, its socket stays open after the assertions and
            // Jest outlives the suite on it.
            socket.destroy();
            resolve({ headers, body: chunks.join("") });
        };
        const socket = http.request(
            { host: "127.0.0.1", port, path, method: "GET", headers: { Accept: "text/event-stream" } },
            (res) => {
                headers = res.headers;
                res.on("data", (c) => chunks.push(c));
                res.on("end", finish);
                res.on("close", finish);
            },
        );
        socket.setTimeout(ms, () => finish());
        socket.on("error", reject);
        socket.end();
    });
}

beforeEach(() => {
    // Re-arm the module singleton each case; it caches the flag for 5s.
    __resetPublicAccess();
    (prismaMock.systemSettings.findUnique as jest.Mock).mockReset().mockResolvedValue(
        enabledPayload,
    );
    // Default keeps the other paths failing cover resolution exactly where they
    // did before; the /cover describe arms it per case.
    (prismaMock.track.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    (getPublicLiveCached as jest.Mock).mockReset().mockResolvedValue({
        nowPlaying: {
            trackId: "clivefix0000000000000000001",
            x: 0.4,
            y: 0.6,
            title: "Seed Track",
            artist: "Seed Artist",
            coverUrl: "native:clivefix0000000000000000001.jpg",
            position: 1000,
            duration: 2000,
        },
    });
    (getPublicQueue as jest.Mock).mockReset().mockResolvedValue([
        { trackId: "cq1fix0000000000000000000001", x: 0.45, y: 0.65, title: "Queued One", artist: "Seed Artist", index: 0 },
    ]);
    (getPublicMap as jest.Mock).mockReset().mockResolvedValue({
        tracks: [
            { id: "clivefix0000000000000000001", x: 0.4, y: 0.6, title: "Seed Track", artist: "Seed Artist", coverUrl: "native:clivefix0000000000000000001.jpg" },
        ],
        trackCount: 1,
        fullCount: 1,
        sampled: false,
        computedAt: new Date().toISOString(),
    });
    (findSimilarTracks as jest.Mock).mockReset().mockResolvedValue([
        {
            id: "csim1fix00000000000000000001",
            title: "Neighbor",
            distance: 0.1,
            similarity: 0.9,
            albumId: "a1",
            albumTitle: "Al",
            albumCoverUrl: "native:a1.jpg",
            artistId: "ar1",
            artistName: "Ar",
        },
    ]);
    (searchTracksByText as jest.Mock).mockReset().mockResolvedValue([SEARCH_ROW]);
});

describe("disabled surface", () => {
    // When the flag is OFF the router's own gate fires before any handler.
    beforeEach(() => {
        (prismaMock.systemSettings.findUnique as jest.Mock).mockReset().mockResolvedValue(null);
    });

    it.each([
        "/api/public/vibe/live",
        "/api/public/vibe/map",
        "/api/public/vibe/similar/clivefix0000000000000000001",
        "/api/public/vibe/cover/clivefix0000000000000000001",
    ])("%s returns 404 when disabled", async (url) => {
        const res = await request(app).get(url);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Not available" });
    });
});

describe("enabled surface", () => {
    beforeEach(() => {
        (prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue(enabledPayload);
    });

    it("GET /live returns 200 with the live payload and proxies native covers", async () => {
        const res = await request(app).get("/api/public/vibe/live");
        expect(res.status).toBe(200);
        expect(res.body.nowPlaying.trackId).toBe("clivefix0000000000000000001");
        // No `native:` reference should escape to the client.
        expect(String(res.body.nowPlaying.coverUrl)).not.toContain("native:");
        expect(res.body.context.name).toBe("Public Queue");
    });

    it("GET /map returns 200 with an ETag", async () => {
        const res = await request(app).get("/api/public/vibe/map");
        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBeGreaterThanOrEqual(1);
        expect(res.headers["etag"]).toBeTruthy();
    });

    it("GET /map honours an If-None-Match", async () => {
        const first = await request(app).get("/api/public/vibe/map");
        const etag = first.headers["etag"];
        const second = await request(app).get("/api/public/vibe/map").set("If-None-Match", etag);
        expect(second.status).toBe(304);
        expect(second.headers["etag"]).toBe(etag);
    });

    it("GET /similar/:trackId returns neighbours (proxied covers)", async () => {
        const res = await request(app).get("/api/public/vibe/similar/clivefix0000000000000000001");
        expect(res.status).toBe(200);
        expect(res.body.tracks.length).toBeGreaterThan(0);
        expect(String(res.body.tracks[0].album.coverUrl)).not.toContain("native:");
    });

    it("POST /search returns neighbours (proxied covers)", async () => {
        const res = await request(app).post("/api/public/vibe/search").send({ query: " song " });
        expect(res.status).toBe(200);
        expect(searchTracksByText).toHaveBeenCalledWith("song", expect.any(Number));
        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.tracks[0].trackId).toBe(SEARCH_ROW.id);
        expect(res.body.tracks[0].similarity).toBeCloseTo(0.7, 6);
        expect(String(res.body.tracks[0].album.coverUrl)).not.toContain("native:");
    });

    it("/search rejects a 1-char query", async () => {
        const res = await request(app).post("/api/public/vibe/search").send({ query: "x" });
        expect(res.status).toBe(400);
    });

    it("GET /stream opens, advertises SSE, and pushes a data frame", async () => {
        // Boot a real server so the SSE client connects to a listening port.
        const server = app.listen(0);
        try {
            const port = (server.address() as any).port;
            const { headers, body } = await readFrames(port, "/api/public/vibe/stream");
            expect(headers["content-type"]).toContain("text/event-stream");
            // A heartbeat/data frame must arrive before we cut the socket.
            expect(body.length).toBeGreaterThan(0);
        } finally {
            server.close();
        }
    });

    describe("GET /cover/:trackId", () => {
        const COVER_ID = "ccoverfix00000000000000001"; // matches TRACK_ID_RE
        const COVERS_DIR = path.join(smokeRoot(), "covers");
        const COVER_FILE = path.join(COVERS_DIR, "alive.jpg");
        // Lives OUTSIDE the covers root: reachable only if the path-escape
        // guard is gone, which is exactly what the case below pins.
        const ESCAPE_FILE = path.join(smokeRoot(), "secret.jpg");
        const EXPECTED_ETAG =
            '"' + crypto.createHash("md5").update(FAKE_JPEG).digest("hex") + '"';

        const serveTrack = (coverUrl: string) => {
            (prismaMock.track.findFirst as jest.Mock).mockResolvedValue({
                album: {
                    coverUrl,
                    rgMbid: null, // recovery path bails immediately: no network
                    title: "Seed Album",
                    artist: { name: "Seed Artist" },
                },
            });
        };

        // supertest does not expose non-text bodies unless asked; buffer raw.
        const rawBody = (res: http.IncomingMessage, cb: (e: Error | null, b: Buffer) => void) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => cb(null, Buffer.concat(chunks)));
        };

        beforeEach(() => {
            fs.mkdirSync(COVERS_DIR, { recursive: true });
            fs.writeFileSync(COVER_FILE, FAKE_JPEG);
        });

        afterEach(() => {
            fs.rmSync(smokeRoot(), { recursive: true, force: true });
        });

        it("serves the resolved bytes with an image content type and ETag", async () => {
            serveTrack("native:alive.jpg");
            const res = await request(app)
                .get(`/api/public/vibe/cover/${COVER_ID}`)
                .buffer(true)
                .parse(rawBody as any);
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toContain("image/");
            expect(res.body).toEqual(FAKE_JPEG);
            expect(res.headers.etag).toBe(EXPECTED_ETAG);
            expect(res.headers["cache-control"]).toContain("immutable");
        });

        it("answers 304 to If-None-Match carrying the served ETag", async () => {
            serveTrack("native:alive.jpg");
            const first = await request(app).get(`/api/public/vibe/cover/${COVER_ID}`);
            expect(first.status).toBe(200);
            const second = await request(app)
                .get(`/api/public/vibe/cover/${COVER_ID}`)
                .set("If-None-Match", first.headers.etag);
            expect(second.status).toBe(304);
        });

        it("404s a native: path escaping the covers root even when the target exists", async () => {
            // The file MUST exist on disk: a mutant that drops the containment
            // check would serve these bytes with 200 instead of refusing.
            fs.writeFileSync(ESCAPE_FILE, FAKE_JPEG);
            serveTrack("native:../secret.jpg");
            const res = await request(app).get(`/api/public/vibe/cover/${COVER_ID}`);
            expect(fs.existsSync(ESCAPE_FILE)).toBe(true);
            expect(res.status).toBe(404);
        });

        it("404s a remote (non-native) cover reference", async () => {
            serveTrack("https://example.com/cover.jpg");
            const res = await request(app).get(`/api/public/vibe/cover/${COVER_ID}`);
            expect(res.status).toBe(404);
        });
    });
});
