/**
 * startDownload acts on why Lidarr refused: an owned album completes the job,
 * an outage is retried, and only a real refusal fails it.
 */

jest.mock("../lidarr", () => ({
    ...jest.requireActual("../lidarr"),
    lidarrService: { addAlbum: jest.fn() },
}));
jest.mock("../musicbrainz", () => ({
    musicBrainzService: { getReleaseGroup: jest.fn().mockResolvedValue({ kind: "answered", value: {} }) },
}));

import { prisma } from "../../utils/db";
import { AcquisitionError, AcquisitionErrorType, lidarrService } from "../lidarr";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_start_user";
const addAlbum = lidarrService.addAlbum as jest.Mock;

const start = () =>
    simpleDownloadManager.startDownload("sdm_start", "Interpol", "Antics", "rg-asked", USER, false);
const row = () => prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_start" } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

beforeEach(async () => {
    addAlbum.mockReset();
    await prisma.downloadJob.create({
        data: { id: "sdm_start", userId: USER, subject: "Interpol - Antics", type: "album", status: "pending", targetMbid: "rg-asked" },
    });
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("completes the job when Lidarr already has the album", async () => {
    addAlbum.mockRejectedValue(
        new AcquisitionError("Already in Lidarr: Existing files meets cutoff: FLAC", AcquisitionErrorType.ALREADY_OWNED, false)
    );

    expect((await start()).success).toBe(true);
    const job = await row();
    expect(job.status).toBe("completed");
    expect((job.metadata as any).statusText).toBe("Already in library");
});

it("retries while Lidarr is unavailable and starts once it answers", async () => {
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
        fn();
        return 0;
    }) as any);
    addAlbum
        .mockRejectedValueOnce(new AcquisitionError("Lidarr unavailable: database is locked", AcquisitionErrorType.LIDARR_UNAVAILABLE))
        .mockResolvedValueOnce({ id: 7, foreignAlbumId: "rg-asked" });

    expect((await start()).success).toBe(true);
    expect(addAlbum).toHaveBeenCalledTimes(2);
    expect((await row()).status).toBe("processing");
});

it("fails with Lidarr's outage, not 'album not found', after the retries", async () => {
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
        fn();
        return 0;
    }) as any);
    addAlbum.mockRejectedValue(
        new AcquisitionError("Lidarr unavailable: socket hang up", AcquisitionErrorType.LIDARR_UNAVAILABLE)
    );

    expect((await start()).success).toBe(false);
    expect(addAlbum).toHaveBeenCalledTimes(3);
    const job = await row();
    expect(job.status).toBe("failed");
    expect(job.error).toBe("Lidarr unavailable: socket hang up");
});
