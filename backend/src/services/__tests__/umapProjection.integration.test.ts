/**
 * The 3D vibe map keeps two seeded clusters apart on all three axes, persists
 * map_z, and places tracks outside the UMAP fit sample next to their
 * neighbours. Redis is an in-memory stub.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
        multi: jest.fn(() => {
            const ops: Array<() => void> = [];
            const chain = {
                setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                sadd: () => chain,
                expire: () => chain,
                exec: async () => { ops.forEach((op) => op()); return []; },
            };
            return chain;
        }),
    },
}));

import { prisma } from "../../utils/db";

jest.setTimeout(120_000);

const DIM = 512;
const PER_GROUP = 20;

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function groupEmbedding(group: number, rand: () => number): number[] {
    const v = Array.from({ length: DIM }, () => (rand() - 0.5) * 0.05);
    // Each group leans hard on its own block of dimensions.
    for (let d = group * 64; d < group * 64 + 64; d++) v[d] += 1;
    return v;
}

async function seed() {
    const rand = rng(7);
    const artist = await prisma.artist.create({ data: { id: "art_umap", name: "Umap Artist", identityKey: "a_umap" } });
    const album = await prisma.album.create({
        data: { id: "alb_umap", rgMbid: "rg_umap", artistId: artist.id, title: "Umap Album", primaryType: "Album" },
    });
    for (let g = 0; g < 2; g++) {
        for (let i = 0; i < PER_GROUP; i++) {
            const id = `trk_umap_${g}_${i}`;
            await prisma.track.create({
                data: {
                    id, albumId: album.id, title: `T ${g}-${i}`, trackNo: i + 1, duration: 180,
                    filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                },
            });
            const vec = `[${groupEmbedding(g, rand).join(",")}]`;
            await prisma.$executeRawUnsafe(
                `INSERT INTO track_embeddings (track_id, embedding) VALUES ($1, $2::vector)`,
                id, vec,
            );
        }
    }
}

type Pt = { id: string; x: number; y: number; z: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function meanDist(a: Pt[], b: Pt[]) {
    let s = 0, n = 0;
    for (const p of a) for (const q of b) if (p !== q) { s += dist(p, q); n++; }
    return s / n;
}

async function computeWith(maxFit?: number) {
    store.clear();
    await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET map_x = NULL, map_y = NULL, map_z = NULL`);
    if (maxFit) process.env.VIBE_MAP_MAX_FIT = String(maxFit);
    else delete process.env.VIBE_MAP_MAX_FIT;
    let mod!: typeof import("../umapProjection");
    jest.isolateModules(() => { mod = require("../umapProjection"); });
    return mod.computeMapProjection();
}

function checkLayout(tracks: Pt[]) {
    expect(tracks).toHaveLength(PER_GROUP * 2);
    for (const t of tracks) {
        for (const v of [t.x, t.y, t.z]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(-1e-9);
            expect(v).toBeLessThanOrEqual(1 + 1e-9);
        }
    }
    const zs = tracks.map((t) => t.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.01); // the third axis is used
    const g0 = tracks.filter((t) => t.id.startsWith("trk_umap_0_"));
    const g1 = tracks.filter((t) => t.id.startsWith("trk_umap_1_"));
    expect(meanDist(g0, g0)).toBeLessThan(meanDist(g0, g1));
    expect(meanDist(g1, g1)).toBeLessThan(meanDist(g0, g1));
}

async function unseed() {
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, "trk\\_umap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_umap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, "alb_umap");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, "art_umap");
}

describe("3D vibe map projection", () => {
    beforeAll(seed);
    // The test DB is shared by every file in the run; leaving these rows makes
    // other files' nearest-neighbour results depend on test order.
    afterAll(unseed);

    it("lays the whole library out in 3D with similar tracks together", async () => {
        const result = await computeWith();
        checkLayout(result.tracks as Pt[]);
    });

    it("persists all three coordinates", async () => {
        await computeWith();
        // persistence runs in the background; give it a moment to land
        let rows: Array<{ n: number }> = [];
        for (let i = 0; i < 20; i++) {
            rows = await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM track_embeddings WHERE map_z IS NOT NULL
            `;
            if (rows[0].n === PER_GROUP * 2) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(rows[0].n).toBe(PER_GROUP * 2);
    });

    it("places tracks outside the fitted sample beside their neighbours", async () => {
        const result = await computeWith(12);
        checkLayout(result.tracks as Pt[]);
    });

    it("answers a small library's first request with the map, not 'computing'", async () => {
        store.clear();
        await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET map_x = NULL, map_y = NULL, map_z = NULL`);
        delete process.env.VIBE_MAP_MAX_FIT;
        let mod!: typeof import("../umapProjection");
        jest.isolateModules(() => { mod = require("../umapProjection"); });
        const state = await mod.getMapProjectionState();
        expect(state.status).toBe("ready");
        if (state.status === "ready") expect(state.data.tracks).toHaveLength(PER_GROUP * 2);
        // A second call is served from the cached copy.
        const again = await mod.getMapProjectionState();
        expect(again.status).toBe("ready");
    });

    afterAll(() => { delete process.env.VIBE_MAP_MAX_FIT; });
});
