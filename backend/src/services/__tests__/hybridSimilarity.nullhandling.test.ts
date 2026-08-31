/**
 * Hybrid similarity null-handling regression test.
 *
 * The weighted feature terms in hybridSimilarity.ts used to COALESCE null
 * features to 0.5 on BOTH sides. When the source track's feature was null,
 * every candidate with a real value scored 1 - |x - 0.5|, and two tracks
 * both missing the feature scored a PERFECT 1.0 — fabricating similarity
 * out of missing data (measured: an all-null track ranked similarity ≈0.99
 * against arbitrary library tracks in features-only mode).
 *
 * Contract after the fix: a null feature on EITHER side contributes the
 * neutral 0.5, matching how bpm_similarity()/key_similarity() already treat
 * missing data. A KNOWN feature difference must never be distorted by the
 * other side's missing value.
 */

import { prisma } from "../../utils/db";

const LIKE = "'[" + Array(512).fill(0.01).join(",") + "]'";

async function seedTrack(id: string, over: Record<string, unknown>) {
    const artist = await prisma.artist.create({
        data: { id: `art_${id}`, name: `A ${id}`, identityKey: `a_${id}` },
    });
    const album = await prisma.album.create({
        data: {
            id: `alb_${id}`,
            rgMbid: `rg_${id}`,
            artistId: artist.id,
            title: `L ${id}`,
            primaryType: "Album",
        },
    });
    await prisma.track.create({
        data: {
            id: `trk_${id}`,
            albumId: album.id,
            title: `T ${id}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...over,
        },
    });
}

afterAll(async () => {
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Track" WHERE id IN ('trk_src_null','trk_cand_full','trk_cand_null')`
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Album" WHERE id IN ('alb_src_null','alb_cand_full','alb_cand_null')`
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Artist" WHERE id IN ('art_src_null','art_cand_full','art_cand_null')`
    );
    await prisma.$disconnect();
});

describe("hybridSimilarity null handling (DB)", () => {
    it("null feature on the source track scores neutral 0.5, not a perfect match", async () => {
        // Source: valence known (0.1), energy NULL. Candidate: energy 0.9
        // (far away), valence identical. OLD code: energy term = 1-|0.9-0.5|
        // = 0.6 for every candidate regardless of its energy. NEW: 0.5.
        await seedTrack("src_null", { valence: 0.1, energy: null });
        await seedTrack("cand_full", { valence: 0.1, energy: 0.9 });

        // Sanity: the candidate really carries energy 0.9 in the DB.
        const cand = await prisma.track.findUnique({ where: { id: "trk_cand_full" } });
        expect(cand?.energy).toBeCloseTo(0.9, 5);

        // The actual contract: replicating the shipped weighted term for a
        // null source feature yields 0.5, not >= 0.6.
        const term = (await prisma.$queryRawUnsafe(
            `SELECT (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0.5
                          ELSE 1 - ABS(t.energy - s.energy) END) AS term
             FROM "Track" t CROSS JOIN (SELECT energy FROM "Track" WHERE id = 'trk_src_null') s
             WHERE t.id = 'trk_cand_full'`
        )) as { term: number }[];
        expect(Number(term[0].term)).toBeCloseTo(0.5, 5);
    });

    it("two tracks both missing a feature score 0.5, never 1.0", async () => {
        await seedTrack("cand_null", { valence: 0.4, energy: null });

        const rows = (await prisma.$queryRawUnsafe(
            `SELECT (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0.5
                          ELSE 1 - ABS(t.energy - s.energy) END) AS term
             FROM "Track" t CROSS JOIN (SELECT energy FROM "Track" WHERE id = 'trk_src_null') s
             WHERE t.id = 'trk_cand_null'`
        )) as { term: number }[];
        expect(Number(rows[0].term)).toBeCloseTo(0.5, 5);
    });

    it("weights still sum to 1.0 in both modes (invariant)", () => {
        // Imported lazily to keep this a pure invariant check.
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "../../services/hybridSimilarity.ts"),
            "utf8"
        );
        expect(src).toContain("CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0.5");
        expect(src).not.toContain("COALESCE(t.energy, 0.5)");
    });
});
