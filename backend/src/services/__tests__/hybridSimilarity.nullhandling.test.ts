/**
 * Hybrid similarity null-handling regression test.
 *
 * Contract after the F4 fix (weighted-mean normalization over PRESENT features):
 * a null feature on EITHER side contributes 0 to the numerator AND drops its
 * weight from the denominator, so the score divides by the sum of present
 * weights rather than the full 1.0. This removes the old 0.5-at-full-weight
 * burial that capped under-analyzed tracks below a fully-analyzed one.
 *
 * Concretely: a candidate missing 3 of 8 features but matching the source on
 * everything present (and on CLAP) now scores 1.0, not the old 0.865 ceiling.
 * When NO feature is present the denominator is 0; hybrid mode falls back to the
 * CLAP term alone, features-only mode returns the neutral 0.5.
 *
 * F5: the features-only path no longer emits a fabricated constant-0 distance;
 * it emits (1 - similarity).
 *
 * These tests drive the SHIPPED functions (findSimilarTracks and its mode
 * selection), not a re-typed copy of the SQL -- a mirror can drift from the
 * real query and prove nothing. featureDetection is mocked to pin the mode;
 * track_embeddings rows are seeded via raw SQL because Prisma cannot write
 * Unsupported("vector") columns.
 */

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import {
    findSimilarTracks,
    WEIGHTS,
    FEATURES_ONLY_WEIGHTS,
    SimilarTrack,
} from "../hybridSimilarity";

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

// A normalized non-zero 512-dim vector (all components equal). Identical
// vectors across tracks => pgvector cosine distance ~0 => clap_sim ~1, so the
// CLAP term never confounds the feature-math under test.
const IDENTITY_VECTOR = `[${Array(512).fill(1 / Math.sqrt(512)).join(",")}]`;

async function seedEmbedding(trackId: string) {
    // Mirrors services/audio-analyzer-clap/analyzer.py's insert shape
    // (%s::vector). Prisma cannot write Unsupported("vector") columns.
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, 'laion-clap-music', now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        IDENTITY_VECTOR,
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

// pgvector norms are float32, so identical-vector distances carry ~1e-6 noise;
// the perfect-match assertions use 5-decimal closeness for that reason. Pure
// SQL float arithmetic (features-only) is exact and keeps 6.

describe("hybridSimilarity null handling (DB, shipped functions)", () => {
    beforeAll(() => {
        mockGetFeatures.mockResolvedValue({
            musicCNN: true,
            vibeEmbeddings: true,
            audiobookshelfEnabled: false,
        });
    });

    it("hybrid: a candidate missing 3 features but matching on everything present scores ~1.0 and outranks the old 0.865 ceiling", async () => {
        setMode("hybrid");
        const full = {
            energy: 0.5, valence: 0.5, arousal: 0.5, bpm: 120,
            danceabilityMl: 0.5, acousticness: 0.5, instrumentalness: 0.5,
            key: "C", keyScale: "major",
        };
        // Source: all features present. Candidate: 3 nulls, matches source on the rest.
        await seedTrack("src", { ...full });
        await seedTrack("sparse", {
            energy: null, valence: null, arousal: null,
            bpm: 120, danceabilityMl: 0.5, acousticness: 0.5, instrumentalness: 0.5,
            key: "C", keyScale: "major",
        });
        await seedEmbedding("trk_hs_src");
        await seedEmbedding("trk_hs_sparse");

        const rows = await findSimilarTracks("trk_hs_src", 10);
        const sparse = rows.find((r) => r.id === "trk_hs_sparse");
        expect(sparse).toBeDefined();

        // Analytic expectation: every PRESENT feature matches and clap_sim ~1,
        // so the weighted mean is ~1.0 -- the sparse candidate competes on
        // equal footing with a fully-analyzed one.
        expect(sparse!.similarity).toBeCloseTo(1.0, 5);

        // For reference, the OLD code would have scored this candidate
        // 0.55*1 + (0.07+0.05+0.03+0.02+0.01)*1 + (0.10+0.09+0.08)*0.5 = 0.865.
        const oldCeiling =
            WEIGHTS.clap * 1 +
            (WEIGHTS.features.bpm + WEIGHTS.features.danceability +
                WEIGHTS.features.acousticness + WEIGHTS.features.instrumentalness +
                WEIGHTS.features.key) * 1 +
            (WEIGHTS.features.energy + WEIGHTS.features.valence +
                WEIGHTS.features.arousal) * 0.5;
        expect(sparse!.similarity).toBeGreaterThan(oldCeiling);

        // F5 sanity: hybrid mode's distance is a real pgvector cosine distance
        // (identical vectors => ~0), never a fabricated constant.
        expect(Number.isFinite(sparse!.distance)).toBe(true);
        expect(sparse!.distance).toBeCloseTo(0.0, 5);
    });

    it("hybrid: a null feature on the SOURCE drops out entirely; matching candidate still scores ~1.0", async () => {
        setMode("hybrid");
        // Source: energy NULL. Candidate: energy 0.9 (far), everything else identical.
        await seedTrack("src_null", { energy: null, valence: 0.1, arousal: 0.1, bpm: 120, danceabilityMl: 0.1, acousticness: 0.1, instrumentalness: 0.1, key: "C", keyScale: "major" });
        await seedTrack("cand_full", { energy: 0.9, valence: 0.1, arousal: 0.1, bpm: 120, danceabilityMl: 0.1, acousticness: 0.1, instrumentalness: 0.1, key: "C", keyScale: "major" });
        await seedEmbedding("trk_hs_src_null");
        await seedEmbedding("trk_hs_cand_full");

        // Sanity: the candidate really carries energy 0.9 in the DB.
        const cand = await prisma.track.findUnique({ where: { id: "trk_hs_cand_full" } });
        expect(cand?.energy).toBeCloseTo(0.9, 5);

        const rows = await findSimilarTracks("trk_hs_src_null", 10);
        const row = rows.find((r) => r.id === "trk_hs_cand_full");
        expect(row).toBeDefined();
        // The null source energy drops out of numerator AND denominator; the
        // candidate matches on every present feature, so it scores ~1.0 (not a
        // fabricated perfect match from the missing value, and not penalized
        // for the source's missing value).
        expect(row!.similarity).toBeCloseTo(1.0, 5);
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

    it("weights still sum to 1.0 in both modes, and the source carries no neutral-0.5 or constant-0 distance pattern (invariant)", () => {
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

        const featureWeightSum = Object.values(WEIGHTS.features).reduce((a, b) => a + b, 0);
        const featuresOnlySum = Object.values(FEATURES_ONLY_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(WEIGHTS.clap + featureWeightSum).toBeCloseTo(1.0, 6);
        expect(featuresOnlySum).toBeCloseTo(1.0, 6);
    });
});
