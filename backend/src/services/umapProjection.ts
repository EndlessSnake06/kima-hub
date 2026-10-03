import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";
import { currentMoodSnapshot, moodOutput } from "./moodBucketService";

const MIN_TRACKS_FOR_UMAP = 5;
// UMAP is fitted on at most this many tracks: umap-js cost grows faster than
// linearly, and 15k already takes minutes. Every other track is then placed
// beside its nearest fitted neighbours (placeRemaining), so the map still
// shows the whole library.
const MAX_FIT_TRACKS = Number(process.env.VIBE_MAP_MAX_FIT) || 15000;
// Hard ceiling on tracks served on the map, to bound payload and browser memory.
const MAX_MAP_TRACKS = 150000;
const PLACE_BATCH = 500;
const PLACE_NEIGHBORS = 12;
const PERSIST_CHUNK = 5000;
const CACHE_KEY = "vibe:map:v4:projection";
const TRACK_IDS_KEY = "vibe:map:v4:track_ids";
// A tiny key that changes whenever the cached projection does, so readers can
// reuse an already-parsed copy instead of fetching and parsing tens of MB.
const STAMP_KEY = "vibe:map:v4:stamp";
const CACHE_TTL = 86400;
const CIRCULAR_CACHE_TTL = 3600; // 1 hour -- refreshes as enrichment adds tracks
const KNN_NEIGHBORS = 5;
const HYDRATE_COVERAGE_THRESHOLD = 0.98;

// SQL fragment: the shared column list for track metadata joins.
// Update in one place when adding/removing projection fields.
const TRACK_METADATA_COLUMNS = Prisma.sql`
    t.title,
    ar.name as "artistName",
    ar.id as "artistId",
    a.id as "albumId",
    a."coverUrl",
    t.energy,
    t.valence
`;

interface MapTrack {
    id: string;
    x: number;
    y: number;
    z: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    /** A mood column name, "neutral" (no single mood) or "unanalyzed". */
    dominantMood: string;
    /** Library rank (0..1) of the dominant mood. */
    moodScore: number;
    /** Library rank (0..1) per mood; see moodBucketService. */
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

interface MapResponse {
    tracks: MapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
    /** Mood snapshot the tracks' mood fields were last filled from. */
    moodSignature?: string;
}

// Positions are cached for a day but moods move as analysis lands, so every
// read fills moods from the current snapshot.
async function withCurrentMoods(data: MapResponse): Promise<MapResponse> {
    const snap = await currentMoodSnapshot();
    if (data.moodSignature === snap.signature) return data;
    for (const t of data.tracks) Object.assign(t, moodOutput(snap.views.get(t.id)));
    data.moodSignature = snap.signature;
    return data;
}

const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;

/**
 * Worker source for unbuilt checkouts: a worker thread does not inherit tsx's
 * loader, so dev runs this inline copy instead of umapWorker.ts. Keep it in
 * step with that file (same options and messages); production runs the file.
 */
const INLINE_UMAP_WORKER = `
const { parentPort, workerData } = require("worker_threads");
const { UMAP } = require(${JSON.stringify(require.resolve("umap-js"))});
const { embeddings, nNeighbors } = workerData;
try {
    const umap = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.1, spread: 1.0 });
    parentPort.postMessage(umap.fit(embeddings));
} catch (err) {
    parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
}
`;

function makeUmapWorker(embeddings: number[][], nNeighbors: number): Worker {
    const workerData = { embeddings, nNeighbors };

    const compiled = path.join(__dirname, "../workers/umapWorker.js");
    if (fs.existsSync(compiled)) {
        return new Worker(compiled, { workerData });
    }

    logger.debug("[VIBE-MAP] No compiled UMAP worker; running the inline source instead");
    return new Worker(INLINE_UMAP_WORKER, { eval: true, workerData });
}

function runUmapInWorker(embeddings: number[][], nNeighbors: number): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const worker = makeUmapWorker(embeddings, nNeighbors);

        let settled = false;

        const warnTimer = setTimeout(() => {
            logger.warn(`[VIBE-MAP] UMAP worker running for 5+ minutes (${embeddings.length} tracks)`);
        }, UMAP_WARN_MS);

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                clearTimeout(warnTimer);
                worker.terminate();
                reject(new Error(`UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`));
            }
        }, UMAP_TIMEOUT_MS);

        worker.on("message", (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                if (result?.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            }
        });

        worker.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                reject(err);
            }
        });

        worker.on("exit", (code) => {
            if (!settled && code !== 0) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                reject(new Error(`UMAP worker exited with code ${code}`));
            }
        });
    });
}

let computePromise: Promise<MapResponse> | null = null;
let lastFailure: { at: number; message: string } | null = null;
const FAILURE_BACKOFF_MS = 60_000;

let parsedMemo: { stamp: string; data: MapResponse } | null = null;

function stampOf(result: MapResponse): string {
    return `${result.computedAt}:${result.trackCount}`;
}

/** The cached projection, parsed once per version rather than once per request. */
async function readCachedProjection(): Promise<MapResponse | null> {
    const stamp = await redisClient.get(STAMP_KEY);
    if (stamp && parsedMemo?.stamp === stamp) return parsedMemo.data;
    const raw = await redisClient.get(CACHE_KEY);
    if (!raw) return null;
    const data: MapResponse = JSON.parse(raw);
    if (stamp) parsedMemo = { stamp, data };
    return data;
}

function startCompute(): Promise<MapResponse> {
    if (!computePromise) {
        computePromise = doCompute()
            .then((result) => { lastFailure = null; return result; })
            .catch((e: Error) => { lastFailure = { at: Date.now(), message: e.message }; throw e; })
            .finally(() => { computePromise = null; });
    }
    return computePromise;
}

export async function computeMapProjection(): Promise<MapResponse> {
    return withCurrentMoods(await computeMapPositions());
}

async function computeMapPositions(): Promise<MapResponse> {
    const cached = await readCachedProjection();
    if (cached) {
        logger.debug("[VIBE-MAP] Cache hit (stable key)");
        return cached;
    }

    // Try DB hydrate path: if every embedding has a persisted map position,
    // we can skip the expensive UMAP worker entirely and just hydrate metadata.
    const dbResult = await hydrateFromDb();
    if (dbResult) {
        await cacheResult(dbResult, dbResult.tracks.map(t => t.id));
        logger.info(`[VIBE-MAP] Hydrated ${dbResult.trackCount} tracks from DB positions`);
        return dbResult;
    }

    if (computePromise) logger.info("[VIBE-MAP] Waiting for in-progress computation");
    return startCompute();
}

export type MapProjectionState =
    | { status: "ready"; data: MapResponse }
    | { status: "computing" }
    | { status: "failed"; message: string };

const QUICK_COMPUTE_WAIT_MS = 2000;

/**
 * The map if it can be served now; otherwise start or join the layout in the
 * background and report that it is computing. A first layout takes minutes,
 * so the route answers at once and the client polls.
 */
export async function getMapProjectionState(): Promise<MapProjectionState> {
    const state = await getMapPositionsState();
    if (state.status !== "ready") return state;
    return { status: "ready", data: await withCurrentMoods(state.data) };
}

async function getMapPositionsState(): Promise<MapProjectionState> {
    const cached = await readCachedProjection();
    if (cached) return { status: "ready", data: cached };
    if (!computePromise) {
        const dbResult = await hydrateFromDb();
        if (dbResult) {
            await cacheResult(dbResult, dbResult.tracks.map(t => t.id));
            return { status: "ready", data: dbResult };
        }
        if (lastFailure && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) {
            return { status: "failed", message: lastFailure.message };
        }
    }
    const pending = startCompute();
    pending.catch(() => { /* recorded in lastFailure; surfaced on the next poll */ });
    // Small libraries finish in moments; answer them in the same request.
    const quick = await Promise.race([
        pending.then((data) => data, () => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), QUICK_COMPUTE_WAIT_MS)),
    ]);
    if (quick) return { status: "ready", data: quick };
    if (!computePromise && lastFailure) return { status: "failed", message: lastFailure.message };
    return { status: "computing" };
}

// Bulk persist normalized map positions back to the embedding table, a few
// thousand rows per statement via UNNEST of parallel arrays.
async function persistPositions(ids: string[], xs: number[], ys: number[], zs: number[]): Promise<void> {
    for (let start = 0; start < ids.length; start += PERSIST_CHUNK) {
        const end = start + PERSIST_CHUNK;
        try {
            await prisma.$executeRaw`
                UPDATE track_embeddings AS te
                SET map_x = u.x, map_y = u.y, map_z = u.z
                FROM UNNEST(
                    ${ids.slice(start, end)}::text[],
                    ${xs.slice(start, end)}::float8[],
                    ${ys.slice(start, end)}::float8[],
                    ${zs.slice(start, end)}::float8[]
                ) AS u(tid, x, y, z)
                WHERE te.track_id = u.tid
            `;
        } catch (e) {
            logger.warn("[VIBE-MAP] Failed to persist positions:", (e as Error).message);
            return;
        }
    }
}

// Attempt to serve the map from persisted DB positions without running UMAP.
// Returns null if coverage is incomplete (new tracks enriched since last run,
// positions never computed, etc.) so the caller falls through to doCompute().
async function hydrateFromDb(): Promise<MapResponse | null> {
    try {
        const coverage = await prisma.$queryRaw<Array<{ total: bigint; covered: bigint }>>`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE te.map_x IS NOT NULL AND te.map_y IS NOT NULL AND te.map_z IS NOT NULL) AS covered
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            WHERE t."missingSince" IS NULL
        `;
        const total = Number(coverage[0]?.total ?? 0n);
        const covered = Number(coverage[0]?.covered ?? 0n);
        if (total === 0) return null;
        if (covered / total < HYDRATE_COVERAGE_THRESHOLD) {
            logger.info(`[VIBE-MAP] DB hydrate skipped: ${covered}/${total} below threshold`);
            return null;
        }
        if (covered < total) {
            logger.info(`[VIBE-MAP] DB hydrate with partial coverage: ${covered}/${total}`);
        }

        const rows = await prisma.$queryRaw<Array<TrackRow & { map_x: number; map_y: number; map_z: number }>>`
            SELECT
                te.track_id,
                te.map_x,
                te.map_y,
                te.map_z,
                ${TRACK_METADATA_COLUMNS}
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.map_x IS NOT NULL AND te.map_y IS NOT NULL AND te.map_z IS NOT NULL
            AND t."missingSince" IS NULL
            ORDER BY te.track_id ASC
            LIMIT ${MAX_MAP_TRACKS}
        `;

        if (rows.length === 0) {
            logger.warn("[VIBE-MAP] Hydrate SELECT returned 0 rows despite coverage check - race condition");
            return null;
        }

        const sampled = rows.length === MAX_MAP_TRACKS;
        const tracks: MapTrack[] = rows.map(row => {
            return {
                id: row.track_id,
                x: row.map_x,
                y: row.map_y,
                z: row.map_z,
                title: row.title,
                artist: row.artistName,
                artistId: row.artistId,
                albumId: row.albumId,
                coverUrl: row.coverUrl,
                ...moodOutput(undefined),
                energy: row.energy,
                valence: row.valence,
            };
        });

        return {
            tracks,
            trackCount: tracks.length,
            ...(sampled && { sampled: true }),
            computedAt: new Date().toISOString(),
        };
    } catch (e) {
        logger.warn("[VIBE-MAP] DB hydrate failed:", (e as Error).message);
        return null;
    }
}

async function cacheResult(result: MapResponse, trackIds: string[], ttl = CACHE_TTL): Promise<void> {
    try {
        const pipeline = redisClient.multi();
        pipeline.setex(CACHE_KEY, ttl, JSON.stringify(result));
        pipeline.setex(STAMP_KEY, ttl, stampOf(result));
        pipeline.del(TRACK_IDS_KEY);
        if (trackIds.length > 0) {
            pipeline.sadd(TRACK_IDS_KEY, trackIds);
            pipeline.expire(TRACK_IDS_KEY, ttl);
        }
        await pipeline.exec();
    } catch (e) {
        logger.warn("[VIBE-MAP] Failed to cache projection:", (e as Error).message);
    }
}

type TrackRow = {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    energy: number | null;
    valence: number | null;
};

async function buildCircularLayout(rows: TrackRow[]): Promise<MapResponse> {
    const trackIds = rows.map(r => r.track_id);
    const result: MapResponse = {
        tracks: rows.map((r, i) => {
            const angle = (2 * Math.PI * i) / rows.length;
            return {
                id: r.track_id,
                x: 0.5 + 0.3 * Math.cos(angle),
                y: 0.5 + 0.3 * Math.sin(angle),
                z: 0.5,
                title: r.title,
                artist: r.artistName,
                artistId: r.artistId,
                albumId: r.albumId,
                coverUrl: r.coverUrl,
                ...moodOutput(undefined),
                energy: r.energy,
                valence: r.valence,
            };
        }),
        trackCount: rows.length,
        computedAt: new Date().toISOString(),
    };
    await cacheResult(result, trackIds, CIRCULAR_CACHE_TTL);
    return result;
}

function toMapTrack(row: TrackRow, x: number, y: number, z: number): MapTrack {
    return {
        id: row.track_id,
        x,
        y,
        z,
        title: row.title,
        artist: row.artistName,
        artistId: row.artistId,
        albumId: row.albumId,
        coverUrl: row.coverUrl,
        ...moodOutput(undefined),
        energy: row.energy,
        valence: row.valence,
    };
}

type Vec3 = [number, number, number];

/** Inverse-distance-weighted average of placed neighbours; null if none are placed. */
function interpolate(neighbors: Array<{ id: string; distance: number }>, placed: Map<string, Vec3>, k = 5): Vec3 | null {
    let wsum = 0, x = 0, y = 0, z = 0, used = 0;
    for (const n of neighbors) {
        const p = placed.get(n.id);
        if (!p) continue;
        const w = 1 / (n.distance + 1e-6);
        x += p[0] * w; y += p[1] * w; z += p[2] * w; wsum += w;
        if (++used >= k) break;
    }
    return used === 0 ? null : [x / wsum, y / wsum, z / wsum];
}

/**
 * Place the tracks UMAP was not fitted on beside their nearest neighbours in
 * embedding space, a batch at a time through the HNSW index. Later batches can
 * lean on tracks placed by earlier ones, so a few passes reach nearly every
 * track; stragglers are placed against the fitted set directly.
 */
async function placeRemaining(ids: string[], placed: Map<string, Vec3>, fittedIds: string[]): Promise<void> {
    let pending = ids;
    for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
        const missed: string[] = [];
        for (let start = 0; start < pending.length; start += PLACE_BATCH) {
            const batch = pending.slice(start, start + PLACE_BATCH);
            const rows = await prisma.$queryRaw<Array<{ qid: string; nid: string; distance: number }>>`
                SELECT q.track_id AS qid, n.track_id AS nid, n.distance
                FROM track_embeddings q
                CROSS JOIN LATERAL (
                    SELECT te2.track_id, q.embedding <=> te2.embedding AS distance
                    FROM track_embeddings te2
                    JOIN "Track" t2 ON te2.track_id = t2.id
                    WHERE te2.track_id <> q.track_id
                    AND t2."missingSince" IS NULL
                    ORDER BY q.embedding <=> te2.embedding
                    LIMIT ${PLACE_NEIGHBORS}
                ) n
                WHERE q.track_id = ANY(${batch}::text[])
            `;
            const byQuery = new Map<string, Array<{ id: string; distance: number }>>();
            for (const r of rows) {
                const list = byQuery.get(r.qid) ?? [];
                list.push({ id: r.nid, distance: Number(r.distance) });
                byQuery.set(r.qid, list);
            }
            for (const id of batch) {
                const pos = interpolate((byQuery.get(id) ?? []).sort((a, b) => a.distance - b.distance), placed);
                if (pos) placed.set(id, pos);
                else missed.push(id);
            }
        }
        pending = missed;
    }

    for (const id of pending) {
        const rows = await prisma.$queryRaw<Array<{ nid: string; distance: number }>>`
            SELECT te2.track_id AS nid, q.embedding <=> te2.embedding AS distance
            FROM track_embeddings q, track_embeddings te2
            JOIN "Track" t2 ON te2.track_id = t2.id
            WHERE q.track_id = ${id} AND te2.track_id = ANY(${fittedIds}::text[])
            AND t2."missingSince" IS NULL
            ORDER BY distance
            LIMIT 5
        `;
        const pos = interpolate(rows.map(r => ({ id: r.nid, distance: Number(r.distance) })), placed);
        if (pos) placed.set(id, pos);
    }
}

async function doCompute(): Promise<MapResponse> {
    const startTime = Date.now();

    const rows = await prisma.$queryRaw<TrackRow[]>`
        SELECT
            te.track_id,
            ${TRACK_METADATA_COLUMNS}
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."missingSince" IS NULL
        ORDER BY te.track_id ASC
        LIMIT ${MAX_MAP_TRACKS}
    `;

    if (rows.length === 0) {
        return { tracks: [], trackCount: 0, computedAt: new Date().toISOString() };
    }
    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(rows);
    }
    const sampled = rows.length === MAX_MAP_TRACKS;

    // Fit on everything when it fits; otherwise on a random sample.
    const fitRows = await prisma.$queryRaw<Array<{ track_id: string; embedding: string }>>`
        SELECT te.track_id, te.embedding::text AS embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."missingSince" IS NULL
        ORDER BY RANDOM()
        LIMIT ${MAX_FIT_TRACKS}
    `;
    const fittedIds = fitRows.map(r => r.track_id);
    logger.info(`[VIBE-MAP] Fitting 3D UMAP on ${fitRows.length} of ${rows.length} tracks...`);

    const embeddings: number[][] = fitRows.map(r => parseEmbedding(r.embedding));
    // Scale nNeighbors with library size: sqrt gives balanced local/global structure.
    const nNeighbors = Math.min(50, Math.max(5, Math.round(Math.sqrt(fitRows.length))));
    const projection = await runUmapInWorker(embeddings, nNeighbors);

    const placed = new Map<string, Vec3>();
    fitRows.forEach((r, i) => placed.set(r.track_id, [projection[i][0], projection[i][1], projection[i][2] ?? 0]));

    const unplaced = rows.map(r => r.track_id).filter(id => !placed.has(id));
    if (unplaced.length > 0) {
        const placeStart = Date.now();
        await placeRemaining(unplaced, placed, fittedIds);
        logger.info(`[VIBE-MAP] Placed ${unplaced.length} further tracks by nearest neighbours in ${Date.now() - placeStart}ms`);
    }

    // Normalise into the unit cube with ONE scale for all three axes, so the
    // cloud keeps its true shape instead of being stretched to fill a square.
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of placed.values()) {
        for (let a = 0; a < 3; a++) {
            if (p[a] < min[a]) min[a] = p[a];
            if (p[a] > max[a]) max[a] = p[a];
        }
    }
    const range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const norm = (p: Vec3): Vec3 => [
        0.5 + (p[0] - centre[0]) / range,
        0.5 + (p[1] - centre[1]) / range,
        0.5 + (p[2] - centre[2]) / range,
    ];

    const ids: string[] = [], xs: number[] = [], ys: number[] = [], zs: number[] = [];
    const tracks: MapTrack[] = [];
    for (const row of rows) {
        const p = placed.get(row.track_id);
        if (!p) continue; // no neighbours at all (isolated embedding); left off the map
        const [x, y, z] = norm(p);
        ids.push(row.track_id); xs.push(x); ys.push(y); zs.push(z);
        tracks.push(toMapTrack(row, x, y, z));
    }

    const result: MapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled && { sampled: true }),
        computedAt: new Date().toISOString(),
    };

    void persistPositions(ids, xs, ys, zs).catch(e =>
        logger.warn("[VIBE-MAP] persist failed (background):", (e as Error).message)
    );
    await cacheResult(result, ids);

    logger.info(`[VIBE-MAP] 3D projection computed in ${Date.now() - startTime}ms for ${tracks.length} tracks`);
    return result;
}

// Appends buffer and flush on a debounce instead of rewriting the whole cache
// per track. Before writing, the flush re-checks computedAt and drops itself if
// a full recompute landed meanwhile.
const APPEND_FLUSH_DEBOUNCE_MS = 2000;
const APPEND_FLUSH_MAX_BATCH = 50;

let workingProjection: MapResponse | null = null;
let workingTrackIds: Set<string> | null = null;
let workingPositions: Map<string, { x: number; y: number; z: number }> | null = null;
let workingProjectionLoad: Promise<MapResponse | null> | null = null;
let pendingFlushIds: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function getWorkingProjection(): Promise<MapResponse | null> {
    if (workingProjection && workingTrackIds) return workingProjection;

    if (!workingProjectionLoad) {
        workingProjectionLoad = (async () => {
            const cached = await redisClient.get(CACHE_KEY);
            if (!cached) return null;
            const projection: MapResponse = JSON.parse(cached);
            workingProjection = projection;
            workingTrackIds = new Set(projection.tracks.map(t => t.id));
            workingPositions = new Map(projection.tracks.map(t => [t.id, { x: t.x, y: t.y, z: t.z ?? 0.5 }]));
            return projection;
        })();
    }

    try {
        return await workingProjectionLoad;
    } finally {
        workingProjectionLoad = null;
    }
}

function scheduleAppendFlush(): void {
    if (pendingFlushIds.length >= APPEND_FLUSH_MAX_BATCH) {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushPendingAppends().catch(e =>
            logger.warn("[VIBE-MAP] Append flush failed:", (e as Error).message)
        );
        return;
    }
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushPendingAppends().catch(e =>
                logger.warn("[VIBE-MAP] Append flush failed:", (e as Error).message)
            );
        }, APPEND_FLUSH_DEBOUNCE_MS);
    }
}

async function flushPendingAppends(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (pendingFlushIds.length === 0 || !workingProjection) return;

    const projection = workingProjection;
    const flushedIds = pendingFlushIds;
    pendingFlushIds = [];
    // Drop the working copy either way -- the next append reloads fresh from
    // Redis, so we never keep interpolating on top of an increasingly stale base.
    workingProjection = null;
    workingTrackIds = null;
    workingPositions = null;

    try {
        const current = await redisClient.get(CACHE_KEY);
        if (!current) return; // cache evicted; the next full recompute will rebuild it

        const currentProjection: MapResponse = JSON.parse(current);
        if (currentProjection.computedAt !== projection.computedAt) {
            // A full recompute landed while we were buffering -- it already
            // supersedes our interpolated appends, so don't clobber it.
            logger.debug(
                "[VIBE-MAP] Skipping buffered flush: superseded by a full recompute"
            );
            return;
        }

        const pipeline = redisClient.multi();
        pipeline.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(projection));
        pipeline.setex(STAMP_KEY, CACHE_TTL, stampOf(projection));
        pipeline.sadd(TRACK_IDS_KEY, flushedIds);
        await pipeline.exec();

        logger.debug(
            `[VIBE-MAP] Flushed ${flushedIds.length} buffered append(s) to projection cache`
        );
    } catch (e) {
        logger.warn(
            "[VIBE-MAP] Failed to flush buffered projection appends:",
            (e as Error).message
        );
    }
}

export async function appendTrackToProjection(trackId: string): Promise<boolean> {
    try {
        const projection = await getWorkingProjection();
        if (!projection || !workingTrackIds) return false;

        if (workingTrackIds.has(trackId)) return false;

        // Find K nearest neighbors via pgvector cosine distance
        const neighbors = await prisma.$queryRaw<Array<{
            track_id: string;
            distance: number;
        }>>`
            SELECT
                te2.track_id,
                te1.embedding <=> te2.embedding AS distance
            FROM track_embeddings te1
            JOIN track_embeddings te2 ON te2.track_id != te1.track_id
            WHERE te1.track_id = ${trackId}
            ORDER BY te1.embedding <=> te2.embedding
            LIMIT ${KNN_NEIGHBORS * 3}
        `;

        if (neighbors.length === 0) return false;

        const trackPositions = workingPositions;
        if (!trackPositions) return false;

        // Filter to neighbors that exist in our projection
        const validNeighbors = neighbors
            .filter(n => trackPositions.has(n.track_id))
            .slice(0, KNN_NEIGHBORS);

        if (validNeighbors.length === 0) return false;

        // Inverse distance weighted average of neighbor positions
        let weightSum = 0;
        let wx = 0;
        let wy = 0;
        let wz = 0;
        for (const neighbor of validNeighbors) {
            const pos = trackPositions.get(neighbor.track_id)!;
            const weight = 1 / (neighbor.distance + 1e-6);
            wx += pos.x * weight;
            wy += pos.y * weight;
            wz += pos.z * weight;
            weightSum += weight;
        }

        const newX = wx / weightSum;
        const newY = wy / weightSum;
        const newZ = wz / weightSum;

        // Fetch track metadata
        const trackData = await prisma.$queryRaw<TrackRow[]>`
            SELECT
                te.track_id,
                ${TRACK_METADATA_COLUMNS}
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.track_id = ${trackId}
        `;

        if (trackData.length === 0) return false;

        const newTrack = toMapTrack(trackData[0], newX, newY, newZ);

        // Merge into the shared in-memory working copy; the actual Redis
        // write is coalesced across all appends in this debounce window.
        projection.tracks.push(newTrack);
        projection.trackCount = projection.tracks.length;
        workingTrackIds.add(trackId);
        trackPositions.set(trackId, { x: newX, y: newY, z: newZ });
        pendingFlushIds.push(trackId);
        scheduleAppendFlush();

        // Persist so it survives Redis expiry and feeds hydrateFromDb(), and
        // so the position isn't lost even if the process restarts before flush.
        await persistPositions([trackId], [newX], [newY], [newZ]);

        logger.debug(`[VIBE-MAP] Buffered append for track ${trackId} via KNN interpolation (${validNeighbors.length} neighbors)`);
        return true;
    } catch (e) {
        logger.warn(`[VIBE-MAP] Failed to append track ${trackId}:`, (e as Error).message);
        return false;
    }
}

export async function precomputeProjection(): Promise<void> {
    try {
        await redisClient.del(STAMP_KEY);
        await redisClient.del(CACHE_KEY);
        await redisClient.del(TRACK_IDS_KEY);
        parsedMemo = null;
        const result = await computeMapProjection();
        logger.info(`[VIBE-MAP] Pre-computed projection: ${result.trackCount} tracks`);
    } catch (e) {
        logger.error("[VIBE-MAP] Pre-computation failed:", (e as Error).message);
    }
}
