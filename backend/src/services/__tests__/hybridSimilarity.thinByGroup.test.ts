/**
 * thinByGroup is the in-process half of the S3 caps: it walks the ranked rows
 * and charges the SEED against its own album and artist. The SQL half caps each
 * group over the ranking but cannot know about the seed, so without the artist
 * check here a seed's artist could still fill four slots (the seed plus four).
 */

jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../featureDetection", () => ({ featureDetection: { getFeatures: jest.fn() } }));

import { thinByGroup, MAX_PER_ALBUM, MAX_PER_ARTIST, SimilarTrack } from "../hybridSimilarity";

const row = (id: string, albumId: string, artistId: string): SimilarTrack => ({
    id, title: id, duration: 200, distance: 0.1, similarity: 0.9,
    albumId, albumTitle: albumId, albumCoverUrl: null, artistId, artistName: artistId,
});

describe("thinByGroup", () => {
    it("charges the seed against its own artist: at most MAX_PER_ARTIST - 1 more", () => {
        // Five tracks by the seed's artist, each on its own album so only the
        // artist budget can stop them.
        const ranked = [1, 2, 3, 4, 5].map((i) => row(`t${i}`, `alb${i}`, "seedArtist"));
        const out = thinByGroup(ranked, { albumId: "seedAlbum", artistId: "seedArtist" }, 20);
        expect(out).toHaveLength(MAX_PER_ARTIST - 1);
    });

    it("charges the seed against its own album: at most MAX_PER_ALBUM - 1 more", () => {
        const ranked = [1, 2, 3].map((i) => row(`t${i}`, "seedAlbum", `art${i}`));
        const out = thinByGroup(ranked, { albumId: "seedAlbum", artistId: "seedArtist" }, 20);
        expect(out).toHaveLength(MAX_PER_ALBUM - 1);
    });

    it("keeps rank order and stops at the limit", () => {
        const ranked = [1, 2, 3, 4, 5, 6].map((i) => row(`t${i}`, `alb${i}`, `art${i}`));
        const out = thinByGroup(ranked, {}, 4);
        expect(out.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4"]);
    });
});
