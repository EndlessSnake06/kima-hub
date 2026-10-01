/**
 * A Lidarr failure event changes only the job it names, by download id or album MBID,
 * and each download id counts as one failure however often Lidarr reports it.
 */

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_fail_user";

const job = (id: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: { id, userId: USER, subject: id, type: "album", status: "processing", ...data },
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

        expect(result).toMatchObject({ retried: true, jobId: "sdm_b" });
        expect(await meta("sdm_b")).toMatchObject({ failureCount: 1, previousDownloadIds: ["dl-b"] });
        expect(await meta("sdm_a")).toEqual({});
    });

    it("counts a download once when Lidarr reports it again after the job moved on", async () => {
        await job("sdm_a", { lidarrRef: "dl-1" });
        await simpleDownloadManager.onImportFailed("dl-1", "Import failed");
        await prisma.downloadJob.update({ where: { id: "sdm_a" }, data: { lidarrRef: "dl-2" } });

        const repeat = await simpleDownloadManager.onImportFailed("dl-1", "Manually marked as failed");
        const next = await simpleDownloadManager.onImportFailed("dl-2", "Import failed");

        expect(repeat).toMatchObject({ retried: false, jobId: "sdm_a" });
        expect(next).toMatchObject({ retried: true, jobId: "sdm_a" });
        expect(await meta("sdm_a")).toMatchObject({ failureCount: 2, previousDownloadIds: ["dl-1", "dl-2"] });
    });

    it("matches by album MBID when the download id is new", async () => {
        await job("sdm_a", { targetMbid: "mbid-a" });

        const result = await simpleDownloadManager.onImportFailed("dl-x", "Import failed", "mbid-a");

        expect(result).toMatchObject({ retried: true, jobId: "sdm_a" });
    });
});
