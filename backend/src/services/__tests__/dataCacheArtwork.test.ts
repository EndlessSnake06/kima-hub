/**
 * dataCache's album cover and artist image go through `artwork.ts`. The album
 * lookup reads title and artist from the database so Deezer can be searched.
 * Failure and boundary paths first, happy path last.
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
            // A "temp-" id has no MusicBrainz match, but Deezer can still find
            // the album by artist and title.
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
            // With the title and artist the album sources can search; without
            // them only the archive is tried.
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Brad Sucks" },
            });

            await dataCacheService.getAlbumCover("a1", "10e85e9b-0f07-33d4-a927-18a273f86eca");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "10e85e9b-0f07-33d4-a927-18a273f86eca",
                artistName: "Brad Sucks",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("stores what the sources found against the album", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Brad Sucks" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const cover = await dataCacheService.getAlbumCover("a1", "10e85e9b-0f07-33d4-a927-18a273f86eca");

            expect(cover).toBe(FOUND);
            expect(mockAlbumUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ data: { coverUrl: FOUND } }),
            );
        });

        it("returns null, and stores nothing, when no source had it", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: null,
                title: "Age Of Aquarius",
                artist: { name: "Brad Sucks" },
            });

            expect(await dataCacheService.getAlbumCover("a1", "10e85e9b-0f07-33d4-a927-18a273f86eca")).toBeNull();
            expect(mockAlbumUpdate).not.toHaveBeenCalled();
        });

        it("still works on a real id when the album row has gone missing", async () => {
            mockAlbumFindUnique.mockResolvedValue(null);
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

            const cover = await dataCacheService.getAlbumCover("a1", "10e85e9b-0f07-33d4-a927-18a273f86eca");

            // Nothing to ask Deezer with, but the archive only needs the id.
            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "10e85e9b-0f07-33d4-a927-18a273f86eca",
                artistName: "",
                albumTitle: "",
            });
            expect(cover).toBe(FOUND);
        });

        it("never asks anyone when the album already has a cover", async () => {
            mockAlbumFindUnique.mockResolvedValue({
                coverUrl: "native:albums/a1.jpg",
                title: "Age Of Aquarius",
                artist: { name: "Brad Sucks" },
            });

            expect(await dataCacheService.getAlbumCover("a1", "10e85e9b-0f07-33d4-a927-18a273f86eca")).toBe(
                "native:albums/a1.jpg",
            );
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });
    });

    describe("artist images", () => {
        it("goes through the one door rather than its own hand-rolled chain", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" });
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });
            mockDownloadAndStoreImage.mockResolvedValue("native:artists/x1.jpg");

            const image = await dataCacheService.getArtistImage("x1", "Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Brad Sucks",
                mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55",
            });
            expect(image).toBe("native:artists/x1.jpg");
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            // A "temp-" id is this app's own invention, not a MusicBrainz id;
            // Fanart would 404 on every one of them.
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Brad Sucks", mbid: "temp-9" });
            mockFindArtistArtwork.mockResolvedValue(null);

            await dataCacheService.getArtistImage("x1", "Brad Sucks", "temp-9");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Brad Sucks",
                mbid: undefined,
            });
        });

        it("falls back to the address itself when the local copy cannot be written", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" });
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockDownloadAndStoreImage.mockResolvedValue(null);

            expect(await dataCacheService.getArtistImage("x1", "Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55")).toBe(FOUND);
        });

        it("returns null when no source had an image", async () => {
            mockArtistFindUnique.mockResolvedValue({ heroUrl: null, name: "Nobody", mbid: null });

            expect(await dataCacheService.getArtistImage("x1", "Nobody", null)).toBeNull();
            expect(mockDownloadAndStoreImage).not.toHaveBeenCalled();
        });
    });
});
