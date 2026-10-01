/**
 * Discover adds an album to Lidarr only under an artist it tagged, only for the
 * exact MBID it asked for, and only when Lidarr has no files for it yet.
 */

import { lidarrService } from "../lidarr";

const TAG = 22;
const ARTIST_MBID = "artist-mbid";

const artist = (tags: number[]) => ({ id: 5, artistName: "Interpol", foreignArtistId: ARTIST_MBID, tags });
const album = (foreignAlbumId: string, title: string, trackFileCount = 0) => ({
    id: 7, artistId: 5, title, foreignAlbumId, monitored: false, releases: [{ id: 1 }], statistics: { trackFileCount },
});

let catalog: ReturnType<typeof album>[];
const client = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;

beforeEach(() => {
    jest.restoreAllMocks();
    Object.values(client).forEach((fn) => fn.mockReset());
    client.get.mockImplementation(async (url: string) => ({
        data: url.startsWith("/api/v1/album?artistId=") ? catalog : url === "/api/v1/album/7" ? catalog[0] : [],
    }));
    client.put.mockImplementation(async (_url: string, body: unknown) => ({ data: body }));
    client.post.mockResolvedValue({ data: {} });
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    service.enabled = true;
    service.client = client;
    jest.spyOn(service, "getOrCreateDiscoveryTag").mockResolvedValue(TAG);
});

const addForDiscover = (rgMbid: string, title: string) =>
    lidarrService.addAlbum(rgMbid, "Interpol", title, "/music", ARTIST_MBID, true);

it("leaves an artist the user already had in Lidarr alone", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([])]);
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("does not fetch another edition when the asked MBID is missing", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-live", "Antics (Live)")];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("does not take over an album that already has files", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-asked", "Antics", 11)];

    expect(await addForDiscover("rg-asked", "Antics")).toBeNull();
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
});

it("monitors and searches for the album it asked for", async () => {
    jest.spyOn(service, "getArtistList").mockResolvedValue([artist([TAG])]);
    catalog = [album("rg-asked", "Antics")];

    expect(await addForDiscover("rg-asked", "Antics")).not.toBeNull();
    expect(client.post).toHaveBeenCalledWith("/api/v1/command", expect.objectContaining({ name: "AlbumSearch" }));
});
