/**
 * S1: pgvector's HNSW index answers a nearest-neighbour query from a candidate
 * list of hnsw.ef_search tuples (default 40), so a request for 50 or 100 rows
 * silently returns ~40, and WHERE-clause exclusions (alchemy's 20 input
 * tracks, the song path's visited set) eat into the same 40. The shipped
 * index-using queries must size ef_search from the requested limit inside the
 * transaction that runs them (utils/knn.ts).
 *
 * The EXPLAIN guard runs FIRST on purpose: on a small table Postgres
 * seq-scans, the results are exact, and the row-count assertions below would
 * pass with the bug still present. The worker DB starts empty every run
 * (test-global-setup.cjs wipes it), so this file seeds its own library and
 * ANALYZEs it, then refuses to score the rest of the suite unless the planner
 * answers the probe through track_embeddings_embedding_idx.
 *
 * Everything drives the SHIPPED code (findSimilarTracks,
 * searchTracksByEmbedding, the /alchemy route) -- not re-typed SQL.
 * Embeddings are seeded via raw SQL because Prisma cannot write
 * Unsupported("vector") columns.
 */
import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// Same authenticated passthrough the S2 route test uses (Proxy so any other
// export the routers' transitive imports reach for degrades gracefully).
jest.mock("../../middleware/auth", () => {
    const passthrough = (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    };
    return new Proxy(
        { requireAuth: passthrough, requireAuthOrToken: passthrough },
        {
            get(target: any, key: string) {
                if (key in target) return target[key];
                return passthrough;
            },
        },
    );
});

jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: { ping: jest.fn(async () => "pong") },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            musicCNN: true,
            vibeEmbeddings: true,
            audiobookshelfEnabled: false,
        }),
    },
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { efFor, withEfSearch } from "../../utils/knn";
import { findSimilarTracks } from "../hybridSimilarity";
import { searchTracksByEmbedding } from "../textEmbeddingBridge";
import vibeRouter from "../../routes/vibe";

const vibeApp = express();
// Production mounts express.json() globally in src/index.ts; the bare test
// app has to add it for the POST routes to see a parsed body.
vibeApp.use(express.json());
vibeApp.use("/api/vibe", vibeRouter);

const TRACK_COUNT = 4000;
// /alchemy validates ids against /^c[a-z0-9]{20,30}$/ (22 chars here).
const trackId = (i: number) => `cknn${String(i).padStart(18, "0")}`;
const ALL_IDS = Array.from({ length: TRACK_COUNT }, (_, i) => trackId(i));

// A unit 512-dim vector from a deterministic PRNG (seeded per track, so the
// library is reproducible run to run). Random vectors are essential here:
// structured seeds (mutually orthogonal axes, clustered points) create mass
// ties in the cosine distances, and a global tie defeats pgvector's search
// stopping rule -- the index then scans past hnsw.ef_search until LIMIT is
// satisfied and the 40-row cap this suite exists to catch never reproduces.
function lcg(seed: number): () => number {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

// Raw LCG streams from nearby seeds are scaled copies of one another
// (term_n = seed * 16807^n mod p), which makes their vectors nearly parallel;
// run each index through a splitmix-style mixer first so the streams are
// genuinely independent.
function seedFor(i: number): number {
    let h = (i + 1) | 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return ((h >>> 0) % 2147483646) + 1;
}

function randomUnit(i: number): string {
    const rand = lcg(seedFor(i));
    const v = Array.from({ length: 512 }, () => rand() * 2 - 1);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    return `[${v.map((x) => x / norm).join(",")}]`;
}

function negated(vector: string): string {
    return `[${vector
        .slice(1, -1)
        .split(",")
        .map((x) => -Number(x))
        .join(",")}]`;
}

beforeAll(async () => {
    // Leftover tracks (and their embeddings) from any other suite or an
    // interrupted run would land inside this suite's vector-search windows:
    // start from an empty library -- this file seeds everything it asserts
    // about. Deleting tracks cascades their embedding rows.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    await prisma.artist.create({
        data: { id: "cart_knn_1", name: "KNN Artist", identityKey: "a_knn_1" },
    });
    await prisma.album.create({
        data: {
            id: "calb_knn_1",
            rgMbid: "rg_knn_1",
            artistId: "cart_knn_1",
            title: "KNN Album",
            primaryType: "Album",
        },
    });
    await prisma.track.createMany({
        data: ALL_IDS.map((id, i) => ({
            id,
            albumId: "calb_knn_1",
            title: `T ${i}`,
            trackNo: i + 1,
            duration: 200,
            filePath: `/tmp/knn_${i}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        })),
    });
    // The first 10 tracks all carry the same fingerprint (they are the /alchemy
    // add set, constructed so they are provably the blend's exact nearest
    // neighbours -- see the alchemy test), the next 10 carry its negation as
    // the subtract fingerprint; the rest are independent random points.
    const ADD_VECTOR = randomUnit(7);
    const SUBTRACT_VECTOR = negated(ADD_VECTOR);
    const vectorFor = (i: number) =>
        i < 10 ? ADD_VECTOR : i < 20 ? SUBTRACT_VECTOR : randomUnit(i);
    for (let start = 0; start < TRACK_COUNT; start += 25) {
        const ids = ALL_IDS.slice(start, start + 25);
        const values = ids
            .map((_, j) => `($${2 * j + 1}, $${2 * j + 2}::vector, 'laion-clap-music', now())`)
            .join(",");
        const params = ids.flatMap((id, j) => [id, vectorFor(start + j)]);
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ${values}`,
            ...params,
        );
    }
    // The planner decides index vs seq scan from pg_class statistics, which a
    // plain INSERT leaves stale (reltuples=0 => "empty table" => seq scan).
    // ANALYZE makes the EXPLAIN guard below a truthful planner decision.
    for (const table of ['"track_embeddings"', '"Track"', '"Album"', '"Artist"']) {
        await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
    }
}, 120000);

afterAll(async () => {
    // track_embeddings rows first, then the parents; the underscore is escaped
    // because LIKE treats a bare _ as a wildcard.
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, "cknn%");
    await prisma.track.deleteMany({ where: { id: { startsWith: "cknn" } } });
    await prisma.album.deleteMany({ where: { id: "calb_knn_1" } });
    await prisma.artist.deleteMany({ where: { id: "cart_knn_1" } });
    // Deleting the rows does not undo the ANALYZE above: later suites in this
    // worker DB would plan against the 4000-row peak, get an index scan their
    // tiny live sets never see on a fresh table, and starve inside the
    // ef_search window among thousands of dead index entries. VACUUM
    // (ANALYZE) restores both the statistics and the dead index entries, so
    // this file leaves the DB the way it found it.
    for (const table of ['"track_embeddings"', '"Track"', '"Album"', '"Artist"']) {
        await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`);
    }
    await prisma.$disconnect();
});

describe("HNSW index-scan guard (the row counts below are only meaningful through the index)", () => {
    it("answers the similar-tracks shape with Index Scan using track_embeddings_embedding_idx", async () => {
        // Mirrors the shipped shape in hybridSimilarity.ts (WITH source, the
        // S2 EXISTS guard, ORDER BY distance, LIMIT) with a real seed bound.
        const plan = await prisma.$queryRaw<Array<Record<string, string>>>`
            EXPLAIN (COSTS OFF)
            WITH source AS (
                SELECT embedding FROM track_embeddings WHERE track_id = ${trackId(0)}
            )
            SELECT t.id
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.track_id != ${trackId(0)}
            AND EXISTS (SELECT 1 FROM source)
            ORDER BY te.embedding <=> (SELECT embedding FROM source)
            LIMIT 50
        `;
        const text = plan.map((row) => Object.values(row).join("\n")).join("\n");
        expect(text).toContain("Index Scan using track_embeddings_embedding_idx");
        // The small Album/Artist dimension tables may seq-scan as join inputs;
        // what must never happen is a Seq Scan over the vector table itself --
        // an exact scan makes every row-count assertion below vacuous.
        expect(text).not.toContain("Seq Scan on track_embeddings");
    });
});

describe("vector searches return the requested row count (S1)", () => {
    it("findSimilarTracks(seed, 50) ranks past the 40-row index default", async () => {
        // S3 changes what this fixture can return, not the search width: all
        // 4000 tracks live in ONE album by ONE artist, so the diversification
        // caps (2 per album / 4 per artist, seed counted) cut the list to 1.
        // The whole-library ranking still reaches past the default 40-candidate
        // window -- proved by the EXPLAIN guard above plus the multi-album
        // full-length cases in hybridSimilarity.caps.test.ts.
        const rows = await findSimilarTracks(trackId(0), 50);
        expect(rows).toHaveLength(1);
        expect(rows.every((r) => r.id !== trackId(0))).toBe(true);
    });

    it("searchTracksByEmbedding(query, 100) returns 100 rows", async () => {
        const rows = await searchTracksByEmbedding(
            JSON.parse(randomUnit(999999)),
            100,
        );
        expect(rows).toHaveLength(100);
    });

    it("alchemy with 10 add + 10 subtract at limit 100 returns 100 rows, not the 40-candidate cap", async () => {
        // Geometry: the subtract fingerprint is the exact negation of the add
        // one, so the blend (mean(add) - mean(subtract)) lands right on the add
        // fingerprint -- the 10 adds are the blend's distance-0 nearest
        // neighbours, i.e. the real feature's "inputs you blended from crowd
        // the result", with no tie-group ambiguity.
        const res = await request(vibeApp)
            .post("/api/vibe/alchemy")
            .send({
                add: ALL_IDS.slice(0, 10),
                subtract: ALL_IDS.slice(10, 20),
                limit: 100,
            });
        if (res.status !== 200) {
            const logError = logger.error as jest.Mock;
            const msgs = logError.mock.calls.map((c: unknown[]) =>
                c.map((part) => (part instanceof Error ? `${part.name}: ${part.message}` : String(part))),
            );
            throw new Error(
                `alchemy returned ${res.status} ${JSON.stringify(res.body)} :: ${JSON.stringify(msgs)}`,
            );
        }
        expect(res.status).toBe(200);
        const ids: string[] = res.body.tracks.map((t: { id: string }) => t.id);
        // Before the fix the index yields at most ~hnsw.ef_search=40 candidates
        // (minus excluded inputs), so 100 can never be reached; after it, the
        // widened candidate list serves the full limit.
        expect(ids).toHaveLength(100);
        // Every excluded input stays excluded even the nearest ones.
        expect(ids.some((id) => ALL_IDS.slice(0, 20).includes(id))).toBe(false);
    });
});

describe("utils/knn helper contract", () => {
    it("raises ef_search to the requested width inside the transaction", async () => {
        const inside = await withEfSearch(123, async (tx) => {
            const rows = await tx.$queryRaw<Array<{ v: string }>>`
                SELECT current_setting('hnsw.ef_search') AS v
            `;
            return rows[0].v;
        });
        expect(inside).toBe("123");
    });

    it("reverts to the 40 default on the pool after the transaction", async () => {
        await withEfSearch(500, async () => undefined);
        const rows = await prisma.$queryRaw<Array<{ v: string }>>`
            SELECT current_setting('hnsw.ef_search') AS v
        `;
        expect(rows[0].v).toBe("40");
    });

    it("sizes the width as min(1000, max(2*limit + excluded, 100))", () => {
        expect(efFor(50, 1)).toBe(101); // similar tracks: 2*limit + the seed
        expect(efFor(100, 0)).toBe(200); // text search at the route cap
        expect(efFor(30, 20)).toBe(100); // alchemy: floor wins at 2*30+20=80
        expect(efFor(1, 0)).toBe(100); // documented floor
        expect(efFor(600, 0)).toBe(1000); // pgvector's hard maximum
        expect(efFor(450, 100)).toBe(1000); // ceiling clamps 2k+excluded
    });
});

describe("S1 wiring", () => {
    // Source-integrity pins, same trick as the F5 invariant test in
    // hybridSimilarity.nullhandling.test.ts: the four index-using query sites
    // must go through the widened transaction, and the S2 EXISTS guard that
    // shares the similar-tracks query must stay put.
    it("all four capped query sites route through withEfSearch; the S2 EXISTS guard survives", () => {
        const read = (p: string) =>
            fs.readFileSync(path.join(__dirname, p), "utf8");
        const hybrid = read("../../services/hybridSimilarity.ts");
        expect(hybrid).toContain("withEfSearch(");
        expect(hybrid).toContain("AND EXISTS (SELECT 1 FROM source)");
        expect(read("../../services/textEmbeddingBridge.ts")).toContain("withEfSearch(");
        expect(read("../../routes/vibe.ts")).toContain("withEfSearch(");
        expect(read("../../services/songPath.ts")).toContain("withEfSearch(");
    });
});
