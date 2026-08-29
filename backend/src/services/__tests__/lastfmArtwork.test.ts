/**
 * Last.fm's search results carried three more copies of the same chain.
 *
 * `buildArtistSearchResult` spelled out Fanart-then-Deezer-then-Last.fm by
 * hand, `getTopChartArtists` had its own copy of the same three steps, and
 * `buildTrackSearchResult` asked Deezer alone for the artist picture a track
 * borrows when it has no album art. Two of the three carried their own copy of
 * the hash identifying Last.fm's grey-star placeholder -- redundantly, because
 * `getBestImage` already returns null for it.
 *
 * All three go through `artwork.ts` now, imported dynamically because
 * `artwork.ts` reaches back here for its own Last.fm source and a static pair
 * would be a module cycle.
 *
 * These exercise the two builders directly. They are private, but they are
 * where the changed lines live, and going in through `searchArtists` would put
 * a relevance filter and a fan-out between the test and the thing being tested.
 *
 * Doctrine: the failure and boundary paths first, the happy path last.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        status: "ready",
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: { findFirst: jest.fn().mockResolvedValue({ lastfmApiKey: "k" }) },
        artist: { findMany: jest.fn().mockResolvedValue([]) },
    },
}));

const mockFindArtistArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
    findAlbumArtwork: jest.fn().mockResolvedValue(null),
}));

import { lastFmService } from "../lastfm";

const FOUND = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const LASTFM_GREY =
    "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png";
const LASTFM_REAL = "https://lastfm.freetls.fastly.net/i/u/300x300/real.png";

/** Reach the private builders without going through the search pipeline. */
const svc = lastFmService as any;

const buildArtist = (artist: any, enrich = true) =>
    svc.buildArtistSearchResult(artist, enrich);
const buildTrack = (track: any, enrich = true) => svc.buildTrackSearchResult(track, enrich);

describe("Last.fm's search results go through the one artwork door", () => {
    let getArtistInfo: jest.SpyInstance;
    let getTrackInfo: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFindArtistArtwork.mockResolvedValue(null);
        getArtistInfo = jest.spyOn(svc, "getArtistInfo").mockResolvedValue(null as never);
        getTrackInfo = jest.spyOn(svc, "getTrackInfo").mockResolvedValue(null as never);
    });

    afterEach(() => {
        getArtistInfo.mockRestore();
        getTrackInfo.mockRestore();
    });

    describe("an artist in search results", () => {
        const artist = {
            name: "Perturbator",
            mbid: "a-1",
            listeners: "100",
            url: "u",
            image: [] as any[],
        };

        it("leaves the picture empty when no source had one", async () => {
            const result = await buildArtist(artist);

            expect(result.image).toBeNull();
        });

        it("asks the one door, by name and by id, instead of its own chain", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const result = await buildArtist(artist);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ name: "Perturbator", mbid: "a-1" }),
            );
            expect(result.image).toBe(FOUND);
        });

        it("offers the picture Last.fm already sent as the address of last resort", async () => {
            // Rather than making Last.fm answer twice for something we hold.
            await buildArtist({
                ...artist,
                image: [{ size: "extralarge", "#text": LASTFM_REAL }],
            });

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ candidateUrl: LASTFM_REAL }),
            );
        });

        it("does not offer the grey star Last.fm sends when it has nothing", async () => {
            // getBestImage returns null for that hash, so it never reaches the
            // door. Two call sites used to re-filter it by hand on top.
            const result = await buildArtist({
                ...artist,
                image: [{ size: "extralarge", "#text": LASTFM_GREY }],
            });

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ candidateUrl: null }),
            );
            expect(result.image).toBeNull();
        });

        it("asks nobody when the result is not being enriched", async () => {
            const result = await buildArtist(artist, false);

            expect(mockFindArtistArtwork).not.toHaveBeenCalled();
            expect(result.name).toBe("Perturbator");
        });

        it("falls back to Last.fm's own picture when the door came up empty", async () => {
            getArtistInfo.mockResolvedValue({
                image: [{ size: "extralarge", "#text": LASTFM_REAL }],
            } as never);

            const result = await buildArtist({
                ...artist,
                image: [{ size: "extralarge", "#text": LASTFM_REAL }],
            });

            expect(result.image).toBe(LASTFM_REAL);
        });
    });

    describe("a track in search results", () => {
        const track = {
            name: "Sentient",
            artist: "Perturbator",
            listeners: "10",
            url: "u",
            image: [] as any[],
        };

        it("borrows a picture of the artist, asking every source rather than Deezer alone", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const result = await buildTrack(track);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({ name: "Perturbator" });
            expect(result.image).toBe(FOUND);
        });

        it("does not go looking when the track already has album art", async () => {
            getTrackInfo.mockResolvedValue({
                album: { title: "Dangerous Days", image: [{ size: "extralarge", "#text": LASTFM_REAL }] },
            } as never);

            const result = await buildTrack(track);

            expect(mockFindArtistArtwork).not.toHaveBeenCalled();
            expect(result.image).toBe(LASTFM_REAL);
        });

        it("leaves the picture empty when nobody had one", async () => {
            const result = await buildTrack(track);

            expect(result.image).toBeNull();
        });
    });
});
