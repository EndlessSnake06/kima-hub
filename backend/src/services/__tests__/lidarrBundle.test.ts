/**
 * Bundle fallback: an album only available inside a multi-album release is
 * grabbed through Lidarr's manual-grab endpoint when the album search found
 * nothing; bundles refused for any other reason are left alone; the size
 * ceiling (0 = off) is honored; "Existing files" rejections are a bundle
 * signal, not proof of ownership.
 */

import { AcquisitionErrorType, bundleCoversAlbum, lidarrService, looksLikeBundle } from "../lidarr";

let ceilingMB = 0;
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({ lidarrBundleMaxSizeMB: ceilingMB })),
}));

const ARTIST_MBID = "artist-mbid";
const artist = { id: 5, artistName: "Interpol", foreignArtistId: ARTIST_MBID, tags: [] };
const album = {
    id: 7, artistId: 5, title: "Dark Metropolis", foreignAlbumId: "rg-dm",
    monitored: false, releases: [{ id: 1 }], statistics: { trackFileCount: 3 },
    releaseDate: "2019-05-01",
};

const bundle = (over: Record<string, unknown> = {}) => ({
    guid: "guid-1", indexerId: 3, discography: true,
    releaseTitle: "Vector Seven - Discography 2017-2024, FLAC (21 releases)",
    size: 2.6e9, statistics: { seeders: 9 },
    rejections: ["Existing files meets cutoff: Lossless"],
    ...over,
});

let artistReleases: ReturnType<typeof bundle>[];
const client = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;

beforeEach(() => {
    jest.restoreAllMocks();
    Object.values(client).forEach((fn) => fn.mockReset());
    ceilingMB = 0;
    artistReleases = [];
    client.get.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/v1/album?artistId=")) return { data: [album] };
        if (url === "/api/v1/album/7") return { data: album };
        if (url.startsWith("/api/v1/command/")) return { data: { status: "completed", message: "Album search completed. 0 reports downloaded." } };
        if (url.startsWith("/api/v1/release?artistId=") || url === "/api/v1/release") return { data: artistReleases };
        return { data: [] };
    });
    client.put.mockImplementation(async (_url: string, body: unknown) => ({ data: body }));
    client.post.mockResolvedValue({ data: { id: 1 } });
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    service.enabled = true;
    service.client = client;
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist]);
});

const addAlbum = () => lidarrService.addAlbum("rg-dm", "Interpol", "Dark Metropolis", "/music", ARTIST_MBID, false);

it("recognizes bundles", () => {
    expect(looksLikeBundle({ discography: true })).toBe(true);
    expect(looksLikeBundle({ releaseTitle: "A - (2 releases: Focus Infinity / Delta City)" })).toBe(true);
    expect(looksLikeBundle({ releaseTitle: "A - Album (2019) [FLAC]" })).toBe(false);
});

it("covers albums by title mention or year range", () => {
    expect(bundleCoversAlbum("X - Discography 2017-2024 (21 releases)", "Dark Metropolis", 2019)).toBe(true);
    expect(bundleCoversAlbum("X - Discography 2017-2018 (5 releases)", "Dark Metropolis", 2019)).toBe(false);
    expect(bundleCoversAlbum("X - Dark Metropolis / Electric Blood (2 releases)", "Dark Metropolis")).toBe(true);
    expect(bundleCoversAlbum("X - Other Stuff (3 releases)", "Dark Metropolis", 2019)).toBe(false);
});

it("grabs the bundle when the album search found nothing", async () => {
    artistReleases = [bundle()];
    await expect(addAlbum()).resolves.toMatchObject({ title: "Dark Metropolis" });
    expect(client.post).toHaveBeenCalledWith("/api/v1/release", { guid: "guid-1", indexerId: 3 });
});

it("leaves a bundle alone when any rejection is not about existing files", async () => {
    artistReleases = [bundle({ rejections: ["Existing files meets cutoff: Lossless", "Invalid quality"] })];
    await expect(addAlbum()).rejects.toMatchObject({ type: AcquisitionErrorType.NO_RELEASES_AVAILABLE });
    expect(client.post).not.toHaveBeenCalledWith("/api/v1/release", expect.anything());
});

it("honors the size ceiling", async () => {
    ceilingMB = 1000;
    artistReleases = [bundle()];
    await expect(addAlbum()).rejects.toMatchObject({ type: AcquisitionErrorType.NO_RELEASES_AVAILABLE });
    expect(client.post).not.toHaveBeenCalledWith("/api/v1/release", expect.anything());
});

it("prefers the smallest covering bundle, then most seeders", async () => {
    artistReleases = [
        bundle({ guid: "big", size: 5e9, statistics: { seeders: 50 } }),
        bundle({ guid: "small-few", size: 2e9, statistics: { seeders: 1 } }),
        bundle({ guid: "small-many", size: 2e9, statistics: { seeders: 30 } }),
    ];
    await addAlbum();
    expect(client.post).toHaveBeenCalledWith("/api/v1/release", { guid: "small-many", indexerId: 3 });
});

it("reports existing-files-only as availability, not ownership", async () => {
    artistReleases = [bundle({ discography: false, releaseTitle: "Vector Seven - Other Box (2 releases)",
        rejections: ["Existing files on disk is of equal or higher preference: FLAC v1"] })];
    await expect(addAlbum()).rejects.toMatchObject({ type: AcquisitionErrorType.NO_RELEASES_AVAILABLE });
});

it("never bundle-grabs for Discover", async () => {
    artistReleases = [bundle()];
    await lidarrService.addAlbum("rg-dm", "Interpol", "Dark Metropolis", "/music", ARTIST_MBID, true)
        .catch(() => undefined);
    expect(client.post).not.toHaveBeenCalledWith("/api/v1/release", expect.anything());
});
