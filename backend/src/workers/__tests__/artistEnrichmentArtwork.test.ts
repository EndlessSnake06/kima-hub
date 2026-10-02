/**
 * The hero image and the album-cover sweep both go through `artwork.ts`. The
 * sweep passes the artist's name with the release-group id, since the sources
 * need it to search Deezer. Failure and boundary paths first, happy path last.
 */

const mockArtistUpdate = jest.fn();
const mockAlbumFindMany = jest.fn();
const mockAlbumUpdate = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            update: (...a: unknown[]) => mockArtistUpdate(...a),
            // The worker re-reads the row before writing the hero image, so it
            // does not clobber a local file the scanner already wrote.
            findUnique: jest.fn().mockResolvedValue({ heroUrl: null }),
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
        },
        album: {
            findMany: (...a: unknown[]) => mockAlbumFindMany(...a),
            update: (...a: unknown[]) => mockAlbumUpdate(...a),
        },
        similarArtist: {
            deleteMany: jest.fn().mockResolvedValue({}),
            createMany: jest.fn().mockResolvedValue({}),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        del: jest.fn().mockResolvedValue(1),
    },
}));

jest.mock("../../services/wikidata", () => ({
    wikidataService: { getArtistInfo: jest.fn().mockResolvedValue(null) },
}));

jest.mock("../../services/artistSimilarity", () => ({
    getSimilarArtists: jest.fn().mockResolvedValue([]),
}));


const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

const mockSearchArtist = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        getArtist: jest.fn().mockResolvedValue(noData),
    },
}));

const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
}));

const mockDownloadAndStoreImage = jest.fn();
jest.mock("../../services/imageStorage", () => ({
    downloadAndStoreImage: (...a: unknown[]) => mockDownloadAndStoreImage(...a),
    isNativePath: (p: string) => typeof p === "string" && p.startsWith("native:"),
    nativeFileExists: jest.fn().mockReturnValue(false),
}));

import { enrichSimilarArtist } from "../artistEnrichment";

const REAL_MBID = "11111111-2222-3333-4444-555555555555";
const HERO = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const COVER = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

const artist = {
    id: "art-1",
    name: "Perturbator",
    mbid: REAL_MBID,
} as any;

/** What the worker wrote to the artist row, merged across its several updates. */
function writtenToArtist(): Record<string, unknown> {
    return Object.assign({}, ...mockArtistUpdate.mock.calls.map((c) => c[0].data));
}

describe("the enrichment worker asks every source", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistUpdate.mockResolvedValue({});
        mockAlbumFindMany.mockResolvedValue([]);
        mockAlbumUpdate.mockResolvedValue({});
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
        mockSearchArtist.mockResolvedValue(answeredWith([]));
    });

    describe("the artist's hero image", () => {
        it("records no image when no source had one", async () => {
            await enrichSimilarArtist(artist);

            expect(writtenToArtist().heroUrl).toBeFalsy();
        });

        it("goes through the one door rather than Fanart-then-Deezer by hand", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });

            await enrichSimilarArtist(artist);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: REAL_MBID,
            });
        });

        it("stores whatever image the one door found", async () => {
            // The old chain was Fanart then Deezer and stopped. Any artist
            // only another source had a picture of got none; now the door
            // walks the whole list and the worker stores whatever it finds.
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "deezer" });
            mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");

            await enrichSimilarArtist(artist);

            expect(writtenToArtist().heroUrl).toBe("native:artists/art-1.jpg");
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            // A "temp-" id is kept when MusicBrainz is unreachable; Fanart would
            // 404 on it. The service answers a timeout with `transient`.
            mockSearchArtist.mockResolvedValue({
                kind: "transient",
                error: { code: "TIMEOUT", message: "MusicBrainz timed out" },
            });
            mockFindArtistArtwork.mockResolvedValue(null);

            await enrichSimilarArtist({ ...artist, mbid: "temp-9" });

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: undefined,
            });
        });
    });

    describe("the album-cover sweep", () => {
        const uncovered = [
            { id: "alb-1", rgMbid: "rg-1", title: "Dangerous Days", coverUrl: null },
        ];

        it("passes the artist's name, so Deezer can actually be searched", async () => {
            // The change that matters. With only a release-group id the sources
            // can ask the archive and nothing else, which is the original bug.
            mockAlbumFindMany.mockResolvedValue(uncovered);

            await enrichSimilarArtist(artist);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "Perturbator",
                albumTitle: "Dangerous Days",
            });
        });

        it("stores whatever any source found", async () => {
            mockAlbumFindMany.mockResolvedValue(uncovered);
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            await enrichSimilarArtist(artist);

            expect(mockAlbumUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "alb-1" },
                    data: { coverUrl: COVER },
                }),
            );
        });

        it("writes nothing for an album no source had", async () => {
            mockAlbumFindMany.mockResolvedValue(uncovered);

            await enrichSimilarArtist(artist);

            expect(mockAlbumUpdate).not.toHaveBeenCalled();
        });

        it("still tries for an album whose id this app invented", async () => {
            // The id-keyed sources skip themselves; Deezer does not need an id.
            mockAlbumFindMany.mockResolvedValue([
                { id: "alb-2", rgMbid: "temp-7", title: "Unscanned", coverUrl: null },
            ]);

            await enrichSimilarArtist(artist);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "temp-7",
                artistName: "Perturbator",
                albumTitle: "Unscanned",
            });
        });

        it("leaves an album that already has a cover alone", async () => {
            mockAlbumFindMany.mockResolvedValue([
                { id: "alb-3", rgMbid: "rg-3", title: "Covered", coverUrl: "https://x/y.jpg" },
            ]);

            await enrichSimilarArtist(artist);

            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });
    });
});
