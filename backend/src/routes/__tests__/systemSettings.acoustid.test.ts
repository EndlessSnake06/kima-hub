/**
 * AcoustID settings round-trip.
 *
 * Singleton-row lesson: asserting the
 * WRITE side proves nothing if the READ path selects different columns.
 * This test writes an acoustidApiKey through POST /system-settings and
 * asserts GET / returns the stored plaintext — the full write->encrypt->
 * store->read->decrypt loop.
 *
 * The route imports real encrypt/safeDecrypt (utils/encryption), so the
 * AES round-trip itself is exercised. Prisma is mocked at the boundary:
 * POST encrypts and upserts; GET reads what the upsert stored.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "admin" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "admin" };
        next();
    },
}));

import request from "supertest";
import express from "express";
import systemSettingsRouter from "../systemSettings";
import { prisma } from "../../utils/db";

const app = express();
app.use(express.json());
app.use("/system-settings", systemSettingsRouter);

// A baseline settings row as GET would find it (no acoustid key yet).
const baseRow: Record<string, unknown> = {
    id: "default",
    lidarrEnabled: true,
    lidarrUrl: "http://localhost:8686",
    openaiEnabled: false,
    openaiModel: "gpt-4",
    fanartEnabled: false,
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "http://localhost:13378",
    musicPath: "/music",
    downloadPath: "/downloads",
    autoSync: true,
    autoEnrichMetadata: true,
    transcodeCacheMaxGb: 10,
    maxQueueLength: 10000,
    soulseekConcurrentDownloads: 4,
    acoustidApiKey: null,
};

describe("acoustidApiKey round-trip", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({ ...baseRow });
    });

    it("POST stores the key encrypted; GET returns the stored plaintext", async () => {
        // capture what POST actually persists
        let stored: Record<string, unknown> = { ...baseRow };
        (prisma.systemSettings.upsert as jest.Mock).mockImplementation(async ({ create, update }) => {
            // prisma upsert carries the payload in create/update, not a top-level data key
            stored = { ...stored, ...(update ?? create) };
            return stored;
        });
        // GET then reads the same row back
        (prisma.systemSettings.findUnique as jest.Mock).mockImplementation(async () => stored);

        const post = await request(app)
            .post("/system-settings")
            .send({ ...baseRow, acoustidApiKey: "acoustid-test-key-1234" });
        if (post.status !== 200) {
            console.log("POST body:", JSON.stringify(post.body).slice(0, 400));
        }
        expect(post.status).toBe(200);

        // the stored value must NOT be plaintext
        expect(stored.acoustidApiKey).not.toBe("acoustid-test-key-1234");
        expect(stored.acoustidApiKey).toBeTruthy();

        const get = await request(app).get("/system-settings");
        expect(get.status).toBe(200);
        expect(get.body.acoustidApiKey).toBe("acoustid-test-key-1234");
    });

    it("GET returns null (not ciphertext, not undefined) when no key is stored", async () => {
        const get = await request(app).get("/system-settings");
        expect(get.status).toBe(200);
        expect(get.body.acoustidApiKey).toBeNull();
    });
});
