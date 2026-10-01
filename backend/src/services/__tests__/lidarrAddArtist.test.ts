/**
 * addArtist adds only the artist with the asked MusicBrainz id, with the
 * profiles the user chose, monitoring nothing on its own. A Lidarr outage is
 * thrown so the download waits for Lidarr instead of failing.
 */

import { lidarrService } from "../lidarr";

const MBID = "artist-mbid";
const client = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
const service = lidarrService as any;
let lookup: { foreignArtistId: string; artistName: string }[];

beforeEach(() => {
    jest.restoreAllMocks();
    Object.values(client).forEach((fn) => fn.mockReset());
    lookup = [{ foreignArtistId: MBID, artistName: "Low" }];
    client.get.mockImplementation(async (url: string) => {
        if (url === "/api/v1/artist/lookup") return { data: lookup };
        if (url === "/api/v1/rootfolder") return { data: [{ path: "/music" }] };
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
    expect(await lidarrService.addArtist(MBID, "Low")).toMatchObject({ id: 9 });
    expect(artistPost()?.[1]).toMatchObject({
        foreignArtistId: MBID,
        qualityProfileId: 3,
        metadataProfileId: 4,
        monitorNewItems: "none",
        addOptions: { monitor: "existing", searchForMissingAlbums: false },
    });
});

it("refuses a new artist until the profiles are chosen", async () => {
    service.qualityProfileId = null;

    await expect(lidarrService.addArtist(MBID, "Low")).rejects.toThrow(/Choose a Lidarr quality and metadata profile/);
    expect(client.post).not.toHaveBeenCalled();
});

it("returns an artist Lidarr already has without needing profiles", async () => {
    service.qualityProfileId = null;
    (service.getArtistList as jest.Mock).mockResolvedValue([{ id: 2, foreignArtistId: MBID }]);

    expect(await lidarrService.addArtist(MBID, "Low")).toMatchObject({ id: 2 });
    expect(client.post).not.toHaveBeenCalled();
});

it("adds nothing when Lidarr only knows other artists by that name", async () => {
    lookup = [{ foreignArtistId: "another-low", artistName: "Low" }];

    expect(await lidarrService.addArtist(MBID, "Low")).toBeNull();
    expect(client.post).not.toHaveBeenCalled();
});

it("throws a Lidarr outage instead of reporting the artist missing", async () => {
    const outage = Object.assign(new Error("connect ECONNREFUSED"), { isAxiosError: true });
    client.get.mockRejectedValue(outage);

    await expect(lidarrService.addArtist(MBID, "Low")).rejects.toBe(outage);
});
