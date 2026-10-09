/**
 * With CLAP embeddings, similar tracks rank on the matching formula, which the
 * audio feature columns do not enter. Without them, missing features drop out of
 * the weighted mean (0.5 when none are present) and distance is 1 - similarity. A
 * seed with no embedding returns no rows.
 */

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import {
    findSimilarTracks,
    FEATURES_ONLY_WEIGHTS,
    SimilarTrack,
} from "../hybridSimilarity";
import { MATCHING_MODEL, buildMatching } from "../matching/state";

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn() },
}));

const mockGetFeatures = featureDetection.getFeatures as unknown as jest.Mock;

function setMode(mode: "hybrid" | "featuresOnly") {
    mockGetFeatures.mockResolvedValue({
        musicCNN: mode === "hybrid" || mode === "featuresOnly",
        vibeEmbeddings: mode === "hybrid",
        audiobookshelfEnabled: false,
    });
}

async function seedTrack(id: string, over: Record<string, unknown>) {
    const artist = await prisma.artist.create({
        data: { id: `art_hs_${id}`, name: `A ${id}`, identityKey: `a_hs_${id}` },
    });
    const album = await prisma.album.create({
        data: {
            id: `alb_hs_${id}`,
            rgMbid: `rg_hs_${id}`,
            artistId: artist.id,
            title: `L ${id}`,
            primaryType: "Album",
        },
    });
    await prisma.track.create({
        data: {
            id: `trk_hs_${id}`,
            albumId: album.id,
            title: `T ${id}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/hs_${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...over,
        },
    });
}

// A unit 512-dim vector whose cosine with the axis-0 unit vector is `cos`:
// cos on axis 0, the remainder on `axis`, so each track's fingerprint
// similarity to an axis-0 source is exactly `cos`.
function unitVectorAt(cos: number, axis: number): string {
    const v = Array(512).fill(0);
    v[0] = cos;
    v[axis] = Math.sqrt(1 - cos * cos);
    return `[${v.join(",")}]`;
}

async function seedEmbedding(trackId: string, vector: string) {
    // Mirrors services/audio-analyzer-clap/analyzer.py's insert shape
    // (%s::vector). Prisma cannot write Unsupported("vector") columns.
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        vector,
        MATCHING_MODEL,
    );
}

afterAll(async () => {
    // Prefix-scoped cleanup, children first. The trk_/alb_/art_ prefixes are
    // shared with other suites, so anchor on the hs_ middle segment; the
    // underscore is escaped because LIKE treats bare _ as a wildcard.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_hs\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_hs\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, "art\\_hs\\_%");
    await prisma.$disconnect();
});

// pgvector computes in float32, so CLAP-mode scores carry ~1e-6 noise and those
// assertions use 5-decimal closeness. Features-only SQL arithmetic keeps 6.

describe("hybridSimilarity null handling (DB, shipped functions)", () => {
    beforeAll(() => {
        mockGetFeatures.mockResolvedValue({
            musicCNN: true,
            vibeEmbeddings: true,
            audiobookshelfEnabled: false,
        });
    });

    it("CLAP present: the audio feature columns do not move the ranking", async () => {
        setMode("hybrid");
        const src = {
            energy: 0.0, valence: 0.0, arousal: 0.0, bpm: 60,
            danceabilityMl: 0.0, acousticness: 0.0, instrumentalness: 0.0,
            key: "C", keyScale: "major",
        };
        const opposite = {
            energy: 1.0, valence: 1.0, arousal: 1.0, bpm: 97,
            danceabilityMl: 1.0, acousticness: 1.0, instrumentalness: 1.0,
            key: "F#", keyScale: "minor",
        };
        await seedTrack("fp_src", src);
        await seedTrack("fp_near", opposite);
        await seedTrack("fp_far", { ...src });
        await seedEmbedding("trk_hs_fp_src", unitVectorAt(1, 1));
        await seedEmbedding("trk_hs_fp_near", unitVectorAt(0.95, 2));
        await seedEmbedding("trk_hs_fp_far", unitVectorAt(0.9, 3));
        await buildMatching();

        const before = await findSimilarTracks("trk_hs_fp_src", 10);
        expect(before.map((r) => r.id)).toEqual(expect.arrayContaining(["trk_hs_fp_near", "trk_hs_fp_far"]));
        for (const r of before) {
            expect(r.distance).toBeCloseTo(1 - r.similarity, 5);
        }

        // Swap the two candidates' audio features: nothing the formula reads changes.
        await prisma.track.update({ where: { id: "trk_hs_fp_near" }, data: { ...src } });
        await prisma.track.update({ where: { id: "trk_hs_fp_far" }, data: { ...opposite } });
        expect(await findSimilarTracks("trk_hs_fp_src", 10)).toEqual(before);
    });

    it("features-only: all features null on both sides returns neutral 0.5, not a divide-by-zero", async () => {
        setMode("featuresOnly");
        await seedTrack("src_all", { energy: null, valence: null, arousal: null, bpm: null, danceabilityMl: null, acousticness: null, instrumentalness: null, key: null, keyScale: null });
        await seedTrack("cand_all", { energy: null, valence: null, arousal: null, bpm: null, danceabilityMl: null, acousticness: null, instrumentalness: null, key: null, keyScale: null });

        const rows = await findSimilarTracks("trk_hs_src_all", 10);
        const row = rows.find((r) => r.id === "trk_hs_cand_all");
        expect(row).toBeDefined();
        expect(row!.similarity).toBeCloseTo(0.5, 6);
    });

    it("features-only: a sparse candidate matching on present features scores ~1.0", async () => {
        setMode("featuresOnly");
        const full = {
            energy: 0.4, valence: 0.4, arousal: 0.4, bpm: 100,
            danceabilityMl: 0.4, acousticness: 0.4, instrumentalness: 0.4,
            key: "G", keyScale: "major",
        };
        await seedTrack("src_sp", { ...full });
        await seedTrack("cand_sp", {
            energy: null, valence: null,
            arousal: 0.4, bpm: 100, danceabilityMl: 0.4, acousticness: 0.4,
            instrumentalness: 0.4, key: "G", keyScale: "major",
        });

        const rows = await findSimilarTracks("trk_hs_src_sp", 10);
        const row = rows.find((r) => r.id === "trk_hs_cand_sp");
        expect(row).toBeDefined();
        // Present-feature mean: arousal(0.178) + bpm(0.156) + danceabilityMl
        // (0.111) + acousticness(0.067) + instrumentalness(0.044) + key(0.022)
        // all match perfectly => ~1.0 despite 2 of 8 features null.
        expect(row!.similarity).toBeCloseTo(1.0, 6);
    });

    it("features-only: distance is the real complement of similarity and rankings stay stable (F5)", async () => {
        setMode("featuresOnly");
        const full = {
            energy: 0.5, valence: 0.5, arousal: 0.5, bpm: 120,
            danceabilityMl: 0.5, acousticness: 0.5, instrumentalness: 0.5,
            key: "C", keyScale: "major",
        };
        await seedTrack("rk_src", { ...full });
        await seedTrack("rk_full", { ...full }); // matches everything
        await seedTrack("rk_far", {
            energy: 0.0, valence: 0.0, arousal: 0.0, bpm: 138,
            danceabilityMl: 0.0, acousticness: 0.0, instrumentalness: 0.0,
            key: "B", keyScale: "minor",
        });

        const rows: SimilarTrack[] = await findSimilarTracks("trk_hs_rk_src", 10);
        const byFull = rows.find((r) => r.id === "trk_hs_rk_full");
        const byFar = rows.find((r) => r.id === "trk_hs_rk_far");
        expect(byFull).toBeDefined();
        expect(byFar).toBeDefined();

        // Ranking: the perfect match sorts above the far track.
        expect(byFull!.similarity).toBeGreaterThan(byFar!.similarity);
        const idxFull = rows.indexOf(byFull!);
        const idxFar = rows.indexOf(byFar!);
        expect(idxFull).toBeLessThan(idxFar);

        // F5: distance is (1 - similarity) here -- a real, finite complement,
        // not the old constant 0 for every row.
        for (const r of [byFull!, byFar!]) {
            expect(Number.isFinite(r.distance)).toBe(true);
            expect(r.distance).toBeCloseTo(1 - r.similarity, 6);
        }
        expect(byFar!.distance).toBeGreaterThan(0.1); // far track has real distance
    });

    it("features-only weights sum to 1.0, and the source carries no neutral-0.5 or constant-0 distance pattern (invariant)", () => {
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "../../services/hybridSimilarity.ts"),
            "utf8",
        );
        // The old neutral-0.5-at-full-weight pattern is gone; nulls now contribute 0.
        expect(src).not.toContain("THEN 0.5 ELSE 1 - ABS");
        expect(src).not.toContain("THEN 0.5 ELSE bpm_similarity");
        expect(src).not.toContain("THEN 0.5 ELSE key_similarity");
        // The weighted-mean denominator (divide by sum of present weights) is present.
        expect(src).toContain("ELSE 1 END)");
        // No COALESCE-based neutralization.
        expect(src).not.toContain("COALESCE(t.energy, 0.5)");
        // F5: no hardcoded constant-0 distance anywhere in the file.
        expect(src).not.toContain("0 as distance");

        const featuresOnlySum = Object.values(FEATURES_ONLY_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(featuresOnlySum).toBeCloseTo(1.0, 6);
    });
});

// A seed with no embedding row returns [], which the routes turn into their
// "not analysed yet" 404.
describe("unanalysed seed (no embedding row) returns no rows", () => {
    it("CLAP mode: a seed track with no embedding row returns []", async () => {
        setMode("hybrid");
        // One embedded neighbour shows the empty result comes from the seed's missing
        // embedding, not from an empty library.
        await seedTrack("un_src", {});
        await seedTrack("un_nb", {});
        await seedEmbedding("trk_hs_un_nb", unitVectorAt(1, 1));
        await buildMatching();

        const rows = await findSimilarTracks("trk_hs_un_src", 10);
        expect(rows).toEqual([]);
    });

    it("CLAP mode: a nonexistent track id returns []", async () => {
        setMode("hybrid");
        await seedTrack("un_nb2", {});
        await seedEmbedding("trk_hs_un_nb2", unitVectorAt(1, 1));
        await buildMatching();

        const rows = await findSimilarTracks("ctrk_hs_does_not_exist", 10);
        expect(rows).toEqual([]);
    });
});
