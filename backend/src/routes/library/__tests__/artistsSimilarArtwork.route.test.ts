/**
 * The pictures on an artist's "similar artists" strip.
 *
 * `GET /artists/:id` builds that strip along two different paths -- from the
 * artist's own enriched JSON when it has any, and from a live Last.fm lookup
 * when it does not -- and both went looking for a picture the same wrong way.
 * Each asked Deezer, and only Deezer. One of them wrapped that in its own
 * ad-hoc Redis key on top, a sixth cache for a job that already had one.
 *
 * Measured on real data, Deezer alone is a good first guess and a poor only
 * guess. Both paths now go through `artwork.ts`, which tries Fanart, then
 * Deezer, then Last.fm, behind a single cache.
 *
 * The rule both paths share and which is asserted here: an artist already in
 * the library keeps the picture the library holds. That one is local, already
 * downloaded, and chosen deliberately -- going out to a provider to replace it
 * would be slower and worse.
 *
 * Doctrine: the failure and boundary paths first, the happy path last.
 */

jest.mock("p-limit", () => () => (fn: (...args: any[]) => any) => fn());

jest.mock("../../../middleware/auth", () => ({
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "admin", role: "admin" };
        next();
    },
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
}));

// The handler reads req.user directly; this router does not mount the auth
// middleware itself, so the app has to put a user on the request.
const authenticate = (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", role: "admin" };
    next();
};

const mockArtistFindUnique = jest.fn();
const mockArtistFindMany = jest.fn();

jest.mock("../../../utils/db", () => {
    const prisma = {
        artist: {
            // The route accepts an id, a name or an MBID, so it is findFirst.
            findFirst: (...a: any[]) => mockArtistFindUnique(...a),
            findUnique: (...a: any[]) => mockArtistFindUnique(...a),
            findMany: (...a: any[]) => mockArtistFindMany(...a),
            count: jest.fn().mockResolvedValue(0),
        },
        album: { findMany: jest.fn().mockResolvedValue([]) },
        track: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
        // The handler counts this user's plays across the artist's tracks
        // before it ever gets to the similar-artists strip.
        play: { groupBy: jest.fn().mockResolvedValue([]) },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $transaction: (fn: any) => fn(prisma),
    };
    return {
        prisma,
        Prisma: {
            SortOrder: { asc: "asc", desc: "desc" },
            sql: (strings: TemplateStringsArray, ...vals: any[]) => ({ strings, vals }),
            empty: { strings: [""], vals: [] },
            join: (parts: any[]) => ({ parts }),
        },
    };
});

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        del: jest.fn().mockResolvedValue(1),
    },
}));

const mockGetSimilarArtists = jest.fn();
// The swap moved this route's similar-artists lookup off the old Last.fm service to
// the local-centroid / ListenBrainz engine — mock the new door.
jest.mock("../../../services/artistSimilarity", () => ({
    getSimilarArtists: (...a: any[]) => mockGetSimilarArtists(...a),
    enrichSimilarArtists: jest.fn().mockResolvedValue([]),
    MIN_LOCAL_TRACKS: 3,
}));

jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: {
        getArtist: jest.fn().mockResolvedValue(null),
        searchArtist: jest.fn().mockResolvedValue([]),
        getReleaseGroups: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock("../../../services/dataCache", () => ({
    dataCacheService: {
        getArtistImage: jest.fn().mockResolvedValue(null),
        getAlbumCover: jest.fn().mockResolvedValue(null),
        getArtistImagesBatch: jest.fn().mockResolvedValue(new Map()),
        getAlbumCoversBatch: jest.fn().mockResolvedValue(new Map()),
    },
}));

const mockFindArtistArtwork = jest.fn();
jest.mock("../../../services/artwork", () => ({
    findArtistArtwork: (...a: any[]) => mockFindArtistArtwork(...a),
}));

import express from "express";
import request from "supertest";
import libraryArtistRoutes from "../artists";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(authenticate);
    app.use("/library", libraryArtistRoutes);
    return app;
}

const FOUND = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const LOCAL = "native:artists/known-1.jpg";

/** The artist whose page is being rendered. */
const subject = (similarArtistsJson: unknown) => ({
    id: "art-1",
    name: "Perturbator",
    mbid: "11111111-2222-3333-4444-555555555555",
    normalizedName: "perturbator",
    heroUrl: null,
    bio: null,
    genres: [],
    similarArtistsJson,
    enrichmentStatus: "enriched",
    albums: [],
    // The handler reads these straight off the row; without them it throws
    // before it ever reaches the similar-artists strip.
    ownedAlbums: [],
    _count: { albums: 0 },
});

async function similarFrom(res: any): Promise<any[]> {
    return res.body.similarArtists || [];
}

describe("the similar-artists strip and where its pictures come from", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockArtistFindMany.mockResolvedValue([]);
        mockGetSimilarArtists.mockResolvedValue([]);
    });

    describe("built from the artist's own enriched data", () => {
        const enriched = [{ name: "Carpenter Brut", mbid: "sim-1", match: 0.9 }];

        it("leaves the picture empty when no source had one", async () => {
            mockArtistFindUnique.mockResolvedValue(subject(enriched));

            const res = await request(makeApp()).get("/library/artists/art-1");

            expect(res.status).toBe(200);
            const [first] = await similarFrom(res);
            expect(first?.coverArt ?? null).toBeNull();
        });

        it("asks the one door, by name and by id, rather than Deezer alone", async () => {
            mockArtistFindUnique.mockResolvedValue(subject(enriched));
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const res = await request(makeApp()).get("/library/artists/art-1");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Carpenter Brut",
                mbid: "sim-1",
            });
            const [first] = await similarFrom(res);
            expect(first?.coverArt).toBe(FOUND);
        });

        it("keeps the library's own picture instead of going out for one", async () => {
            // Already downloaded, already chosen. Replacing it would be slower
            // and worse.
            mockArtistFindUnique.mockResolvedValue(subject(enriched));
            mockArtistFindMany.mockResolvedValue([
                {
                    id: "known-1",
                    name: "Carpenter Brut",
                    normalizedName: "carpenter brut",
                    mbid: "sim-1",
                    heroUrl: LOCAL,
                    _count: { albums: 3 },
                },
            ]);

            const res = await request(makeApp()).get("/library/artists/art-1");

            const [first] = await similarFrom(res);
            expect(first?.coverArt).toBe(LOCAL);
            expect(mockFindArtistArtwork).not.toHaveBeenCalled();
        });
    });

    describe("built from a live Last.fm lookup", () => {
        it("asks the one door here too", async () => {
            mockArtistFindUnique.mockResolvedValue(subject(null));
            mockGetSimilarArtists.mockResolvedValue([
                { name: "Carpenter Brut", mbid: "sim-1", match: 0.9 },
            ]);
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const res = await request(makeApp()).get("/library/artists/art-1");

            expect(res.status).toBe(200);
            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Carpenter Brut",
                mbid: "sim-1",
            });
        });
    });
});
