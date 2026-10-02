/**
 * The owned library as one gzipped JSON document for chevron7.io: every present
 * track with a map position, its raw 3-axis position, moods, energy, valence and
 * its nearest tracks by CLAP cosine. Rebuilt only when the library's fingerprint
 * changes; the fingerprint doubles as the ETag.
 */
import crypto from "crypto";
import { promisify } from "util";
import zlib from "zlib";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";
import { MOODS, NEUTRAL, UNANALYZED, refreshMoodSnapshot } from "./moodBucketService";

const gzip = promisify(zlib.gzip);

const EXPORT_VERSION = 1;
const NEIGHBOURS = 8;
const NEIGHBOUR_BATCH = 500;
/** Index candidates fetched per track before excluded tracks are filtered out. */
const NEIGHBOUR_CANDIDATES = 40;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface LibraryExport {
    etag: string;
    gzipped: Buffer;
}

interface TrackRow {
    id: string;
    title: string;
    duration: number;
    energy: number | null;
    valence: number | null;
    albumId: string;
    albumTitle: string;
    year: number | null;
    artistId: string;
    artistName: string;
    map_x: number;
    map_y: number;
    map_z: number;
}

const MAPPED = Prisma.sql`
    FROM track_embeddings te
    JOIN "Track" t ON t.id = te.track_id
    JOIN "Album" a ON a.id = t."albumId"
    JOIN "Artist" ar ON ar.id = a."artistId"
    WHERE te.map_x IS NOT NULL AND te.map_y IS NOT NULL AND te.map_z IS NOT NULL
      AND a.location = 'LIBRARY' AND t."missingSince" IS NULL
`;

const OWNED_TRACKS = Prisma.sql`
    SELECT COUNT(*) FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
    WHERE a.location = 'LIBRARY' AND t."missingSince" IS NULL
`;

const MOOD_ID_BY_FIELD = new Map<string, string>(MOODS.map((m) => [m.field, m.id]));

let cached: LibraryExport | null = null;
let building: { fingerprint: string; promise: Promise<LibraryExport> } | null = null;

async function fingerprint(moodSignature: string): Promise<string> {
    const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
            COUNT(*) AS n,
            SUM(te.map_x) AS sx, SUM(te.map_y) AS sy, SUM(te.map_z) AS sz,
            MAX(te.analyzed_at) AS embedded,
            MAX(t."updatedAt") AS touched,
            SUM(hashtext(a.title || ar.name || COALESCE(a.year::text, ''))) AS names,
            (${OWNED_TRACKS}) AS total
        ${MAPPED}
    `;
    const raw = JSON.stringify([EXPORT_VERSION, row, moodSignature], (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
    );
    return '"' + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32) + '"';
}

async function nearestNeighbours(ids: string[]): Promise<Map<string, Array<[string, number]>>> {
    const neighbours = new Map<string, Array<[string, number]>>();
    // The planner picks a sequential scan for a library this size; turning it
    // off makes each lookup use the HNSW index (milliseconds instead of ~40ms).
    await prisma.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
            for (let i = 0; i < ids.length; i += NEIGHBOUR_BATCH) {
                const batch = ids.slice(i, i + NEIGHBOUR_BATCH);
                const rows = await tx.$queryRaw<Array<{ id: string; neighbour: string; similarity: number }>>`
                    SELECT a.track_id AS id, n.track_id AS neighbour, n.similarity
                    FROM track_embeddings a
                    CROSS JOIN LATERAL (
                        SELECT c.track_id, c.similarity
                        FROM (
                            SELECT b.track_id, 1 - (b.embedding <=> a.embedding) AS similarity
                            FROM track_embeddings b
                            WHERE b.track_id <> a.track_id
                            ORDER BY b.embedding <=> a.embedding
                            LIMIT ${NEIGHBOUR_CANDIDATES}
                        ) c
                        JOIN track_embeddings ce ON ce.track_id = c.track_id
                        JOIN "Track" ct ON ct.id = c.track_id
                        JOIN "Album" ca ON ca.id = ct."albumId"
                        WHERE ce.map_x IS NOT NULL AND ce.map_y IS NOT NULL AND ce.map_z IS NOT NULL
                          AND ca.location = 'LIBRARY' AND ct."missingSince" IS NULL
                        ORDER BY c.similarity DESC
                        LIMIT ${NEIGHBOURS}
                    ) n
                    WHERE a.track_id = ANY(${batch})
                    ORDER BY a.track_id, n.similarity DESC
                `;
                for (const row of rows) {
                    let list = neighbours.get(row.id);
                    if (!list) neighbours.set(row.id, (list = []));
                    list.push([row.neighbour, round(row.similarity, 4)]);
                }
            }
        },
        { timeout: BUILD_TIMEOUT_MS, maxWait: BUILD_TIMEOUT_MS }
    );
    return neighbours;
}

function libraryId(): string {
    const slug = (config.publicVibe?.username ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return slug || "library";
}

function round(value: number, places: number): number {
    const f = 10 ** places;
    return Math.round(value * f) / f;
}

async function build(etag: string): Promise<LibraryExport> {
    const started = Date.now();
    const { snapshot } = await refreshMoodSnapshot();
    const rows = await prisma.$queryRaw<TrackRow[]>`
        SELECT
            t.id, COALESCE(t."displayTitle", t.title) AS title, t.duration, t.energy, t.valence,
            a.id AS "albumId", a.title AS "albumTitle", a.year,
            ar.id AS "artistId", ar.name AS "artistName",
            te.map_x, te.map_y, te.map_z
        ${MAPPED}
        ORDER BY t.id
    `;
    const [{ total }] = await prisma.$queryRaw<Array<{ total: bigint }>>`SELECT (${OWNED_TRACKS}) AS total`;
    const [{ model }] = await prisma.$queryRaw<Array<{ model: string | null }>>`
        SELECT mode() WITHIN GROUP (ORDER BY model_version) AS model FROM track_embeddings
    `;
    const [{ analyzer }] = await prisma.$queryRaw<Array<{ analyzer: string | null }>>`
        SELECT mode() WITHIN GROUP (ORDER BY "analysisVersion") AS analyzer FROM "Track"
        WHERE "analysisVersion" IS NOT NULL
    `;
    const neighbours = await nearestNeighbours(rows.map((r) => r.id));

    const artists = new Map<string, { id: string; name: string }>();
    const albums = new Map<string, { id: string; artistId: string; title: string; year: number | null }>();
    const tracks = rows.map((r) => {
        artists.set(r.artistId, { id: r.artistId, name: r.artistName });
        albums.set(r.albumId, { id: r.albumId, artistId: r.artistId, title: r.albumTitle, year: r.year });
        const view = snapshot.views.get(r.id);
        const dominant = view && view.dominant !== NEUTRAL && view.dominant !== UNANALYZED
            ? MOOD_ID_BY_FIELD.get(view.dominant) ?? null
            : null;
        return {
            id: r.id,
            title: r.title,
            artistId: r.artistId,
            albumId: r.albumId,
            duration: r.duration,
            xyz: [round(r.map_x, 5), round(r.map_y, 5), round(r.map_z, 5)],
            mood: dominant,
            moods: (view?.moods ?? []).map((f) => MOOD_ID_BY_FIELD.get(f)).filter(Boolean),
            energy: r.energy === null ? null : round(r.energy, 3),
            valence: r.valence === null ? null : round(r.valence, 3),
            neighbours: neighbours.get(r.id) ?? [],
        };
    });

    const body = JSON.stringify({
        version: EXPORT_VERSION,
        computedAt: new Date().toISOString(),
        library: {
            id: libraryId(),
            name: config.publicVibe?.username ?? "",
            engine: { analyzer, embedding: model },
        },
        moods: MOODS.map((m) => ({ id: m.id, name: m.name })),
        artists: [...artists.values()],
        albums: [...albums.values()],
        tracks,
        excluded: Number(total) - tracks.length,
    });
    const gzipped = await gzip(body, { level: 9 });
    logger.info(
        `[PUBLIC-VIBE] library export: ${tracks.length} tracks, ${body.length} bytes, ${gzipped.length} gzipped, ${Date.now() - started}ms`
    );
    return { etag, gzipped };
}

/** The current export, rebuilt once per library change however many callers ask at once. */
export async function getLibraryExport(): Promise<LibraryExport> {
    const { snapshot } = await refreshMoodSnapshot();
    const etag = await fingerprint(snapshot.signature);
    if (cached?.etag === etag) return cached;
    if (building?.fingerprint !== etag) {
        const promise = build(etag).then((result) => {
            cached = result;
            return result;
        });
        building = { fingerprint: etag, promise };
        promise.then(
            () => { if (building?.promise === promise) building = null; },
            () => { if (building?.promise === promise) building = null; }
        );
    }
    return building.promise;
}

