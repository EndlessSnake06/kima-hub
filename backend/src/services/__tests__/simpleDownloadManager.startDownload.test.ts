/**
 * startDownload acts on why Lidarr refused: an owned album completes the job,
 * an outage is retried, and only a real refusal fails it. A refused library
 * album falls back to one untried album by the same artist.
 */

jest.mock("../lidarr", () => ({
    ...jest.requireActual("../lidarr"),
    lidarrService: { addAlbum: jest.fn(), getArtistAlbums: jest.fn() },
}));
jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: jest.fn().mockResolvedValue({
            kind: "answered",
            value: { "artist-credit": [{ artist: { id: "artist-1" } }] },
        }),
    },
}));

import { prisma } from "../../utils/db";
import { AcquisitionError, AcquisitionErrorType, lidarrService } from "../lidarr";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_start_user";
const addAlbum = lidarrService.addAlbum as jest.Mock;
const getArtistAlbums = lidarrService.getArtistAlbums as jest.Mock;
const lidarrAlbum = (foreignAlbumId: string, title: string, percentOfTracks = 0) => ({
    id: foreignAlbumId.length,
    foreignAlbumId,
    title,
    albumType: "Album",
    statistics: { percentOfTracks },
});

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
    getArtistAlbums.mockReset();
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

it("records the artist on the job", async () => {
    addAlbum.mockResolvedValue({ id: 7, foreignAlbumId: "rg-asked" });

    await start();

    expect((await row()).artistMbid).toBe("artist-1");
});

it("falls back past albums already queued or already owned", async () => {
    await prisma.downloadJob.create({
        data: { id: "sdm_queued", userId: USER, subject: "Interpol - Turn On", type: "album", status: "pending", targetMbid: "rg-queued", artistMbid: "artist-1" },
    });
    getArtistAlbums.mockResolvedValue([
        lidarrAlbum("rg-asked", "Antics"),
        lidarrAlbum("rg-queued", "Turn On the Bright Lights"),
        lidarrAlbum("rg-owned", "Our Love to Admire", 100),
        lidarrAlbum("rg-next", "El Pintor"),
    ]);
    addAlbum.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 9, foreignAlbumId: "rg-next" });

    await start();

    expect((await row()).status).toBe("exhausted");
    const fallback = await prisma.downloadJob.findFirstOrThrow({
        where: { userId: USER, targetMbid: "rg-next" },
    });
    expect(fallback.status).toBe("processing");
    expect(addAlbum).toHaveBeenCalledTimes(2);
});

it("refuses a second active job for the same album", async () => {
    await expect(
        prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Antics", type: "album", status: "processing", targetMbid: "rg-asked" },
        })
    ).rejects.toMatchObject({ code: "P2002" });
});
