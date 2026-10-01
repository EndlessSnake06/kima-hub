/**
 * Lidarr queue removal has one owner: each download id is deleted at most once,
 * the sweep touches only downloads of Kima jobs, and only a real failure counts
 * as an attempt.
 */

jest.mock("../lidarr", () => ({
    lidarrService: { getQueueItems: jest.fn(), removeQueueItem: jest.fn(), unmonitorAlbum: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { lidarrService } from "../lidarr";
import { judgeQueueItem, rejectSingleTrackPost, removeFailedDownload, sweepFailedDownloads } from "../lidarrFailures";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "lf_user";
const getQueueItems = lidarrService.getQueueItems as jest.Mock;
const removeItem = lidarrService.removeQueueItem as jest.Mock;

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

const ids = ["dl-1", "dl-2", "dl-mine", "dl-other", "dl-info", "dl-post", "dl-owned"];

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
        expect(removeItem).toHaveBeenCalledWith({ id: 7 }, { blocklist: true, skipRedownload: true });
    });

    it("releases the claim when the download is not in Lidarr's queue", async () => {
        getQueueItems.mockResolvedValue([]);

        expect(await removeFailedDownload("dl-1", "a", { searchAgain: true })).toBe(false);
        expect(await prisma.handledDownload.count({ where: { downloadId: "dl-1" } })).toBe(0);
    });
});

describe("rejectSingleTrackPost", () => {
    it("blocklists a single-track post and lets Lidarr search for the album", async () => {
        getQueueItems.mockResolvedValue([item(9, "dl-post")]);

        expect(await rejectSingleTrackPost("dl-post", '[11 of 19] "01 Jenny Was a Friend.flac" yEnc')).toBe(true);
        expect(removeItem).toHaveBeenCalledWith(
            expect.objectContaining({ id: 9 }),
            { blocklist: true, skipRedownload: false }
        );
    });

    it("leaves a whole album release alone", async () => {
        expect(await rejectSingleTrackPost("dl-post", "The Killers - Hot Fuss (2004) [FLAC]")).toBe(false);
        expect(removeItem).not.toHaveBeenCalled();
    });
});

describe("sweepFailedDownloads", () => {
    it("removes only Kima's failed downloads and counts each against its job", async () => {
        await prisma.downloadJob.create({
            data: { id: "lf_job", userId: USER, subject: "s", type: "album", status: "processing", lidarrRef: "dl-mine", attempts: 1 },
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
        expect(removeItem.mock.calls[0]).toEqual([
            expect.objectContaining({ downloadId: "dl-mine" }),
            { blocklist: true, skipRedownload: false },
        ]);
        const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job" } });
        expect(job.lidarrRef).toBeNull();
        expect((job.metadata as any).previousDownloadIds).toEqual(["dl-mine"]);
    });

    it("tells Lidarr to stop searching once the job reaches its retry limit", async () => {
        await prisma.downloadJob.create({
            data: {
                id: "lf_job", userId: USER, subject: "s", type: "album", status: "processing",
                lidarrRef: "dl-mine", attempts: 3, metadata: { noFallback: true },
            },
        });
        getQueueItems.mockResolvedValue([item(1, "dl-mine", { trackedDownloadState: "importFailed" })]);

        expect((await sweepFailedDownloads()).removed).toBe(1);
        expect(removeItem.mock.calls[0][1]).toEqual({ blocklist: true, skipRedownload: true });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job" } })).status).toBe("failed");
    });
});

describe("sweep outcomes that are not failures", () => {
    const processing = (id: string, lidarrRef: string) =>
        prisma.downloadJob.create({
            data: { id, userId: USER, subject: id, type: "album", status: "processing", lidarrRef, attempts: 1 },
        });

    it("rejects a single-track post without counting an attempt", async () => {
        await processing("lf_job", "dl-post");
        getQueueItems.mockResolvedValue([item(4, "dl-post", { title: "[10 of 19] \"02 Mr. Brightside.flac\"" })]);

        expect((await sweepFailedDownloads()).removed).toBe(1);
        expect(removeItem.mock.calls[0][1]).toEqual({ blocklist: true, skipRedownload: false });
        const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job" } });
        expect(job.attempts).toBe(1);
        expect((job.metadata as any)?.previousDownloadIds).toBeUndefined();
    });

    it("completes the job when Lidarr says the library already has the album", async () => {
        await processing("lf_job", "dl-owned");
        await processing("lf_job2", "dl-other");
        getQueueItems.mockResolvedValue([
            item(5, "dl-owned", {
                trackedDownloadState: "importFailed",
                statusMessages: [{ title: "x", messages: ["Not an upgrade for existing album file(s)"] }],
            }),
        ]);

        expect((await sweepFailedDownloads()).removed).toBe(1);
        expect(removeItem.mock.calls[0][1]).toEqual({ blocklist: false, skipRedownload: true });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job" } })).status).toBe("completed");
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "lf_job2" } })).status).toBe("processing");
    });
});

describe("judgeQueueItem", () => {
    const partial = (addedMinutesAgo: number) =>
        item(1, "d", {
            trackedDownloadState: "importFailed",
            added: new Date(Date.now() - addedMinutesAgo * 60_000).toISOString(),
            statusMessages: [{ title: "t", messages: ["Has missing tracks"] }],
        }) as any;

    it("gives a partial import 15 minutes to finish", () => {
        expect(judgeQueueItem(partial(5))).toBeNull();
        expect(judgeQueueItem(partial(16))).toEqual({ action: "failed", reason: "Has missing tracks" });
    });

    it("ignores a status message that is not a failure", () => {
        for (const message of ["Indexer is slow", "Sample rate 48kHz"]) {
            expect(
                judgeQueueItem(item(1, "d", { statusMessages: [{ title: "t", messages: [message] }] }) as any)
            ).toBeNull();
        }
    });
});
