/**
 * S3 — "more like this" must not be dominated by one album or one artist.
 *
 * The shipped ranking ordered purely by sound, so a seed taken from a big
 * album (or from an artist with several similar albums) answered with 20
 * tracks from the same album / nearly all from the same artist: over 20 real
 * seeds at L=20 the lists were 20.3% the seed's own album and 49.2% the
 * seed's own artist (fixplan-work/S3.md).
 *
 * The contract asserted here:
 *  - at most 2 tracks per album and at most 4 per artist in the RETURNED
 *    list, for every album/artist including the seed's own — the seed counts
 *    against its own album and artist, so at most 1 further track from the
 *    seed's album and 3 more from its artist;
 *  - the list still reaches the requested length when the library has enough
 *    material (the whole-library ranking must not starve the tail);
 *  - the same rules in the features-only fallback used when CLAP is absent.
 *
 * Every assertion is provable from the fixture geometry rather than from a
 * probabilistic guess: the seed's own album/artist are seeded as strictly the
 * closest vectors (cos 1.0 / 0.95) and everything else strictly further
 * (cos 0.80), so an uncapped ranking MUST be flooded by them, and a capped
 * ranking cannot hide behind ties.
 *
 * These drive the SHIPPED findSimilarTracks (and its mode selection), not a
 * re-typed copy of the SQL. featureDetection is mocked to pin the mode;
 * track_embeddings rows are seeded via raw SQL because Prisma cannot write
 * Unsupported("vector") columns.
 */

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import { findSimilarTracks } from "../hybridSimilarity";

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn() },
}));

// The service logs a debug line per call; keep the run output quiet.
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockGetFeatures = featureDetection.getFeatures as unknown as jest.Mock;

function setMode(mode: "hybrid" | "featuresOnly") {
    mockGetFeatures.mockResolvedValue({
        musicCNN: true,
        vibeEmbeddings: mode === "hybrid",
        audiobookshelfEnabled: false,
    });
}

/**
 * A unit 512-dim vector whose cosine with the axis-0 unit vector is exactly
 * `cos`: `cos` on axis 0, the remainder on `axis`. Seeding this way keeps the
 * ranking deterministic — no LCG noise, no tie groups between the seed's
 * group and the scattered material — so "the seed's album floods the list"
 * is a fact about the fixture, not about the planner.
 */
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
         VALUES ($1, $2::vector, 'laion-clap-music', now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        vector,
    );
}

async function seedArtist(id: string) {
    await prisma.artist.create({
        data: { id: `art_cap_${id}`, name: `A ${id}`, identityKey: `a_cap_${id}` },
    });
}

async function seedAlbum(id: string, artistId: string, title: string) {
    await prisma.album.create({
        data: {
            id: `alb_cap_${id}`,
            rgMbid: `rg_cap_${id}`,
            artistId: `art_cap_${artistId}`,
            title,
            // Album has @@unique([artistId, identityKey]) with identityKey
            // defaulting to "", so a second album for one artist needs a
            // distinct key.
            identityKey: `i_cap_${id}`,
            primaryType: "Album",
        },
    });
}

/** @returns the created track's id. */
async function seedTrack(
    id: string,
    albumId: string,
    trackNo: number,
    over: Record<string, unknown> = {},
) {
    await prisma.track.create({
        data: {
            id: `trk_cap_${id}`,
            albumId: `alb_cap_${albumId}`,
            title: `T ${id} #${trackNo}`,
            trackNo,
            duration: 180,
            filePath: `/tmp/cap_${id}_${trackNo}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...over,
        },
    });
    return `trk_cap_${id}`;
}

/**
 * Seed `seedTrackId` inside `seedAlbumId`, plus `scatteredAlbums` further
 * albums (2 tracks each) spread over `scatteredArtists` other artists.
 * All ids are prefixed with `cfg.prefix` so the fixtures of two tests in
 * this file cannot collide.
 */
async function seedCrowdedLibrary(cfg: {
    prefix: string;
    seedAlbumId: string;
    seedArtistId: string;
    seedAlbumTracks: number;
    /** Extra albums belonging to the SEED's artist (id, trackCount). */
    seedArtistExtraAlbums?: Array<{ id: string; tracks: number }>;
    scatteredAlbums: number;
    scatteredArtists: number;
    /** Feature profile for the seed's own group vs everything else. */
    seedFeatures: Record<string, unknown>;
    otherFeatures: Record<string, unknown>;
}) {
    await seedArtist(cfg.seedArtistId);
    for (let i = 0; i < cfg.scatteredArtists; i += 1) {
        await seedArtist(`${cfg.prefix}_other${i}`);
    }

    await seedAlbum(cfg.seedAlbumId, cfg.seedArtistId, `Seed album ${cfg.prefix}`);
    for (let i = 0; i < cfg.seedAlbumTracks; i += 1) {
        await seedTrack(`${cfg.prefix}_sa${i}`, cfg.seedAlbumId, i + 1, cfg.seedFeatures);
    }
    for (const extra of cfg.seedArtistExtraAlbums ?? []) {
        await seedAlbum(`${cfg.prefix}_${extra.id}`, cfg.seedArtistId, `Seed-artist album ${extra.id}`);
        for (let i = 0; i < extra.tracks; i += 1) {
            await seedTrack(
                `${cfg.prefix}_${extra.id}_${i}`,
                `${cfg.prefix}_${extra.id}`,
                i + 1,
                cfg.seedFeatures,
            );
        }
    }
    for (let a = 0; a < cfg.scatteredAlbums; a += 1) {
        const artist = `${cfg.prefix}_other${a % cfg.scatteredArtists}`;
        await seedAlbum(`${cfg.prefix}_scat${a}`, artist, `Scattered album ${a}`);
        for (let i = 0; i < 2; i += 1) {
            await seedTrack(
                `${cfg.prefix}_scat${a}_${i}`,
                `${cfg.prefix}_scat${a}`,
                i + 1,
                cfg.otherFeatures,
            );
        }
    }
}

function countsBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const k = key(row);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
}

/** Highest per-group count in `counts` (0 when empty) — the crowding measure. */
function maxCount(counts: Map<string, number>): number {
    return Math.max(...Array.from(counts.values()));
}

beforeEach(async () => {
    // Each test seeds its own fixture and asserts exact counts, so clear any
    // leftover rows first — including ones a previous TEST in this file
    // created (the worker database persists across runs, and a stale
    // album/artist would change the ranking geometry being asserted).
    // Children first: track_embeddings cascades with its Track, but rows
    // orphaned by an earlier crash would otherwise linger.
    await prisma.$executeRawUnsafe(
        `DELETE FROM "track_embeddings" WHERE "track_id" LIKE $1`,
        "trk\\_cap\\_%",
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `art\\_cap\\_%`);
});

afterAll(async () => {
    await prisma.$executeRawUnsafe(
        `DELETE FROM "track_embeddings" WHERE "track_id" LIKE $1`,
        "trk\\_cap\\_%",
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `art\\_cap\\_%`);
    await prisma.$disconnect();
});

describe("hybridSimilarity diversification (DB, shipped functions)", () => {
    // ------------------------------------------------------------------
    // Test 1 — flooding: one big album + scattered tracks. Red on the
    // current code, which returns 20 tracks all from the seed's album.
    // ------------------------------------------------------------------
    it("caps the seed's album at 2 (seed counted => at most 1 more) and still fills 20", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "flood",
            seedArtistId: "floodArtist",
            seedAlbumId: "floodBig",
            seedAlbumTracks: 12,
            scatteredAlbums: 12,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });

        const seed = "trk_cap_flood_sa0";
        // Seed + its 11 album-mates are the closest things in the library.
        for (let i = 0; i < 12; i += 1) {
            await seedEmbedding(`trk_cap_flood_sa${i}`, unitVectorAt(1, 1));
        }
        // 24 scattered tracks, each on its own axis at cos 0.80 from the seed.
        for (let a = 0; a < 12; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_flood_scat${a}_${i}`, unitVectorAt(0.8, 2 + a));
            }
        }

        const rows = await findSimilarTracks(seed, 20);

        // Full requested length is still reachable: 2 (seed's album, capped)
        // + 24 scattered, so 20 is well inside what the library allows.
        expect(rows).toHaveLength(20);
        expect(rows.map((r) => r.id)).not.toContain(seed);

        // At most 2 per album for EVERY album in the list…
        const albumCounts = countsBy(rows, (r) => r.albumId);
        expect(maxCount(albumCounts)).toBeLessThanOrEqual(2);
        // …and at most 4 per artist, for every artist including the seed's.
        const artistCounts = countsBy(rows, (r) => r.artistId);
        expect(maxCount(artistCounts)).toBeLessThanOrEqual(4);

        // The seed counts against its OWN album and artist: its album has 12
        // other tracks and its artist has nothing else, so the uncapped
        // ranking (20 from that album) fails both of these. Only 2 of that
        // album survive the album cap, and the seed takes one of those two
        // slots, so exactly 1 remains.
        expect(rows.filter((r) => r.albumId === "alb_cap_floodBig")).toHaveLength(1);
        expect(rows.filter((r) => r.artistId === "art_cap_floodArtist")).toHaveLength(1);

        // The list is not a stub: it reaches well past the seed's album.
        expect(new Set(rows.map((r) => r.albumId)).size).toBeGreaterThanOrEqual(11);
        expect(new Set(rows.map((r) => r.artistId)).size).toBeGreaterThanOrEqual(10);
    });

    // ------------------------------------------------------------------
    // Test 2 — single-artist library: the artist cap is a hard ceiling,
    // so the list legitimately comes back short. Red on current code.
    // ------------------------------------------------------------------
    it("returns at most 4 rows for a one-artist library (seed counted => 3)", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "solo",
            seedArtistId: "soloArtist",
            seedAlbumId: "soloBig",
            seedAlbumTracks: 10,
            seedArtistExtraAlbums: [{ id: "soloSecond", tracks: 6 }],
            scatteredAlbums: 0,
            scatteredArtists: 1,
            seedFeatures: {},
            otherFeatures: {},
        });
        for (let i = 0; i < 10; i += 1) {
            await seedEmbedding(`trk_cap_solo_sa${i}`, unitVectorAt(1, 1));
        }
        for (let i = 0; i < 6; i += 1) {
            await seedEmbedding(`trk_cap_solo_soloSecond_${i}`, unitVectorAt(0.95, 2));
        }

        const rows = await findSimilarTracks("trk_cap_solo_sa0", 10);

        // 15 candidates exist, but only 4 may come from one artist — and
        // the seed already occupies one of those 4, so 3 is the ceiling.
        expect(rows).toHaveLength(3);
        expect(rows.filter((r) => r.albumId === "alb_cap_soloBig")).toHaveLength(1);
        expect(rows.filter((r) => r.albumId === "alb_cap_solo_soloSecond")).toHaveLength(2);
    });

    // ------------------------------------------------------------------
    // Test 3 — the artist cap must be counted over the ALBUM-THINNED
    // survivors, otherwise "at most 4 per artist" quietly becomes "fewer
    // when an album was thinned". Red on the independent-window SQL too.
    // ------------------------------------------------------------------
    it("gives the seed's artist exactly 3 tracks across 4 of its albums (4 including the seed)", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "exact",
            seedArtistId: "exactArtist",
            seedAlbumId: "exactNear",
            seedAlbumTracks: 10,
            seedArtistExtraAlbums: [
                { id: "exactFar1", tracks: 4 },
                { id: "exactFar2", tracks: 4 },
                { id: "exactFar3", tracks: 4 },
            ],
            scatteredAlbums: 12,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });
        // Seed's nearest album (10 tracks) plus three further albums by the
        // same artist: 12 seed-artist candidates, then scattered material.
        for (let i = 0; i < 10; i += 1) {
            await seedEmbedding(`trk_cap_exact_sa${i}`, unitVectorAt(0.99, 1));
        }
        for (const album of ["exactFar1", "exactFar2", "exactFar3"]) {
            for (let i = 0; i < 4; i += 1) {
                await seedEmbedding(`trk_cap_exact_${album}_${i}`, unitVectorAt(0.95, 2));
            }
        }
        for (let a = 0; a < 12; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_exact_scat${a}_${i}`, unitVectorAt(0.8, 3 + a));
            }
        }

        const rows = await findSimilarTracks("trk_cap_exact_sa0", 20);

        // Album-thinning alone would leave 2 (nearest album) + 2 + 2 + 2 = 8
        // seed-artist tracks; the artist cap cuts that to 3 (seed counted).
        expect(rows.filter((r) => r.artistId === "art_cap_exactArtist")).toHaveLength(3);
        expect(rows).toHaveLength(20);
        expect(maxCount(countsBy(rows, (r) => r.albumId))).toBeLessThanOrEqual(2);
        expect(maxCount(countsBy(rows, (r) => r.artistId))).toBeLessThanOrEqual(4);
    });

    // ------------------------------------------------------------------
    // Test 4 — a 50-track request must still be filled: 1 from the 60-track
    // seed album + 3 more from its artist + 46 from scattered albums.
    // Red on the current code (the ranking can only reach ~40 through the
    // default hnsw.ef_search = 40 candidate list).
    // ------------------------------------------------------------------
    it("fills a 50-track list from one 60-track album plus scattered albums", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "fill",
            seedArtistId: "fillArtist",
            seedAlbumId: "fillBig",
            seedAlbumTracks: 60,
            seedArtistExtraAlbums: [{ id: "fillSecond", tracks: 6 }],
            scatteredAlbums: 24,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });
        for (let i = 0; i < 60; i += 1) {
            await seedEmbedding(`trk_cap_fill_sa${i}`, unitVectorAt(1, 1));
        }
        for (let i = 0; i < 6; i += 1) {
            await seedEmbedding(`trk_cap_fill_fillSecond_${i}`, unitVectorAt(0.95, 2));
        }
        for (let a = 0; a < 24; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_fill_scat${a}_${i}`, unitVectorAt(0.8, 3 + (a % 12)));
            }
        }

        const rows = await findSimilarTracks("trk_cap_fill_sa0", 50);

        expect(rows).toHaveLength(50);
        expect(rows.filter((r) => r.albumId === "alb_cap_fillBig")).toHaveLength(1);
        expect(rows.filter((r) => r.artistId === "art_cap_fillArtist")).toHaveLength(3);
        expect(maxCount(countsBy(rows, (r) => r.albumId))).toBeLessThanOrEqual(2);
        expect(maxCount(countsBy(rows, (r) => r.artistId))).toBeLessThanOrEqual(4);
    }, 60_000);

    // ------------------------------------------------------------------
    // Test 5 — the features-only fallback (no CLAP) must obey the same
    // caps. Red on the current code, which returns 20 from the seed's album.
    // ------------------------------------------------------------------
    it("features-only fallback: same 2-per-album / 4-per-artist caps and full length", async () => {
        setMode("featuresOnly");
        const loud = {
            energy: 0.9, valence: 0.9, arousal: 0.9, bpm: 128,
            danceabilityMl: 0.9, acousticness: 0.9, instrumentalness: 0.9,
            key: "C", keyScale: "major",
        };
        const quiet = {
            energy: 0.1, valence: 0.1, arousal: 0.1, bpm: 70,
            danceabilityMl: 0.1, acousticness: 0.1, instrumentalness: 0.1,
            key: "F#", keyScale: "minor",
        };
        await seedCrowdedLibrary({
            prefix: "feat",
            seedArtistId: "featArtist",
            seedAlbumId: "featBig",
            seedAlbumTracks: 12,
            scatteredAlbums: 12,
            scatteredArtists: 12,
            seedFeatures: loud,
            otherFeatures: quiet,
        });

        const rows = await findSimilarTracks("trk_cap_feat_sa0", 20);

        expect(rows).toHaveLength(20);
        // Every seed-album track matches the seed on all eight features
        // (similarity 1.0) and every scattered track is maximally far
        // (similarity ~0.17), so the uncapped list is 20 from the seed's
        // album; the capped one takes 1 and fills from the scattered albums.
        expect(rows.filter((r) => r.albumId === "alb_cap_featBig")).toHaveLength(1);
        expect(rows.filter((r) => r.artistId === "art_cap_featArtist")).toHaveLength(1);
        expect(maxCount(countsBy(rows, (r) => r.albumId))).toBeLessThanOrEqual(2);
        expect(maxCount(countsBy(rows, (r) => r.artistId))).toBeLessThanOrEqual(4);
    });
});