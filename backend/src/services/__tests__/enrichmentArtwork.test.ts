/**
 * Enrichment asks the shared artwork door (artwork.ts) for artist and album
 * images, by name and real MBID, and carries the answer into its result.
 * Failure and boundary paths come first, the happy path last.
 */

const mockArtistFindUnique = jest.fn();
const mockAlbumFindUnique = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: { findUnique: (...a: unknown[]) => mockArtistFindUnique(...a) },
        album: {
            findUnique: (...a: unknown[]) => mockAlbumFindUnique(...a),
            findMany: jest.fn().mockResolvedValue([]),
        },
        systemSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockGetReleaseGroups = jest.fn();
const mockSearchAlbum = jest.fn();
const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

jest.mock("../musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn().mockResolvedValue(noData),
        getArtist: jest.fn().mockResolvedValue(noData),
        searchReleaseGroup: jest.fn().mockResolvedValue(noData),
        getReleaseGroup: jest.fn().mockResolvedValue(noData),
        getAlbumCatalogue: jest.fn().mockResolvedValue(noData),
        getReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a),
        searchAlbum: (...a: unknown[]) => mockSearchAlbum(...a),
        getRelease: jest.fn().mockResolvedValue(noData),
        // Real, not a stub: how a title is reduced for matching is the thing
        // under test in the block below.
        normalizeForSearch: (str: string) =>
            str
                .replace(/\s*\([^)]*\)\s*/g, " ")
                .replace(/\s*\[[^\]]*\]\s*/g, " ")
                .replace(
                    /\s*-\s*(\d{4}\s+)?(deluxe|remastered|remaster|edition|version|expanded|bonus|explicit|clean|single|radio edit|remix|acoustic|live|mono|stereo)(\s+\d{4})?\s*(edition|version|mix)?\s*/gi,
                    " ",
                )
                .replace(/\s*-\s*\d{4}\s*$/gi, " ")
                .replace(/\s+/g, " ")
                .trim(),
    },
}));

const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
}));

jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: jest.fn().mockResolvedValue(null),
    isNativePath: (p: string) => typeof p === "string" && p.startsWith("native:"),
}));

// The swap moved similar-artists off Last.fm onto the local-centroid /
// ListenBrainz engine, and bios onto Wikidata. Mock both so the suite
// stays offline and the assertions below stay about artwork sourcing.
jest.mock("../artistSimilarity", () => ({
    getSimilarArtists: jest.fn().mockResolvedValue([]),
}));

jest.mock("../wikidata", () => ({
    wikidataService: {
        getArtistInfo: jest.fn().mockResolvedValue(null),
    },
}));

import { enrichmentService } from "../enrichment";

const REAL_MBID = "11111111-2222-3333-4444-555555555555";
const HERO = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const COVER = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

const ON = {
    enabled: true,
    autoEnrichOnScan: true,
    sources: { musicbrainz: true, coverArtArchive: true },
    rateLimit: { maxRequestsPerMinute: 60, respectApiLimits: true },
    overwriteExisting: false,
    matchingConfidence: "moderate",
} as any;

const OFF = { ...ON, enabled: false } as any;

describe("enrichment keeps asking every source", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockArtistFindUnique.mockResolvedValue({
            id: "art-1",
            name: "Perturbator",
            mbid: REAL_MBID,
        });
        mockAlbumFindUnique.mockResolvedValue({
            id: "alb-1",
            title: "Dangerous Days",
            rgMbid: null,
            artist: { name: "Perturbator", mbid: REAL_MBID },
        });
    });

    describe("an artist", () => {
        it("does nothing at all when enrichment is switched off", async () => {
            expect(await enrichmentService.enrichArtist("art-1", OFF)).toBeNull();
            expect(mockFindArtistArtwork).not.toHaveBeenCalled();
        });

        it("asks by name and by id", async () => {
            await enrichmentService.enrichArtist("art-1", ON);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: REAL_MBID,
            });
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            mockArtistFindUnique.mockResolvedValue({
                id: "art-1",
                name: "Perturbator",
                mbid: "temp-9",
            });

            await enrichmentService.enrichArtist("art-1", ON);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: undefined,
            });
        });

        it("carries the found image into the enrichment result", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });

            const result = await enrichmentService.enrichArtist("art-1", ON);

            expect(result?.heroUrl).toBe(HERO);
        });

        it("leaves the image unset when no source had one", async () => {
            const result = await enrichmentService.enrichArtist("art-1", ON);

            expect(result?.heroUrl).toBeFalsy();
        });
    });

    describe("giving an album its MusicBrainz identity", () => {
        const albumNamed = (title: string) => {
            mockAlbumFindUnique.mockResolvedValue({
                id: "alb-1",
                title,
                rgMbid: null,
                artist: { name: "Depeche Mode", mbid: REAL_MBID },
            });
        };
        // What MusicBrainz actually holds: the plain release GROUP. The deluxe
        // is a release inside it and has no group of its own.
        const groups = [
            { id: "rg-delta", title: "Delta Machine", "primary-type": "Album" },
            { id: "rg-frame", title: "A Broken Frame", "primary-type": "Album" },
        ];

        beforeEach(() => {
            mockGetReleaseGroups.mockResolvedValue(answeredWith(groups));
            mockSearchAlbum.mockResolvedValue(noData);
        });

        it("finds the album whose title carries an edition marker", async () => {
            // The case that left roughly a third of a real library with no id:
            // exact string equality can never match "(Deluxe Edition)" against
            // a group MusicBrainz simply calls "Delta Machine".
            albumNamed("Delta Machine (Deluxe Edition)");

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.rgMbid).toBe("rg-delta");
        });

        it("finds one marked with a trailing dash instead of brackets", async () => {
            albumNamed("A Broken Frame - 2006 Remaster");

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.rgMbid).toBe("rg-frame");
        });

        it("still matches a plain title, and prefers the exact one", async () => {
            mockGetReleaseGroups.mockResolvedValue(answeredWith([
                { id: "rg-live", title: "Delta Machine (Live)", "primary-type": "Album" },
                { id: "rg-delta", title: "Delta Machine", "primary-type": "Album" },
            ]));
            albumNamed("Delta Machine");

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            // Not the live album, which only ties once markers are stripped.
            expect(result?.rgMbid).toBe("rg-delta");
        });

        it("searches by name when the artist itself was never identified", async () => {
            // The case that matters for a library nobody has run through
            // Picard: every artist starts with a placeholder id, the
            // discography branch cannot run, and before this there was no
            // else -- the album was never looked up at all.
            mockAlbumFindUnique.mockResolvedValue({
                id: "alb-1",
                title: "Delta Machine",
                rgMbid: null,
                artist: { name: "Depeche Mode", mbid: "temp-9" },
            });
            mockSearchAlbum.mockResolvedValue(answeredWith({ id: "rg-delta", title: "Delta Machine" }));

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(mockGetReleaseGroups).not.toHaveBeenCalled();
            expect(mockSearchAlbum).toHaveBeenCalledWith("Delta Machine", "Depeche Mode");
            expect(result?.rgMbid).toBe("rg-delta");
        });

        it("refuses a search hit whose title is nothing like the album", async () => {
            // The search returns its best guess with no check of its own. A
            // confidently wrong id is worse than none: it would attach this
            // album to another record permanently.
            albumNamed("Delta Machine");
            mockGetReleaseGroups.mockResolvedValue(answeredWith([]));
            mockSearchAlbum.mockResolvedValue(answeredWith({
                id: "rg-wrong",
                title: "Songs of Faith and Devotion",
            }));

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.rgMbid).toBeUndefined();
        });

        it("accepts a search hit that differs only by an edition marker", async () => {
            albumNamed("Delta Machine (Deluxe Edition)");
            mockGetReleaseGroups.mockResolvedValue(answeredWith([]));
            mockSearchAlbum.mockResolvedValue(answeredWith({ id: "rg-delta", title: "Delta Machine" }));

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.rgMbid).toBe("rg-delta");
        });

        it("does not search when the discography already answered", async () => {
            albumNamed("Delta Machine");

            await enrichmentService.enrichAlbum("alb-1", ON);

            expect(mockSearchAlbum).not.toHaveBeenCalled();
        });

        it("claims nothing when the artist has no such album at all", async () => {
            albumNamed("Some Record MusicBrainz Has Never Heard Of");

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.rgMbid).toBeUndefined();
        });
    });

    describe("an album", () => {
        it("does nothing at all when enrichment is switched off", async () => {
            expect(await enrichmentService.enrichAlbum("alb-1", OFF)).toBeNull();
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("asks with the artist and title, so Deezer can be searched", async () => {
            await enrichmentService.enrichAlbum("alb-1", ON);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith(
                expect.objectContaining({
                    artistName: "Perturbator",
                    albumTitle: "Dangerous Days",
                }),
            );
        });

        it("carries the found cover into the enrichment result", async () => {
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.coverUrl).toBe(COVER);
        });

        it("leaves the cover unset when no source had one", async () => {
            const result = await enrichmentService.enrichAlbum("alb-1", ON);

            expect(result?.coverUrl).toBeFalsy();
        });
    });
});
