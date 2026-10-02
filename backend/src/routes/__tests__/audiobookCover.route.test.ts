import fs from "fs";
import os from "os";
import path from "path";

/**
 * GET /audiobooks/:id/cover is unauthenticated. It serves only a cover the
 * audiobook row points at inside the app's image store; a stored path that
 * leaves the store, or points into the music folder, is never read from disk.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
        },
        audiobookProgress: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../utils/errors", () => ({
    safeError: jest.fn((res: any, _msg: string, err: any) => {
        res.status(500).json({ error: String(err) });
    }),
}));

jest.mock("../../services/audiobookshelf", () => ({
    audiobookshelfService: {
        getAllAudiobooks: jest.fn(),
        searchAudiobooks: jest.fn(),
        streamAudiobook: jest.fn(),
        updateProgress: jest.fn(),
    },
}));

jest.mock("../../services/audiobookCache", () => ({
    audiobookCacheService: { getAudiobook: jest.fn(), syncAll: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: { notifySystem: jest.fn() },
}));

const COVERS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "kima-covers-"));

jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music", transcodeCachePath: path.join(COVERS_ROOT, "transcodes") } },
}));

import express from "express";
import request from "supertest";
import audiobookRoutes from "../../routes/audiobooks";
import { prisma } from "../../utils/db";

const SECRET_BODY = "if you can read this, the stored path escaped the image store";
const COVER_BODY = "a real audiobook cover";
const outsideFile = path.join(os.tmpdir(), `kima-cover-outside-${process.pid}.jpg`);

function makeApp() {
    const app = express();
    app.use("/", audiobookRoutes);
    return app;
}

function storedCover(localCoverPath: string | null) {
    (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue({ localCoverPath, coverUrl: null });
}

describe("GET /audiobooks/:id/cover", () => {
    const app = makeApp();

    beforeAll(() => {
        fs.mkdirSync(path.join(COVERS_ROOT, "covers", "audiobooks"), { recursive: true });
        fs.writeFileSync(path.join(COVERS_ROOT, "covers", "audiobooks", "book-1.jpg"), COVER_BODY);
        fs.writeFileSync(outsideFile, SECRET_BODY);
    });

    afterAll(() => {
        fs.rmSync(COVERS_ROOT, { recursive: true, force: true });
        fs.rmSync(outsideFile, { force: true });
    });

    beforeEach(() => storedCover(null));

    it("serves the cover the row points at in the image store", async () => {
        storedCover("native:audiobooks/book-1.jpg");

        const res = await request(app).get("/book-1/cover");

        expect(res.status).toBe(200);
        expect(Buffer.from(res.body).toString()).toBe(COVER_BODY);
    });

    it("refuses a stored path that climbs out of the image store", async () => {
        storedCover(`native:${path.relative(path.join(COVERS_ROOT, "covers"), outsideFile)}`);

        const res = await request(app).get("/book-1/cover");

        expect(res.status).toBe(404);
        expect(res.text).not.toContain(SECRET_BODY);
    });

    it("does not read an absolute path stored by older versions", async () => {
        storedCover(outsideFile);

        const res = await request(app).get("/book-1/cover");

        expect(res.status).toBe(404);
        expect(res.text).not.toContain(SECRET_BODY);
    });

    it("answers 404 for an audiobook it does not know", async () => {
        const res = await request(app).get("/no-such-book/cover");

        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Cover not found");
        expect(prisma.audiobook.update).not.toHaveBeenCalled();
    });
});
