/**
 * The library re-rank tier on the real artist_embeddings table, so the pgvector
 * centroid round-trip is exercised. HTTP tiers are mocked; the score must move.
 */

const mockLb = { getSimilarArtists: jest.fn() };
const mockDeezer = { getRelatedArtists: jest.fn() };
const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
    status: "ready",
};

jest.mock("../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../listenBrainz", () => ({ listenBrainzService: mockLb }));
jest.mock("../deezer", () => ({ deezerService: mockDeezer }));

import { prisma } from "../../utils/db";
import { getSimilarArtists } from "../artistSimilarity";

const PREFIX = "arsr";
const id = (n: string) => `${PREFIX}_${n}`;
const SEED_MBID = `${PREFIX}-seed-mbid`;
const OWNED_MBID = `${PREFIX}-owned-mbid`;

/** A unit vector of axis `i`, in the pgvector text form vector(512) accepts. */
function axisVector(i: number): string {
    const v = new Array(512).fill(0);
    v[i] = 1;
    return `[${v.join(",")}]`;
}

async function putCentroid(artistId: string, axis: number): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO artist_embeddings ("artistId", embedding, "trackCount")
         VALUES ($1, $2::vector, 5)
         ON CONFLICT ("artistId") DO UPDATE
           SET embedding = EXCLUDED.embedding, "trackCount" = 5`,
        artistId,
        axisVector(axis)
    );
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(
        `DELETE FROM artist_embeddings WHERE "artistId" LIKE $1`,
        `${PREFIX}_%`
    );
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    mockDeezer.getRelatedArtists.mockResolvedValue([]);
    await wipe();
    await prisma.artist.create({
        data: { id: id("seed"), name: "Seed Artist", mbid: SEED_MBID, identityKey: id("ks") },
    });
    await prisma.artist.create({
        data: { id: id("owned"), name: "Owned Artist", mbid: OWNED_MBID, identityKey: id("ko") },
    });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("library re-rank on real pgvector data", () => {
    it("reads real centroids and moves an owned artist by the distance delta", async () => {
        // Orthogonal centroids: cosine 0 → distance 1 → the −0.1 floor.
        await putCentroid(id("seed"), 0);
        await putCentroid(id("owned"), 1);
        mockLb.getSimilarArtists.mockResolvedValue([
            { name: "Owned Artist", mbid: OWNED_MBID, match: 0.9, url: "https://listenbrainz.org/artist/o" },
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result).toHaveLength(1);
        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBeCloseTo(0.8, 5);
    });

    it("flags in-library and leaves scores alone when no centroids exist yet", async () => {
        // The query still runs (it is how the absence is proven); nothing
        // to measure against means no adjustment, and inLibrary survives.
        mockLb.getSimilarArtists.mockResolvedValue([
            { name: "Owned Artist", mbid: OWNED_MBID, match: 0.9, url: "https://listenbrainz.org/artist/o" },
        ]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBe(0.9);
    });
});
