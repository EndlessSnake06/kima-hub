/**
 * ensureAlbumCover uses art embedded in the file first, then asks every source
 * through `artwork.ts`. Failure and boundary paths first, happy path last.
 */

const mockAlbumUpdate = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        album: { update: (...a: unknown[]) => mockAlbumUpdate(...a) },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockFindAlbumArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
}));

import fs from "fs";
import { MusicScannerService } from "../musicScanner";

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";
const FILE = "/music/Perturbator/Dangerous Days/01.flac";

const ALBUM = { id: "alb-1", coverUrl: null as string | null, rgMbid: "rg-1" };

describe("the scanner finding a cover for an album", () => {
    let scanner: any;
    let extractCoverArt: jest.Mock;
    let existsSpy: jest.SpyInstance;

    const ensure = (album = ALBUM) =>
        scanner.ensureAlbumCover(album, FILE, "Perturbator", "Dangerous Days");

    beforeEach(() => {
        jest.clearAllMocks();
        mockAlbumUpdate.mockResolvedValue({});
        mockFindAlbumArtwork.mockResolvedValue(null);
        extractCoverArt = jest.fn().mockResolvedValue(null);
        scanner = new (MusicScannerService as any)();
        scanner.coverArtExtractor = { extractCoverArt, coverCachePath: "/cache/covers" };
        existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    });

    afterEach(() => existsSpy.mockRestore());

    it("does nothing at all when there is no extractor configured", async () => {
        scanner.coverArtExtractor = null;

        await ensure();

        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
    });

    it("leaves an album alone when its stored cover file is still on disk", async () => {
        await ensure({ ...ALBUM, coverUrl: "native:albums/alb-1.jpg" });

        expect(extractCoverArt).not.toHaveBeenCalled();
        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
    });

    it("goes looking again when the stored cover file has gone missing", async () => {
        existsSpy.mockReturnValue(false);

        await ensure({ ...ALBUM, coverUrl: "native:albums/alb-1.jpg" });

        expect(extractCoverArt).toHaveBeenCalledWith(FILE, "alb-1");
    });

    it("asks every source, not Deezer alone, when the file carries no art", async () => {
        await ensure();

        expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
            rgMbid: "rg-1",
            artistName: "Perturbator",
            albumTitle: "Dangerous Days",
        });
    });

    it("stores what the sources found", async () => {
        mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

        await ensure();

        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "alb-1" },
            data: { coverUrl: FOUND },
        });
    });

    it("writes nothing when no source had one", async () => {
        await ensure();

        expect(mockAlbumUpdate).not.toHaveBeenCalled();
    });

    it("does not fail a scan because a picture could not be found", async () => {
        // A scan that dies over artwork loses the music too.
        mockFindAlbumArtwork.mockRejectedValue(new Error("every provider is down"));

        await expect(ensure()).resolves.toBeUndefined();
    });

    it("prefers the art embedded in the file over anything outside", async () => {
        extractCoverArt.mockResolvedValue("albums/alb-1.jpg");

        await ensure();

        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "alb-1" },
            data: { coverUrl: "native:albums/alb-1.jpg" },
        });
        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
    });
});
