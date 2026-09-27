/**
 * Tier-order tests for getSimilarArtists (
 * "lets try listenbrainz with deezer fallback"). All HTTP is mocked at the
 * service-module boundary — no live calls, no DB, no Redis.
 *
 * Covered:
 * - ListenBrainz-first ordering; Deezer results discarded when LB fills the
 *   request.
 * - Deezer fallback when LB is empty; merge + name-dedupe when LB is short.
 * - Empty result when both remote tiers are empty — local only re-ranks,
 *   never answers.
 * - inLibrary flag correctness (MBID-then-name lookup).
 * - Re-rank bound: match adjustments never exceed ±0.1, and an in-library
 *   artist's score moves by exactly the distance-derived delta.
 */

const mockLb = { getSimilarArtists: jest.fn() };
const mockDeezer = { getRelatedArtists: jest.fn() };
const mockPrisma = {
    artist: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
};
const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
    status: "ready",
};

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../listenBrainz", () => ({ listenBrainzService: mockLb }));
jest.mock("../deezer", () => ({ deezerService: mockDeezer }));

import { getSimilarArtists } from "../artistSimilarity";

const SEED_MBID = "11111111-1111-1111-1111-111111111111";

const lb = (name: string, mbid: string, match: number) => ({
    name,
    mbid,
    match,
    url: `https://listenbrainz.org/artist/${mbid}`,
});
const dz = (name: string, match: number) => ({
    name,
    match,
    url: `https://www.deezer.com/artist/${name.length}`,
});

beforeEach(() => {
    jest.resetAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    mockPrisma.artist.findUnique.mockResolvedValue(null);
    mockPrisma.artist.findFirst.mockResolvedValue(null);
    mockPrisma.artist.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockLb.getSimilarArtists.mockResolvedValue([]);
    mockDeezer.getRelatedArtists.mockResolvedValue([]);
});

describe("getSimilarArtists — tier ordering (LB first, Deezer fallback, local never answers)", () => {
    it("uses ListenBrainz alone when it fills the request", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([
            lb("LB One", "m-lb-1", 0.95),
            lb("LB Two", "m-lb-2", 0.8),
            lb("LB Three", "m-lb-3", 0.7),
        ]);
        mockDeezer.getRelatedArtists.mockResolvedValue([
            dz("Dz One", 0.9),
            dz("Dz Two", 0.8),
            dz("Dz Three", 0.7),
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 3);

        expect(result.map((r) => r.name)).toEqual(["LB One", "LB Two", "LB Three"]);
        // Both tiers ran concurrently, but Deezer's results were discarded.
        expect(mockDeezer.getRelatedArtists).toHaveBeenCalledWith("Seed Artist", 3);
    });

    it("falls back to Deezer when ListenBrainz is empty", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([]);
        mockDeezer.getRelatedArtists.mockResolvedValue([
            dz("Dz One", 0.9),
            dz("Dz Two", 0.85),
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result.map((r) => r.name)).toEqual(["Dz One", "Dz Two"]);
        expect(result[0].url).toBe("https://www.deezer.com/artist/6");
    });

    it("merges LB + Deezer when LB is short, deduping by name (LB entry wins)", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([lb("Shared Artist", "m-same", 0.9)]);
        mockDeezer.getRelatedArtists.mockResolvedValue([
            dz("Shared Artist", 0.9), // same artist via Deezer — must not duplicate
            dz("Dz Only", 0.8),
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result.map((r) => r.name)).toEqual(["Shared Artist", "Dz Only"]);
        // The surviving "Shared Artist" is the LB entry (LB keyed first).
        expect(result[0].mbid).toBe("m-same");
        expect(result[0].url).toBe("https://listenbrainz.org/artist/m-same");
    });

    it("returns [] when both remote tiers are empty — local never answers", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([]);
        mockDeezer.getRelatedArtists.mockResolvedValue([]);
        // Even with a seed row and a usable centroid, the local path must
        // not substitute its own artists.
        mockPrisma.artist.findUnique.mockResolvedValue({ id: "a-seed" });
        mockPrisma.$queryRaw
            .mockResolvedValueOnce([{ embedding: "[1,0,0]", trackCount: 5 }])
            .mockResolvedValueOnce([
                { artistId: "a-1", name: "Local One", mbid: "m-loc-1", distance: 0.3 },
                { artistId: "a-2", name: "Local Two", mbid: "m-loc-2", distance: 0.5 },
            ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result).toEqual([]);
        expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("returns [] when every source has nothing (and never throws)", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([]);
        mockDeezer.getRelatedArtists.mockResolvedValue([]);
        mockPrisma.artist.findUnique.mockResolvedValue(null); // seed not in library

        await expect(getSimilarArtists(SEED_MBID, "Seed Artist", 5)).resolves.toEqual([]);
    });

    it("never throws when both remote tiers reject", async () => {
        mockLb.getSimilarArtists.mockRejectedValue(new Error("LB down"));
        mockDeezer.getRelatedArtists.mockRejectedValue(new Error("Deezer down"));

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);
        expect(result).toEqual([]);
    });

    it("skips ListenBrainz entirely when there is no MBID (Deezer is name-keyed)", async () => {
        mockDeezer.getRelatedArtists.mockResolvedValue([dz("Dz One", 0.9)]);

        const result = await getSimilarArtists("", "Nameless Artist", 3);

        expect(mockLb.getSimilarArtists).not.toHaveBeenCalled();
        expect(result.map((r) => r.name)).toEqual(["Dz One"]);
    });
});

describe("getSimilarArtists — inLibrary flag", () => {
    it("sets inLibrary by MBID lookup", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([
            lb("In Our Library", "m-owned", 0.9),
            lb("Not In Library", "m-unknown", 0.85),
        ]);
        // Only the first artist has a row here.
        mockPrisma.artist.findMany.mockImplementation(async (args: any) => {
          const wanted: string[] = args?.where?.mbid?.in ?? [];
          return wanted.includes("m-owned") ? [{ id: "a-owned", mbid: "m-owned" }] : [];
        });

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 2);

        const owned = result.find((r) => r.mbid === "m-owned");
        const unknown = result.find((r) => r.mbid === "m-unknown");
        expect(owned?.inLibrary).toBe(true);
        expect(unknown?.inLibrary).toBe(false);
    });

    it("falls back to name lookup for results without an MBID", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([]);
        mockDeezer.getRelatedArtists.mockResolvedValue([dz("Signed To Us", 0.9)]);
        mockPrisma.artist.findMany.mockImplementation(async (args: any) => {
          const wanted: string[] = args?.where?.name?.in ?? [];
          return wanted.includes("Signed To Us") ? [{ id: "a-signed", name: "Signed To Us" }] : [];
        });

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 2);
        expect(result[0].inLibrary).toBe(true);
    });
});

describe("getSimilarArtists — ±0.1 re-rank bound", () => {
    it("dampens an in-library artist whose centroid is maximally distant", async () => {
        // Same match for both; ordering after re-rank proves the dampening.
        mockLb.getSimilarArtists.mockResolvedValue([
            lb("Owned Distant", "m-owned", 0.9),
            lb("Unknown", "m-unknown", 0.9),
        ]);
        mockPrisma.artist.findMany.mockImplementation(async (args: any) => {
          const wanted: string[] = args?.where?.mbid?.in ?? [];
          return wanted.includes("m-owned") ? [{ id: "a-owned", mbid: "m-owned" }] : [];
        });
        mockPrisma.artist.findUnique.mockResolvedValue({ id: "a-seed" });
        // Seed centroid [1,0]; owned artist's centroid [0,1] → distance 1.
        mockPrisma.$queryRaw.mockResolvedValue([
            { artistId: "a-seed", embedding: "[1,0]", trackCount: 5 },
            { artistId: "a-owned", embedding: "[0,1]", trackCount: 4 },
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 2);

        const owned = result.find((r) => r.mbid === "m-owned")!;
        const unknown = result.find((r) => r.mbid === "m-unknown")!;
        expect(owned.match).toBeCloseTo(0.8, 5); // 0.9 − 0.1
        expect(unknown.match).toBe(0.9); // not in library — untouched
        // The dampened artist sinks below the untouched one.
        expect(result.map((r) => r.name)).toEqual(["Unknown", "Owned Distant"]);
    });

    it("boosts an in-library artist whose centroid matches the seed's", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([
            lb("Owned Close", "m-owned", 0.85),
            lb("Unknown", "m-unknown", 0.9),
        ]);
        mockPrisma.artist.findMany.mockImplementation(async (args: any) => {
          const wanted: string[] = args?.where?.mbid?.in ?? [];
          return wanted.includes("m-owned") ? [{ id: "a-owned", mbid: "m-owned" }] : [];
        });
        mockPrisma.artist.findUnique.mockResolvedValue({ id: "a-seed" });
        // Identical centroids → distance 0 → full +0.1 boost.
        mockPrisma.$queryRaw.mockResolvedValue([
            { artistId: "a-seed", embedding: "[1,0]", trackCount: 5 },
            { artistId: "a-owned", embedding: "[1,0]", trackCount: 4 },
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 2);

        const owned = result.find((r) => r.mbid === "m-owned")!;
        expect(owned.match).toBeCloseTo(0.95, 5); // 0.85 + 0.1
        // The boosted artist floats above the untouched one.
        expect(result.map((r) => r.name)).toEqual(["Owned Close", "Unknown"]);
    });

    it("never moves any match score by more than 0.1", async () => {
        const original = new Map<string, number>();
        mockLb.getSimilarArtists.mockResolvedValue([
            lb("Owned Distant", "m-owned", 0.9),
            lb("Owned Close", "m-owned-2", 0.75),
            lb("Unknown", "m-unknown", 0.6),
        ]);
        for (const r of await mockLb.getSimilarArtists("x", "y", 3)) {
            original.set(r.name, r.match);
        }
        mockPrisma.artist.findMany.mockResolvedValue([
            { id: "a1", mbid: "m-owned" },
            { id: "a2", mbid: "m-owned-2" },
        ]);
        mockPrisma.artist.findUnique.mockResolvedValue({ id: "a-seed" });
        mockPrisma.$queryRaw.mockResolvedValue([
            { artistId: "a-seed", embedding: "[1,0]", trackCount: 5 },
            { artistId: "a1", embedding: "[-1,0]", trackCount: 4 },
            { artistId: "a2", embedding: "[1,0.0001]", trackCount: 3 },
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 3);
        for (const r of result) {
            const before = original.get(r.name)!;
            expect(Math.abs(r.match - before)).toBeLessThanOrEqual(0.1 + 1e-9);
        }
    });

    it("leaves scores untouched when the seed has no local centroid", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([lb("Owned", "m-owned", 0.9)]);
        mockPrisma.artist.findMany.mockImplementation(async (args: any) => {
          const wanted: string[] = args?.where?.mbid?.in ?? [];
          return wanted.includes("m-owned") ? [{ id: "a-owned", mbid: "m-owned" }] : [];
        });
        // Seed not in library → no distance to measure from.
        mockPrisma.artist.findUnique.mockResolvedValue(null);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 1);
        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBe(0.9);
    });
});

describe("getSimilarArtists — caching", () => {
    it("returns the cached list without touching any tier", async () => {
        const cached = [dz("Cached One", 0.9)];
        mockRedis.get.mockResolvedValue(JSON.stringify(cached));

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 3);

        expect(result).toEqual(cached);
        expect(mockLb.getSimilarArtists).not.toHaveBeenCalled();
        expect(mockDeezer.getRelatedArtists).not.toHaveBeenCalled();
    });

    it("stores the merged result for 7 days", async () => {
        mockLb.getSimilarArtists.mockResolvedValue([lb("LB One", "m-1", 0.9)]);

        await getSimilarArtists(SEED_MBID, "Seed Artist", 3);

        expect(mockRedis.setex).toHaveBeenCalledWith(
            `artist-similar:${SEED_MBID}:3`,
            604800,
            expect.any(String)
        );
    });
});