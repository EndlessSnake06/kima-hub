/**
 * Lidarr webhook events reach the right handler with the fields Lidarr
 * actually sends (album ids arrive as `mbId`).
 */

jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: {
        onDownloadGrabbed: jest.fn().mockResolvedValue({ matched: false }),
        onDownloadComplete: jest.fn().mockResolvedValue({}),
        onImportFailed: jest.fn().mockResolvedValue({}),
        onAlbumDeleted: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true }) }));
jest.mock("../lidarrFailures", () => ({ rejectSingleTrackPost: jest.fn() }));
jest.mock("../../jobs/queueCleaner", () => ({ queueCleaner: { start: jest.fn() } }));

import { dispatchWebhookEvent } from "../webhookHandlers";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { requestScan } from "../../workers/scanRequest";

const album = { id: 42, mbId: "rg-1", title: "Antics" };
const artist = { name: "Interpol" };

beforeEach(() => jest.clearAllMocks());

it("passes the album id from a Grab", async () => {
    await dispatchWebhookEvent("Grab", { downloadId: "d1", albums: [album], artist });
    expect(simpleDownloadManager.onDownloadGrabbed).toHaveBeenCalledWith("d1", "rg-1", "Antics", "Interpol", 42, { bundle: false });
});

it("matches a bundle grab on any of its albums", async () => {
    (simpleDownloadManager.onDownloadGrabbed as jest.Mock)
        .mockResolvedValueOnce({ matched: false })
        .mockResolvedValueOnce({ matched: true, jobId: "j2" });
    const jobId = await dispatchWebhookEvent("Grab", {
        downloadId: "d2",
        albums: [{ id: 1, mbId: "rg-a", title: "Discography" }, { id: 2, mbId: "rg-dm", title: "Dark Metropolis" }],
        artist,
    });
    expect(jobId).toBe("j2");
    expect(simpleDownloadManager.onDownloadGrabbed).toHaveBeenNthCalledWith(
        2, "d2", "rg-dm", "Dark Metropolis", "Interpol", 2, { bundle: true }
    );
});

it("passes the album id from a Download", async () => {
    await dispatchWebhookEvent("Download", { downloadId: "d1", album, artist });
    expect(simpleDownloadManager.onDownloadComplete).toHaveBeenCalledWith("d1", "rg-1", "Interpol", "Antics", 42);
});

it.each(["ImportFailure", "DownloadFailure"])("counts a %s against the download", async (eventType) => {
    await dispatchWebhookEvent(eventType, { downloadId: "d1", album, artist });
    expect(simpleDownloadManager.onImportFailed).toHaveBeenCalledWith("d1", "Import failed", "rg-1");
});

it("hands an AlbumDelete to the download manager", async () => {
    await dispatchWebhookEvent("AlbumDelete", { album, artist, deletedFiles: true });
    expect(simpleDownloadManager.onAlbumDeleted).toHaveBeenCalledWith(42);
});

it.each(["Rename", "Retag"])("rescans the library after a %s", async (eventType) => {
    await dispatchWebhookEvent(eventType, { artist });
    expect(requestScan).toHaveBeenCalledWith({ source: "lidarr-rename" });
    expect(simpleDownloadManager.onDownloadComplete).not.toHaveBeenCalled();
});
