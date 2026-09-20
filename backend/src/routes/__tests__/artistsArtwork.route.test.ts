/**
 * The two discovery routes had four places that went looking for a picture, and
 * not one of them asked more than a couple of sources.
 *
 * The artist image and the similar-artist images each spelled out their own
 * Fanart-then-Deezer-then-Last.fm chain. The discography built
 * `coverartarchive.org/release-group/<id>/front-500` as a string per album and
 * shipped it without ever asking whether that picture existed -- measured on 39
 * real albums, that address loads for 21 of them. The album route did the same
 * and then, when both the archive and Deezer came up empty, sent the archive
 * address anyway under a comment reading "might 404, but better than nothing".
 *
 * It is not better than nothing: the browser takes the 404, the page shows a
 * broken box, and because that request goes to coverartarchive.org rather than
 * to this server, nothing is ever logged here.
 *
 * All four go through `artwork.ts` now. This file proves the wiring at each,
 * and that no response from either route still carries a guessed address.
 *
 * Doctrine: the failure and boundary paths first, the happy path last.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
    },
}));

const mockGetArtistInfo = jest.fn();
const mockGetTopTracks = jest.fn();
const mockGetBestImage = jest.fn();
jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistInfo: (...a: unknown[]) => mockGetArtistInfo(...a),
        getArtistTopTracks: (...a: unknown[]) => mockGetTopTracks(...a),
        getBestImage: (...a: unknown[]) => mockGetBestImage(...a),
    },
}));

// The swap moved similar artists off lastFmService.getSimilarArtists onto
// the local-centroid / ListenBrainz engine, and bios onto Wikidata. Mock
// both doors so the suite stays offline and the assertions below hold.
const mockGetSimilarArtists = jest.fn();
jest.mock("../../services/artistSimilarity", () => ({
    getSimilarArtists: (...a: unknown[]) => mockGetSimilarArtists(...a),
    enrichSimilarArtists: jest.fn().mockResolvedValue([]),
    MIN_LOCAL_TRACKS: 3,
}));

jest.mock("../../services/wikidata", () => ({
    wikidataService: {
        getArtistInfo: jest.fn().mockResolvedValue(null),
    },
}));

const mockSearchArtist = jest.fn();
const mockGetArtist = jest.fn();
const mockGetReleaseGroups = jest.fn();
const mockGetReleaseGroup = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        // Called first when the route is given an id and no name; without it
        // the handler never reaches the artwork lookup at all.
        getArtist: (...a: unknown[]) => mockGetArtist(...a),
        getReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a),
        getReleaseGroup: (...a: unknown[]) => mockGetReleaseGroup(...a),
        getRelease: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getTrackPreview: jest.fn().mockResolvedValue(null),
        getFreshTrackPreview: jest.fn().mockResolvedValue(null),
    },
}));

const mockWithAlbumArtwork = jest.fn();
const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({
    withAlbumArtwork: (...a: unknown[]) => mockWithAlbumArtwork(...a),
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
}));

import express from "express";
import request from "supertest";
import artistRoutes from "../artists";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/artists", artistRoutes);
    return app;
}

const MBID = "11111111-2222-3333-4444-555555555555";
const ARTIST_IMG = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const COVER = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

describe("the discovery routes and the pictures they promise", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetArtistInfo.mockResolvedValue(null);
        mockGetTopTracks.mockResolvedValue([]);
        mockGetBestImage.mockReturnValue(null);
        mockGetSimilarArtists.mockResolvedValue([]);
        mockSearchArtist.mockResolvedValue([]);
        mockGetArtist.mockResolvedValue({ name: "Perturbator", id: MBID });
        mockGetReleaseGroups.mockResolvedValue([]);
        mockGetReleaseGroup.mockResolvedValue(null);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        // Stand in for the real helper: null every cover unless a test says so.
        mockWithAlbumArtwork.mockImplementation(
            async (items: any[], _read: any, write: any) => items.map((i) => write(i, null)),
        );
    });

    describe("GET /artists/discover/:nameOrMbid", () => {
        it("sends no artist image when no source had one", async () => {
            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(res.status).toBe(200);
            expect(res.body.image).toBeNull();
        });

        it("goes through the one door rather than its own three-source chain", async () => {
            mockGetArtistInfo.mockResolvedValue({ name: "Perturbator" });
            mockFindArtistArtwork.mockResolvedValue({ url: ARTIST_IMG, source: "fanart" });

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ mbid: MBID }),
            );
            expect(res.body.image).toBe(ARTIST_IMG);
        });

        it("asks about each similar artist too, by name and by id", async () => {
            // Similar artists now come from the local-centroid /
            // ListenBrainz engine, not from artist.getSimilar.
            mockGetSimilarArtists.mockResolvedValue([
                {
                    name: "Carpenter Brut",
                    mbid: "sim-1",
                    match: 0.9,
                    url: "https://musicbrainz.org/artist/sim-1",
                },
            ]);
            mockFindArtistArtwork.mockResolvedValue({ url: ARTIST_IMG, source: "deezer" });

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockGetSimilarArtists).toHaveBeenCalledWith(
                MBID,
                "Perturbator",
                10,
            );
            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ name: "Carpenter Brut", mbid: "sim-1" }),
            );
            expect(res.body.similarArtists[0].image).toBe(ARTIST_IMG);
        });

        it("does not source similar artists or their pictures from Last.fm anymore", async () => {
            // The old chain took similar artists (and their pictures) from
            // artist.getSimilar. That call is gone — the engine answers
            // locally or via the ListenBrainz dataset, and pictures come
            // from the standard artwork cascade only.
            mockGetSimilarArtists.mockResolvedValue([
                { name: "Carpenter Brut", mbid: null, match: 0.8, url: "" },
            ]);
            mockFindArtistArtwork.mockResolvedValue(null);

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockGetArtistInfo).not.toHaveBeenCalled();
            expect(mockGetBestImage).not.toHaveBeenCalled();
            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: "Carpenter Brut",
                    mbid: undefined,
                }),
            );
            expect(res.body.similarArtists[0]).toEqual({
                id: "Carpenter Brut",
                name: "Carpenter Brut",
                mbid: null,
                url: "",
                image: null,
            });
        });

        it("runs the whole discography through the artwork sources", async () => {
            mockGetArtistInfo.mockResolvedValue({ name: "Perturbator" });
            mockGetReleaseGroups.mockResolvedValue([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]);
            mockWithAlbumArtwork.mockImplementation(
                async (items: any[], _read: any, write: any) => items.map((i) => write(i, COVER)),
            );

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockWithAlbumArtwork).toHaveBeenCalled();
            expect(res.body.albums[0].coverUrl).toBe(COVER);
        });

        it("names each album by its release-group id when it asks", async () => {
            mockGetArtistInfo.mockResolvedValue({ name: "Perturbator" });
            mockGetReleaseGroups.mockResolvedValue([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]);

            await request(makeApp()).get(`/artists/discover/${MBID}`);

            const [items, read] = mockWithAlbumArtwork.mock.calls[0];
            expect(read(items[0])).toEqual(
                expect.objectContaining({ rgMbid: "rg-1", albumTitle: "Dangerous Days" }),
            );
        });

        it("carries no guessed archive address in its response", async () => {
            mockGetArtistInfo.mockResolvedValue({ name: "Perturbator" });
            mockGetReleaseGroups.mockResolvedValue([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]);

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(JSON.stringify(res.body)).not.toContain("front-500");
        });
    });

    describe("GET /artists/album/:mbid", () => {
        it("refuses an id MusicBrainz could never have issued", async () => {
            const res = await request(makeApp()).get("/artists/album/not-a-uuid");

            expect(res.status).toBe(404);
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("sends null rather than an address it knows may 404", async () => {
            mockGetReleaseGroup.mockResolvedValue({
                id: MBID,
                title: "Dangerous Days",
                "artist-credit": [{ name: "Perturbator" }],
                releases: [],
            });

            const res = await request(makeApp()).get(`/artists/album/${MBID}`);

            expect(res.status).toBe(200);
            expect(res.body.coverUrl).toBeNull();
            expect(JSON.stringify(res.body)).not.toContain("front-500");
        });

        it("sends what the sources found", async () => {
            mockGetReleaseGroup.mockResolvedValue({
                id: MBID,
                title: "Dangerous Days",
                "artist-credit": [{ name: "Perturbator" }],
                releases: [],
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            const res = await request(makeApp()).get(`/artists/album/${MBID}`);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ albumTitle: "Dangerous Days" }),
            );
            expect(res.body.coverUrl).toBe(COVER);
        });
    });
});
