/**
 * A download Lidarr finished without Kima hearing of it is completed by the
 * reconcile pass and announced like any other; a job resumed after a Lidarr
 * outage is not failed as stale while it starts.
 */

jest.mock("../lidarr", () => ({
    lidarrService: { isAlbumAvailableInSnapshot: jest.fn(() => true) },
}));

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_reconcile_user";
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("completes a finished download and tells the user", async () => {
    await prisma.downloadJob.create({
        data: {
            id: "sdm_rec_a", userId: USER, subject: "Interpol - Antics", type: "album", status: "processing",
            targetMbid: "rg-antics", metadata: { artistName: "Interpol", albumTitle: "Antics" },
        },
    });

    const result = await simpleDownloadManager.reconcileWithLidarr({ queue: new Map() } as any);

    expect(result.reconciled).toBe(1);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_rec_a" } })).status).toBe("completed");
    expect(await prisma.notification.count({ where: { userId: USER, type: "download_complete" } })).toBe(1);
});

it("does not fail a resumed job as stale while it starts", async () => {
    await prisma.downloadJob.create({
        data: {
            id: "sdm_rec_b", userId: USER, subject: "Interpol - Antics", type: "album", status: "pending",
            targetMbid: "rg-antics", createdAt: hourAgo(),
            metadata: { artistName: "Interpol", albumTitle: "Antics", pendingSince: new Date().toISOString() },
        },
    });

    await simpleDownloadManager.markStaleJobsAsFailed(null);

    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_rec_b" } })).status).toBe("pending");
});
