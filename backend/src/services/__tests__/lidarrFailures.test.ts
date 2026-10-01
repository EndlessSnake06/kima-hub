/**
 * Lidarr queue removal has one owner: each download id is deleted at most once,
 * and the sweep touches only failed downloads that belong to a Kima job.
 */

jest.mock("../lidarr", () => ({
    lidarrService: { getQueueItems: jest.fn(), removeItemAndBlocklist: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { lidarrService } from "../lidarr";
import { removeFailedDownload, sweepFailedDownloads, failureReason } from "../lidarrFailures";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "lf_user";
const getQueueItems = lidarrService.getQueueItems as jest.Mock;
const removeItem = lidarrService.removeItemAndBlocklist as jest.Mock;

const item = (id: number, downloadId: string, extra: Record<string, unknown> = {}) => ({
    id,
    downloadId,
    title: downloadId,
    status: "completed",
    trackedDownloadStatus: "ok",
    trackedDownloadState: "importPending",
    statusMessages: [],
    ...extra,
});

const ids = ["dl-1", "dl-2", "dl-mine", "dl-other", "dl-info"];

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

beforeEach(() => {
    getQueueItems.mockReset();
    removeItem.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
    await prisma.handledDownload.deleteMany({ where: { downloadId: { in: ids } } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("removeFailedDownload", () => {
    it("deletes a download from Lidarr once however many callers ask", async () => {
        const target = { id: 7, title: "x" };
        const results = await Promise.all([
            removeFailedDownload("dl-1", "a", { searchAgain: true, item: target }),
            removeFailedDownload("dl-1", "b", { searchAgain: true, item: target }),
            removeFailedDownload("dl-1", "c", { searchAgain: true, item: target }),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
        expect(removeItem).toHaveBeenCalledTimes(1);
    });

    it("lets a later caller try again when Lidarr refused the delete", async () => {
        removeItem.mockResolvedValueOnce(false);
        const target = { id: 7 };

        expect(await removeFailedDownload("dl-2", "a", { searchAgain: true, item: target })).toBe(false);
        expect(await removeFailedDownload("dl-2", "a", { searchAgain: true, item: target })).toBe(true);
        expect(removeItem).toHaveBeenCalledTimes(2);
    });

    it("tells Lidarr not to search again when the caller is giving up", async () => {
        await removeFailedDownload("dl-1", "a", { searchAgain: false, item: { id: 7 } });
        expect(removeItem).toHaveBeenCalledWith({ id: 7 }, { skipRedownload: true });
    });
});

describe("sweepFailedDownloads", () => {
    it("removes only Kima's failed downloads and counts each against its job", async () => {
        await prisma.downloadJob.create({
            data: { id: "lf_job", userId: USER, subject: "s", type: "album", status: "processing", lidarrRef: "dl-mine" },
        });
        await prisma.downloadJob.create({
            data: { id: "lf_job2", userId: USER, subject: "s2", type: "album", status: "processing", lidarrRef: "dl-info" },
        });
        getQueueItems.mockResolvedValue([
            item(1, "dl-mine", { trackedDownloadState: "importFailed" }),
            item(2, "dl-other", { trackedDownloadState: "importFailed" }),
            item(3, "dl-info", {
                trackedDownloadStatus: "warning",
                trackedDownloadState: "downloading",
                statusMessages: [{ title: "x", messages: ["Indexer is slow"] }],
            }),
        ]);

        const first = await sweepFailedDownloads();
        const second = await sweepFailedDownloads();

        expect(first.removed).toBe(1);
        expect(second.removed).toBe(0);
        expect(removeItem).toHaveBeenCalledTimes(1);
        expect(removeItem.mock.calls[0][0].downloadId).toBe("dl-mine");
        const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job" } });
        expect(job.lidarrRef).toBeNull();
        expect((job.metadata as any).previousDownloadIds).toEqual(["dl-mine"]);
    });
});

describe("failureReason", () => {
    it("ignores a status message that is not a failure", () => {
        expect(
            failureReason(item(1, "d", { statusMessages: [{ title: "t", messages: ["Indexer is slow"] }] }) as any)
        ).toBeNull();
    });
});
