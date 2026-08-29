/**
 * dataCache used to ask one provider per kind of thing and give up.
 *
 * `getAlbumCover` asked the Cover Art Archive and nothing else, which is why so
 * many album cards served from this cache fell back to a placeholder when
 * Deezer had the record all along -- measured on 39 real albums, the archive
 * has 21 and Deezer has 31. `fetchArtistImage` spelled out its own
 * Fanart-then-Deezer-then-Last.fm chain, one of five such chains, each with its
 * own ordering and its own copy of the Last.fm placeholder filter.
 *
 * Both now go through `artwork.ts`. What is proved here is that wiring, and the
 * detail it turned on: the album lookup reads the title and artist out of the
 * database, because without them the sources cannot ask Deezer at all -- and
 * Deezer is the one most likely to have the record.
 *
 * Doctrine: the failure and boundary paths first, the happy path last.
 */

const mockAlbumFindUnique = jest.fn();
const mockAlbumUpdate = jest.fn();
const mockArtistFindUnique = jest.fn();
const mockArtistUpdate = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findUnique: (...a: unknown[]) => mockAlbumFindUnique(...a),
            update: (...a: unknown[]) => mockAlbumUpdate(...a),
            findMany: jest.fn().mockResolvedValue([]),
        },
        artist: {
            findUnique: (...a: unknown[]) => mockArtistFindUnique(...a),
            update: (...a: unknown[]) => mockArtistUpdate(...a),
            findMany: jest.fn().mockResolvedValue([]),
        },
        track: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        mget: jest.fn().mockResolvedValue([]),
        pipeline: jest.fn(() => ({ setex: jest.fn(), exec: jest.fn().mockResolvedValue([]) })),
    },
}));

const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
    // Real, not a stub: what counts as a usable id is the thing under test.
    isRealMbid: (id: string | null | undefined) => Boolean(id) && !id!.startsWith("temp-"),
}));

const mockDownloadAndStoreImage = jest.fn();
jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: (...a: unknown[]) => mockDownloadAndStoreImage(...a),
    isNativePath: (p: string) => typeof p === "string" && p.startsWith("native:"),
}));

import { dataCacheService } from "../dataCache";

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

describe("dataCache asks every source, not just one", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAlbumFindUnique.mockResolvedValue(null);
        mockAlbumUpdate.mockResolvedValue({});
        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistUpdate.mockResolvedValue({});
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
    });

    describe("album covers", () => {
        it("still looks for an album whose id this app invented", async () => {
            // 46% of a real library carries a "temp-" id, minted by the scanner
            // when it cannot match an album to MusicBrainz. This used to return
            // "no cover" for all of them without asking anyone -- correct for
            // the Cover Art Archive, which needs a real id, and wrong for
            // Deezer, which searches by artist and title.
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Reliance",
                artist: { name: "Soen" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const cover = await dataCacheService.getAlbumCover("a1", "temp-123");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "temp-123",
                artistName: "Soen",
                albumTitle: "Reliance",
            });
            expect(cover).toBe(FOUND);
        });

        it("gives up only when there is nothing at all to search on", async () => {
            mockAlbumFindUnique.mockResolvedValue(null);

            expect(await dataCacheService.getAlbumCover("a1", "temp-123")).toBeNull();
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("reads the title and artist out of the database, so Deezer can be asked", async () => {
            // The point of the change. Without these two fields the album
            // sources can only try the archive, which is where this started.
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });

            await dataCacheService.getAlbumCover("a1", "rg-1");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "Perturbator",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("stores what the sources found against the album", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const cover = await dataCacheService.getAlbumCover("a1", "rg-1");

            expect(cover).toBe(FOUND);
            expect(mockAlbumUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ data: { coverUrl: FOUND } }),
            );
        });

        it("returns null, and stores nothing, when no source had it", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });

            expect(await dataCacheService.getAlbumCover("a1", "rg-1")).toBeNull();
            expect(mockAlbumUpdate).not.toHaveBeenCalled();
        });

        it("still works on a real id when the album row has gone missing", async () => {
            mockAlbumFindUnique.mockResolvedValue(null);
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

            const cover = await dataCacheService.getAlbumCover("a1", "rg-1");

            // Nothing to ask Deezer with, but the archive only needs the id.
            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "",
                albumTitle: "",
            });
            expect(cover).toBe(FOUND);
        });

        it("never asks anyone when the album already has a cover", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: "native:albums/a1.jpg",
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });

            expect(await dataCacheService.getAlbumCover("a1", "rg-1")).toBe(
                "native:albums/a1.jpg",
            );
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });
    });

    describe("artist images", () => {
        it("goes through the one door rather than its own hand-rolled chain", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Perturbator", mbid: "artist-1" });
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });
            mockDownloadAndStoreImage.mockResolvedValue("native:artists/x1.jpg");

            const image = await dataCacheService.getArtistImage("x1", "Perturbator", "artist-1");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: "artist-1",
            });
            expect(image).toBe("native:artists/x1.jpg");
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            // A "temp-" id is this app's own invention, not a MusicBrainz id;
            // Fanart would 404 on every one of them.
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Perturbator", mbid: "temp-9" });
            mockFindArtistArtwork.mockResolvedValue(null);

            await dataCacheService.getArtistImage("x1", "Perturbator", "temp-9");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: undefined,
            });
        });

        it("falls back to the address itself when the local copy cannot be written", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Perturbator", mbid: "artist-1" });
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockDownloadAndStoreImage.mockResolvedValue(null);

            expect(await dataCacheService.getArtistImage("x1", "Perturbator", "artist-1")).toBe(FOUND);
        });

        it("returns null when no source had an image", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Nobody", mbid: null });

            expect(await dataCacheService.getArtistImage("x1", "Nobody", null)).toBeNull();
            expect(mockDownloadAndStoreImage).not.toHaveBeenCalled();
        });
    });
});
