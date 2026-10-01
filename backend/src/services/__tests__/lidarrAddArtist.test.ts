/**
 * addArtist adds only the artist with the asked MusicBrainz id, monitoring
 * nothing on its own. Profiles chosen in Kima win; otherwise the music folder's
 * defaults in Lidarr are used. A Lidarr outage is thrown so the download waits
 * for Lidarr instead of failing.
 */

import { lidarrService } from "../lidarr";

const MBID = "artist-mbid";
const client = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;
let lookup: { foreignArtistId: string; artistName: string }[];
let folders: { path: string; defaultQualityProfileId?: number; defaultMetadataProfileId?: number }[];

beforeEach(() => {
    jest.restoreAllMocks();
    Object.values(client).forEach((fn) => fn.mockReset());
    lookup = [{ foreignArtistId: MBID, artistName: "Low" }];
    folders = [
        { path: "/other", defaultQualityProfileId: 7, defaultMetadataProfileId: 8 },
        { path: "/music", defaultQualityProfileId: 5, defaultMetadataProfileId: 6 },
    ];
    client.get.mockImplementation(async (url: string) => {
        if (url === "/api/v1/artist/lookup") return { data: lookup };
        if (url === "/api/v1/rootfolder") return { data: folders };
        return { data: [] };
    });
    client.post.mockResolvedValue({ data: { id: 9, foreignArtistId: MBID } });
    jest.spyOn(service, "ensureInitialized").mockResolvedValue(undefined);
    jest.spyOn(service, "getArtistList").mockResolvedValue([]);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as any);
    service.enabled = true;
    service.client = client;
    service.qualityProfileId = 3;
    service.metadataProfileId = 4;
});

const artistPost = () => client.post.mock.calls.find(([url]) => url === "/api/v1/artist");

it("adds with the chosen profiles and monitors no catalogue", async () => {
    expect(await lidarrService.addArtist(MBID, "Low", "/music")).toMatchObject({ id: 9 });
    expect(artistPost()?.[1]).toMatchObject({
        foreignArtistId: MBID,
        qualityProfileId: 3,
        metadataProfileId: 4,
        monitorNewItems: "none",
        addOptions: { monitor: "existing", searchForMissingAlbums: false },
    });
});

it("uses the music folder's defaults in Lidarr when none are chosen in Kima", async () => {
    service.qualityProfileId = null;
    service.metadataProfileId = null;

    await lidarrService.addArtist(MBID, "Low", "/music");

    expect(artistPost()?.[1]).toMatchObject({ rootFolderPath: "/music", qualityProfileId: 5, metadataProfileId: 6 });
});

it("fills only the profile not chosen in Kima from the folder", async () => {
    service.metadataProfileId = null;

    await lidarrService.addArtist(MBID, "Low", "/music");

    expect(artistPost()?.[1]).toMatchObject({ qualityProfileId: 3, metadataProfileId: 6 });
});

it("refuses a new artist when neither Kima nor the folder has profiles", async () => {
    service.qualityProfileId = null;
    folders = [{ path: "/music" }];

    await expect(lidarrService.addArtist(MBID, "Low", "/music")).rejects.toMatchObject({ statusCode: 409 });
    expect(client.post).not.toHaveBeenCalled();
});

it("returns an artist Lidarr already has without needing profiles", async () => {
    service.qualityProfileId = null;
    (service.getArtistList as jest.Mock).mockResolvedValue([{ id: 2, foreignArtistId: MBID }]);

    expect(await lidarrService.addArtist(MBID, "Low", "/music")).toMatchObject({ id: 2 });
    expect(client.post).not.toHaveBeenCalled();
});

it("adds nothing when Lidarr only knows other artists by that name", async () => {
    lookup = [{ foreignArtistId: "another-low", artistName: "Low" }];

    expect(await lidarrService.addArtist(MBID, "Low", "/music")).toBeNull();
    expect(client.post).not.toHaveBeenCalled();
});

it("throws a Lidarr outage instead of reporting the artist missing", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED"), { isAxiosError: true });
    client.get.mockRejectedValue(outage);

    await expect(lidarrService.addArtist(MBID, "Low", "/music")).rejects.toBe(outage);
});
