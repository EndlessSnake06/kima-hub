/**
 * The library re-rank on real data: artists' tracks go through the similarity step,
 * and an owned artist's score moves by how close its tracks are to the seed's on the
 * matching formula. HTTP tiers are mocked.
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
import { MATCHING_MODEL, buildMatching } from "../matching/state";

const PREFIX = "arsr";
const id = (n: string) => `${PREFIX}_${n}`;
const SEED_MBID = `${PREFIX}-seed-mbid`;
const OWNED_MBID = `${PREFIX}-owned-mbid`;
const OWNED = [{ name: "Owned Artist", mbid: OWNED_MBID, match: 0.85, url: "https://listenbrainz.org/artist/o" }];

/** A unit vector on `axis`, in the text form pgvector accepts. */
function axisVector(axis: number): string {
    const v = new Array(512).fill(0);
    v[axis] = 1;
    return `[${v.join(",")}]`;
}

/** Three tracks for `artist`, each with the sound vector on `axes[i]`. */
async function giveTracks(artist: string, axes: number[]): Promise<void> {
    const album = await prisma.album.create({
        data: { id: id(`alb_${artist}`), rgMbid: id(`rg_${artist}`), artistId: id(artist), title: `${artist} album`, primaryType: "Album" },
    });
    for (const [n, axis] of axes.entries()) {
        const trackId = id(`trk_${artist}_${n}`);
        await prisma.track.create({
            data: {
                id: trackId,
                albumId: album.id,
                title: `${artist} ${n}`,
                trackNo: n + 1,
                duration: 200,
                filePath: `/tmp/${trackId}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version) VALUES ($1, $2::vector, $3)`,
            trackId,
            axisVector(axis),
            MATCHING_MODEL,
        );
    }
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    mockDeezer.getRelatedArtists.mockResolvedValue([]);
    mockLb.getSimilarArtists.mockResolvedValue(OWNED);
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

describe("library re-rank on the matching formula", () => {
    it("lifts an owned artist whose tracks sound like the seed's by the full 0.1", async () => {
        await giveTracks("seed", [3, 4, 5]);
        await giveTracks("owned", [3, 4, 5]);
        await buildMatching();

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBeCloseTo(0.95, 5);
    });

    it("lowers an owned artist whose tracks sound nothing like the seed's", async () => {
        await giveTracks("seed", [3, 4, 5]);
        await giveTracks("owned", [6, 7, 8]);
        await buildMatching();

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBeLessThan(0.85 - 0.06);
        expect(result[0].match).toBeGreaterThanOrEqual(0.75 - 1e-9);
    });

    it("flags in-library and leaves scores alone before the similarity step has run", async () => {
        await giveTracks("seed", [3, 4, 5]);
        await giveTracks("owned", [3, 4, 5]);

        const result = await getSimilarArtists(SEED_MBID, "Seed Artist", 5);

        expect(result[0].inLibrary).toBe(true);
        expect(result[0].match).toBe(0.85);
    });
});
