/**
 * A Lidarr failure event changes only the job it names, by download id or album MBID,
 * each download id counts once, and the user's retry limit ends the job.
 */

jest.mock("../lidarr", () => ({
    lidarrService: { unmonitorAlbum: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { lidarrService } from "../lidarr";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_fail_user";

const job = (id: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: { id, userId: USER, subject: id, type: "album", status: "processing", attempts: 1, ...data },
    });

const meta = async (id: string) =>
    ((await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).metadata as any) ?? {};

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.userDiscoverConfig.deleteMany({ where: { userId: USER } });
    await prisma.handledDownload.deleteMany({ where: { downloadId: "dl-1" } });
    (lidarrService.unmonitorAlbum as jest.Mock).mockReset();
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("onImportFailed", () => {
    it("leaves every job alone when neither the download id nor an MBID matches", async () => {
        await job("sdm_a", { lidarrRef: "dl-a", targetMbid: "mbid-a" });
        await job("sdm_b", { lidarrRef: "dl-b", targetMbid: "mbid-b" });

        const result = await simpleDownloadManager.onImportFailed("dl-unknown", "Import failed");

        expect(result.jobId).toBeUndefined();
        expect(await meta("sdm_a")).toEqual({});
        expect(await meta("sdm_b")).toEqual({});
    });

    it("fails the job whose current download failed", async () => {
        await job("sdm_a", { lidarrRef: "dl-a" });
        await job("sdm_b", { lidarrRef: "dl-b" });

        const result = await simpleDownloadManager.onImportFailed("dl-b", "missing tracks");

        expect(result).toEqual({ searchAgain: true, jobId: "sdm_b" });
        expect(await meta("sdm_b")).toMatchObject({ previousDownloadIds: ["dl-b"] });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_b" } })).attempts).toBe(2);
        expect(await meta("sdm_a")).toEqual({});
    });

    it("counts a download once when Lidarr reports it again after the job moved on", async () => {
        await job("sdm_a", { lidarrRef: "dl-1" });
        await simpleDownloadManager.onImportFailed("dl-1", "Import failed");
        await prisma.downloadJob.update({ where: { id: "sdm_a" }, data: { lidarrRef: "dl-2" } });

        const repeat = await simpleDownloadManager.onImportFailed("dl-1", "Manually marked as failed");
        const next = await simpleDownloadManager.onImportFailed("dl-2", "Import failed");

        expect(repeat).toEqual({ searchAgain: true, jobId: "sdm_a" });
        expect(next).toEqual({ searchAgain: true, jobId: "sdm_a" });
        expect(await meta("sdm_a")).toMatchObject({ previousDownloadIds: ["dl-1", "dl-2"] });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_a" } })).attempts).toBe(3);
    });

    it("ignores Lidarr's report of a download Kima removed itself", async () => {
        await job("sdm_a", { lidarrRef: "dl-1" });
        await prisma.handledDownload.create({ data: { downloadId: "dl-1", reason: "Single-track post" } });

        const result = await simpleDownloadManager.onImportFailed("dl-1", "Manually marked as failed");

        expect(result).toEqual({ searchAgain: false });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_a" } })).attempts).toBe(1);
    });

    it("matches by album MBID when the download id is new", async () => {
        await job("sdm_a", { targetMbid: "mbid-a" });

        const result = await simpleDownloadManager.onImportFailed("dl-x", "Import failed", "mbid-a");

        expect(result).toEqual({ searchAgain: true, jobId: "sdm_a" });
    });

    it("stops Lidarr and fails the job at the default limit of three releases", async () => {
        await job("sdm_a", { lidarrRef: "dl-3", attempts: 3, lidarrAlbumId: 42, metadata: { noFallback: true } });

        const result = await simpleDownloadManager.onImportFailed("dl-3", "Import failed");

        expect(result).toEqual({ searchAgain: false, jobId: "sdm_a" });
        expect(lidarrService.unmonitorAlbum).toHaveBeenCalledWith(42);
        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_a" } });
        expect(row.status).toBe("failed");
        expect(row.attempts).toBe(3);
    });

    it("uses the user's own retry limit", async () => {
        await prisma.userDiscoverConfig.create({ data: { userId: USER, maxRetryAttempts: 1 } });
        await job("sdm_a", { lidarrRef: "dl-1", attempts: 1, metadata: { noFallback: true } });

        const result = await simpleDownloadManager.onImportFailed("dl-1", "Import failed");

        expect(result.searchAgain).toBe(false);
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_a" } })).status).toBe("failed");
    });
});
