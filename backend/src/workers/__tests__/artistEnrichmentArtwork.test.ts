/**
 * The hero image and the album-cover sweep both go through `artwork.ts`. The
 * sweep passes the artist's name with the release-group id, since the sources
 * need it to search Deezer. Failure and boundary paths first, happy path last.
 */

const mockArtistUpdate = jest.fn();
const mockAlbumFindMany = jest.fn();
const mockAlbumUpdate = jest.fn();
const mockSimilarDeleteMany = jest.fn().mockResolvedValue({});
const mockTrackFindFirst = jest.fn().mockResolvedValue({ filePath: "Perturbator/Album/01.flac" });
const mockFindLocalArtistImage = jest.fn().mockResolvedValue(null);

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
            deleteMany: (...a: unknown[]) => mockSimilarDeleteMany(...a),
            createMany: jest.fn().mockResolvedValue({}),
        },
        track: { findFirst: (...a: unknown[]) => mockTrackFindFirst(...a) },
        $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
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

const mockResolveByEntity = jest.fn().mockResolvedValue(true);
jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: { resolveByEntity: (...a: unknown[]) => mockResolveByEntity(...a) },
}));

jest.mock("../../services/artistSimilarity", () => ({
    getSimilarArtists: jest.fn().mockResolvedValue([]),
    findSimilarArtists: jest.fn().mockResolvedValue({ artists: [], failed: false }),
}));


const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

const mockSearchArtist = jest.fn();
const mockGetArtist = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        getArtist: (...a: unknown[]) => mockGetArtist(...a),
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
    findLocalArtistImage: (...a: unknown[]) => mockFindLocalArtistImage(...a),
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
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [] }));
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
            // The door walks every source; the worker stores whatever it finds.
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
            // With only a release-group id the sources can ask the archive and
            // nothing else.
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

describe("an artist row holding another artist's MusicBrainz id", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistUpdate.mockResolvedValue({});
        mockAlbumFindMany.mockResolvedValue([]);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockSearchArtist.mockResolvedValue(answeredWith([]));
    });

    it("drops the id and what it brought when MusicBrainz names someone else (Alexis Ffrench holding Sam Cooke's)", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Sam Cooke", "sort-name": "Cooke, Sam", aliases: [] }));
        mockFindLocalArtistImage.mockResolvedValue("native:artists/art-2.jpg");

        await enrichSimilarArtist({ id: "art-2", name: "Alexis Ffrench", mbid: REAL_MBID, heroUrl: "native:artists/art-2.jpg" } as any);

        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "art-2" },
            data: expect.objectContaining({ mbid: null, summary: null, heroUrl: "native:artists/art-2.jpg" }),
        });
        expect(mockSimilarDeleteMany).toHaveBeenCalledWith({ where: { fromArtistId: "art-2" } });
    });

    it("keeps the id when MusicBrainz's name or an alias is this artist", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "deadmau5", "sort-name": "deadmau5", aliases: [{ name: "Deadmau5" }] }));

        await enrichSimilarArtist({ id: "art-3", name: "Deadmau5", mbid: REAL_MBID } as any);

        expect(mockArtistUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ mbid: null }) }),
        );
    });

    it.each([
        ["accents and punctuation differ", "Sigur Ros", { name: "Sigur Rós", "sort-name": "Sigur Rós", aliases: [] }],
        ["the library uses the sort form", "Glass, Philip", { name: "Philip Glass", "sort-name": "Glass, Philip", aliases: [] }],
        ["only a transliterated alias matches", "Mumiy Troll", { name: "Мумий Тролль", "sort-name": "Mumiy Troll", aliases: [{ name: "Mumiy Troll" }] }],
        ["the library drops a leading article", "Beatles", { name: "The Beatles", "sort-name": "Beatles, The", aliases: [] }],
    ])("keeps a right id when %s", async (_case, local, held) => {
        mockGetArtist.mockResolvedValue(answeredWith(held));

        await enrichSimilarArtist({ id: "art-5", name: local, mbid: REAL_MBID } as any);

        expect(mockSimilarDeleteMany).not.toHaveBeenCalled();
        expect(mockArtistUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ mbid: null }) }),
        );
    });

    it("leaves the row alone while MusicBrainz is unreachable", async () => {
        mockGetArtist.mockResolvedValue({ kind: "transient", error: { code: "NETWORK", message: "down" } });
        jest.requireMock("../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});

        await enrichSimilarArtist({ id: "art-4", name: "Perturbator", mbid: REAL_MBID } as any);

        expect(mockSimilarDeleteMany).not.toHaveBeenCalled();
        expect(mockArtistUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ mbid: null }) }),
        );
        // The unanswered question counts as a failed try; it is not stored as done.
        expect(mockArtistUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ enrichmentStatus: "failed", enrichmentFailures: 1 }) }),
        );
    });

    it("waits for MusicBrainz's rate limit without counting a failure or calling the artist done", async () => {
        mockGetArtist.mockResolvedValue({ kind: "rateLimited", retryAfter: new Date(Date.now() + 5000), evidence: {} });
        jest.requireMock("../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});

        await enrichSimilarArtist({ id: "art-6", name: "Perturbator", mbid: REAL_MBID, enrichmentFailures: 2 } as any);

        const data = mockArtistUpdate.mock.calls.at(-1)[0].data;
        expect(data.enrichmentStatus).toBe("pending");
        expect(data.enrichmentFailures).toBeUndefined();
    });

    it("clears the artist's earlier failures from the failures list once it is answered", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [], genres: [] }));
        jest.requireMock("../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});

        await enrichSimilarArtist({ id: "art-7", name: "Perturbator", mbid: REAL_MBID } as any);

        expect(mockArtistUpdate.mock.calls.at(-1)[0].data.enrichmentStatus).toBe("completed");
        expect(mockResolveByEntity).toHaveBeenCalledWith("artist", "art-7");
    });
});
