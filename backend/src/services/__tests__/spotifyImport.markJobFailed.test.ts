/**
 * An import the worker gives up on reaches the user's tray, whether it matched
 * nothing (and is removed) or matched some tracks (and is kept).
 */

jest.mock("../notificationService", () => ({
    notificationService: { notifyImportFailed: jest.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../../utils/db";
import { notificationService } from "../notificationService";
import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sif_user";
const JOB = "sif_job";

const importJob = (pendingTracks: unknown[]) =>
    prisma.spotifyImportJob.create({
        data: {
            id: JOB,
            userId: USER,
            spotifyPlaylistId: "pl",
            playlistName: "Road Trip",
            status: "downloading",
            albumsTotal: 1,
            tracksTotal: 1,
            pendingTracks: pendingTracks as any,
        },
    });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    (notificationService.notifyImportFailed as jest.Mock).mockClear();
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("tells the user when an import that matched nothing fails", async () => {
    await importJob([{ artist: "Interpol", title: "Evil" }]);

    await spotifyImportService.markJobFailed(JOB, "Worker crashed");

    expect(notificationService.notifyImportFailed).toHaveBeenCalledWith(USER, "Road Trip", "Worker crashed");
    expect(await prisma.spotifyImportJob.count({ where: { id: JOB } })).toBe(0);
});

it("tells the user once and keeps a partly matched import", async () => {
    await importJob([{ artist: "Interpol", title: "Evil", preMatchedTrackId: "t1" }]);

    await spotifyImportService.markJobFailed(JOB, "Worker crashed");

    expect(notificationService.notifyImportFailed).toHaveBeenCalledTimes(1);
    expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } })).status).toBe("failed");
});
