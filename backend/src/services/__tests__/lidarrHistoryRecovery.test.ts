/**
 * Lidarr history fills in webhooks that never arrived: each record is handled
 * once, under the same event id a webhook would have used.
 */

jest.mock("../lidarr", () => ({ getHistorySince: jest.fn() }));
jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: {
        onDownloadGrabbed: jest.fn().mockResolvedValue({ matched: false }),
        onDownloadComplete: jest.fn().mockResolvedValue({ jobId: "job-1" }),
        onImportFailed: jest.fn().mockResolvedValue({}),
        onAlbumDeleted: jest.fn(),
    },
}));
jest.mock("../lidarrFailures", () => ({ rejectSingleTrackPost: jest.fn() }));
jest.mock("../../jobs/queueCleaner", () => ({ queueCleaner: { start: jest.fn() } }));

import { prisma } from "../../utils/db";
import { getHistorySince } from "../lidarr";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { webhookEventStore } from "../webhookEventStore";
import { recoverMissedEvents } from "../lidarrHistoryRecovery";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const history = getHistorySince as jest.Mock;
const record = (downloadId: string | undefined, data: Record<string, string> = {}, id = 1) => ({
    id,
    albumId: 42,
    downloadId,
    eventType: "downloadImported",
    sourceTitle: "Interpol - Antics (2004) [FLAC]",
    date: new Date().toISOString(),
    data,
    album: { id: 42, title: "Antics", foreignAlbumId: "rg-1" },
    artist: { artistName: "Interpol" },
});
const onlyType = (type: number, records: unknown[]) =>
    history.mockImplementation(async (_u, _k, _since, eventType) => (eventType === type ? records : []));

beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
});

afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
    await closeEngineConnections();
});

it("handles a missed import once, under the webhook's event id", async () => {
    onlyType(8, [record("dl-1")]);

    expect(await recoverMissedEvents("http://lidarr", "key")).toBe(1);
    expect(await recoverMissedEvents("http://lidarr", "key")).toBe(0);

    expect(simpleDownloadManager.onDownloadComplete).toHaveBeenCalledTimes(1);
    expect(simpleDownloadManager.onDownloadComplete).toHaveBeenCalledWith("dl-1", "rg-1", "Interpol", "Antics", 42);
    const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "lidarr-Download-dl-1" } });
    expect(stored.processed).toBe(true);
});

it("leaves an event the webhook already delivered alone", async () => {
    const { event } = await webhookEventStore.storeEvent("lidarr", "Download", { eventType: "Download", downloadId: "dl-2" });
    onlyType(8, [record("dl-2")]);

    expect(await recoverMissedEvents("http://lidarr", "key")).toBe(0);
    expect(simpleDownloadManager.onDownloadComplete).not.toHaveBeenCalled();
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).processed).toBe(false);
});

it("builds a Grab with the album list and release title", async () => {
    onlyType(1, [record("dl-3")]);

    await recoverMissedEvents("http://lidarr", "key");
    expect(simpleDownloadManager.onDownloadGrabbed).toHaveBeenCalledWith(
        "dl-3", "rg-1", "Antics", "Interpol", 42
    );
});

it("passes the download failure's message", async () => {
    onlyType(4, [record("dl-4", { message: "Download client removed the item" })]);

    await recoverMissedEvents("http://lidarr", "key");
    expect(simpleDownloadManager.onImportFailed).toHaveBeenCalledWith("dl-4", "Download client removed the item", "rg-1");
});

it("skips records without a download id", async () => {
    onlyType(8, [record(undefined)]);

    expect(await recoverMissedEvents("http://lidarr", "key")).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { source: "lidarr" } })).toBe(0);
});

it("reads from 10 minutes before the newest event, never more than 7 days back", async () => {
    history.mockResolvedValue([]);
    const day = 24 * 60 * 60 * 1000;

    await recoverMissedEvents("http://lidarr", "key");
    const floor = history.mock.calls[0][2] as Date;
    expect(Math.abs(Date.now() - 7 * day - floor.getTime())).toBeLessThan(5000);

    const { event } = await webhookEventStore.storeEvent("lidarr", "Grab", { eventType: "Grab", downloadId: "dl-5" });
    history.mockClear();
    await recoverMissedEvents("http://lidarr", "key");
    const since = history.mock.calls[0][2] as Date;
    expect(event.createdAt.getTime() - since.getTime()).toBe(10 * 60 * 1000);
    expect(history.mock.calls.map((c) => c[3])).toEqual([1, 8, 4, 7]);
});

it("replays missed events in the order Lidarr recorded them", async () => {
    const byType: Record<number, unknown[]> = {
        1: [record("dl-a", {}, 1), record("dl-b", {}, 3)],
        4: [record("dl-a", { message: "stalled" }, 2), record("dl-b", { message: "stalled" }, 4)],
    };
    history.mockImplementation(async (_u, _k, _since, eventType) => byType[eventType] ?? []);
    const order: string[] = [];
    (simpleDownloadManager.onDownloadGrabbed as jest.Mock).mockImplementation(async (id: string) => {
        order.push(`grab ${id}`);
        return { matched: true };
    });
    (simpleDownloadManager.onImportFailed as jest.Mock).mockImplementation(async (id: string) => {
        order.push(`fail ${id}`);
        return {};
    });

    expect(await recoverMissedEvents("http://lidarr", "key")).toBe(4);
    expect(order).toEqual(["grab dl-a", "fail dl-a", "grab dl-b", "fail dl-b"]);
});
