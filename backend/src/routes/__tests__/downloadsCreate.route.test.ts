/**
 * POST /downloads takes only a MusicBrainz id, refuses one MusicBrainz does not
 * know, and files an album under the artist its release group credits.
 */

const mockJobCreate = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: {
        $transaction: (fn: (tx: unknown) => unknown) =>
            fn({
                $queryRaw: jest.fn().mockResolvedValue([]),
                downloadJob: { create: (...a: unknown[]) => mockJobCreate(...a) },
            }),
        downloadJob: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ musicPath: "/music" }),
}));
jest.mock("../../config", () => ({ config: { music: { musicPath: "/music" } } }));
jest.mock("../../services/lidarr", () => ({
    lidarrService: { isEnabled: jest.fn().mockResolvedValue(true) },
}));
const mockGetReleaseGroup = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: { getReleaseGroup: (...a: unknown[]) => mockGetReleaseGroup(...a) },
}));
jest.mock("../../services/artistCorrection", () => ({ getArtistCorrection: jest.fn() }));
jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: jest.fn().mockResolvedValue({ success: true }) },
}));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn() }));

import express from "express";
import request from "supertest";
import downloadsRouter from "../downloads";

const app = express();
app.use(express.json());
app.use("/downloads", downloadsRouter);

const RG = "3a1b2c3d-1111-2222-3333-444455556666";
const post = (mbid: string) =>
    request(app).post("/downloads").send({
        type: "album",
        mbid,
        subject: "low - Things We Lost in the Fire",
        artistName: "low",
        albumTitle: "Things We Lost in the Fire",
    });

beforeEach(() => {
    mockJobCreate.mockReset().mockImplementation(async ({ data }) => ({
        id: "job-1",
        status: "pending",
        ...data,
    }));
    mockGetReleaseGroup.mockReset();
});

describe("POST /downloads", () => {
    it.each(["temp-abc", "clx0abcd0000abcd", ""])("refuses %p as an id", async (mbid) => {
        const res = await post(mbid);

        expect(res.status).toBe(400);
        expect(mockJobCreate).not.toHaveBeenCalled();
    });

    it.each([
        { kind: "absent", evidence: {} },
        { kind: "permanent", error: { code: "HTTP_400", message: "bad id" } },
    ])("refuses an album MusicBrainz does not know ($kind)", async (answer) => {
        mockGetReleaseGroup.mockResolvedValue(answer);

        const res = await post(RG);

        expect(res.status).toBe(404);
        expect(mockJobCreate).not.toHaveBeenCalled();
    });

    it("keeps the requested name when MusicBrainz is down", async () => {
        mockGetReleaseGroup.mockResolvedValue({
            kind: "transient",
            error: { code: "ETIMEDOUT", message: "timeout" },
        });

        const res = await post(RG);

        expect(res.status).toBe(200);
        expect(mockJobCreate.mock.calls[0][0].data.metadata.artistName).toBe("low");
    });

    it("files the album under the release group's credited artist", async () => {
        mockGetReleaseGroup.mockResolvedValue({
            kind: "answered",
            value: { "artist-credit": [{ artist: { id: "x", name: "Low" } }] },
            evidence: {},
        });

        const res = await post(RG);

        expect(res.status).toBe(200);
        expect(mockJobCreate.mock.calls[0][0].data.metadata.artistName).toBe("Low");
    });
});
