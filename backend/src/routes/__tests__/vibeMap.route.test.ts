/**
 * GET /api/vibe/map answers at once, whatever state the layout is in.
 *
 * The first 3-D layout of a large library takes minutes, and the Next.js
 * proxy in front of the API drops any request after 30 seconds. So the route
 * never waits for a computation: it serves the map, says "still computing"
 * (202) for the client to poll, or reports a failed computation (500). A ready
 * map is gzipped when the client accepts it.
 *
 * Doctrine: the failure and boundary paths first, the happy path last.
 */

import express from "express";
import request from "supertest";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
}));

const mockState = jest.fn();
jest.mock("../../services/umapProjection", () => ({
    getMapProjectionState: () => mockState(),
}));

import vibeRouter from "../vibe";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";

afterAll(async () => {
    // The router pulls in services/featureDetection, which opens the shared
    // Redis client at import. Left open, Jest finishes the suite and outlives
    // the process on that socket.
    await closeClient(redisClient);
});

function app() {
    const a = express();
    a.use("/api/vibe", vibeRouter);
    return a;
}

const MAP = {
    tracks: [{ id: "t1", x: 0.1, y: 0.2, z: 0.3, title: "One", artist: "A" }],
    trackCount: 1,
    computedAt: "2026-09-23T00:00:00.000Z",
};

describe("GET /api/vibe/map", () => {
    beforeEach(() => mockState.mockReset());

    it("reports a failed computation as a 500", async () => {
        mockState.mockResolvedValue({ status: "failed", message: "UMAP worker exited with code 1" });
        const res = await request(app()).get("/api/vibe/map");
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Failed to compute/);
    });

    it("answers 'computing' straight away while the layout is being built", async () => {
        mockState.mockResolvedValue({ status: "computing" });
        const res = await request(app()).get("/api/vibe/map");
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ computing: true });
    });

    it("serves plain JSON to a client that does not accept gzip", async () => {
        mockState.mockResolvedValue({ status: "ready", data: MAP });
        const res = await request(app()).get("/api/vibe/map").set("Accept-Encoding", "identity");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.body).toEqual(MAP);
    });

    it("serves the map gzipped when the client accepts it", async () => {
        mockState.mockResolvedValue({ status: "ready", data: MAP });
        const res = await request(app()).get("/api/vibe/map").set("Accept-Encoding", "gzip");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("gzip");
        // supertest inflates gzip itself; a body that round-trips proves the stream is valid gzip.
        expect(res.body).toEqual(MAP);
    });
});
