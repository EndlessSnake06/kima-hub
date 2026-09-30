import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";
import { efFor, withEfSearch } from "../utils/knn";

const MIN_PATH_DISTANCE = 0.15;

interface PathTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

interface PathResult {
    startTrack: PathTrack;
    endTrack: PathTrack;
    path: PathTrack[];
    metadata: {
        totalTracks: number;
        embeddingDistance: number;
        averageStepSize: number;
        mode: string;
    };
}

/**
 * A path between two tracks: waypoints interpolated between their CLAP
 * embeddings (more for distant pairs), each filled by the nearest unvisited
 * track, with an artist diversity filter.
 */
export async function generateSongPath(
    startTrackId: string,
    endTrackId: string,
    options: { length?: number; mode?: "smooth" | "discovery" } = {}
): Promise<PathResult> {
    const mode = options.mode || "smooth";

    const [startInfo, endInfo] = await Promise.all([
        getTrackInfo(startTrackId),
        getTrackInfo(endTrackId),
    ]);

    if (!startInfo || !endInfo) {
        throw new Error("One or both tracks not found or missing embeddings");
    }

    const [startEmb, endEmb] = await Promise.all([
        getEmbedding(startTrackId),
        getEmbedding(endTrackId),
    ]);

    if (!startEmb || !endEmb) {
        throw new Error("One or both tracks missing CLAP embeddings. Run vibe analysis first.");
    }

    const distance = cosineDistance(startEmb, endEmb);

    if (distance < MIN_PATH_DISTANCE) {
        throw new Error("TRACKS_TOO_SIMILAR");
    }

    const numWaypoints = options.length || Math.max(8, Math.min(50, Math.round(distance * 15)));

    logger.info(`[SONG-PATH] Generating ${mode} path: ${numWaypoints} waypoints, distance=${distance.toFixed(3)}`);

    const waypoints: number[][] = [];
    for (let i = 1; i <= numWaypoints; i++) {
        waypoints.push(interpolateEmbeddings(startEmb, endEmb, i / (numWaypoints + 1)));
    }

    const BATCH_SIZE = 10;
    const candidateLimit = mode === "discovery" ? 10 : 8;
    const visitedIds = new Set<string>([startTrackId, endTrackId]);
    const path: PathTrack[] = [];
    let totalStepSize = 0;

    for (let batchStart = 0; batchStart < waypoints.length; batchStart += BATCH_SIZE) {
        const batch = waypoints.slice(batchStart, Math.min(batchStart + BATCH_SIZE, waypoints.length));
        const candidates = await fetchBatchCandidates(batch, visitedIds, candidateLimit);

        for (let i = 0; i < batch.length; i++) {
            const waypointCandidates = candidates
                .filter(c => c.waypointIndex === i && !visitedIds.has(c.id))
                .sort((a, b) => a.distance - b.distance);

            if (waypointCandidates.length === 0) continue;

            const pickIndex = mode === "discovery"
                ? Math.floor(Math.random() * Math.min(3, waypointCandidates.length))
                : 0;
            let selected = waypointCandidates[pickIndex];

            if (path.length >= 2) {
                const prev1 = path[path.length - 1];
                const prev2 = path[path.length - 2];
                if (prev1.artistId === prev2.artistId && selected.artistId === prev1.artistId) {
                    const threshold = waypointCandidates[0].distance * 1.05;
                    const alt = waypointCandidates.find(
                        c => c.artistId !== prev1.artistId && c.distance <= threshold && !visitedIds.has(c.id)
                    );
                    if (alt) selected = alt;
                }
            }

            visitedIds.add(selected.id);
            totalStepSize += selected.distance;
            path.push({
                id: selected.id,
                title: selected.title,
                duration: selected.duration,
                albumId: selected.albumId,
                albumTitle: selected.albumTitle,
                albumCoverUrl: selected.albumCoverUrl,
                artistId: selected.artistId,
                artistName: selected.artistName,
            });
        }
    }

    return {
        startTrack: startInfo,
        endTrack: endInfo,
        path,
        metadata: {
            totalTracks: path.length + 2,
            embeddingDistance: distance,
            averageStepSize: path.length > 0 ? totalStepSize / path.length : 0,
            mode,
        },
    };
}

interface CandidateTrack extends PathTrack {
    waypointIndex: number;
    distance: number;
}

async function fetchBatchCandidates(
    waypoints: number[][],
    excludeIds: Set<string>,
    candidatesPerWaypoint: number
): Promise<CandidateTrack[]> {
    const excluded = Array.from(excludeIds);

    // Exclusions eat HNSW candidates, so one transaction per batch (<= 10
    // waypoints) sizes ef_search from the per-waypoint limit plus the visited count.
    return withEfSearch(
        efFor(candidatesPerWaypoint, excluded.length),
        async (tx) => {
            const results: CandidateTrack[] = [];
            for (const [idx, emb] of waypoints.entries()) {
                const rows = await tx.$queryRaw<Array<PathTrack & { distance: number }>>`
                    SELECT
                        t.id,
                        t.title,
                        t.duration,
                        a.id as "albumId",
                        a.title as "albumTitle",
                        a."coverUrl" as "albumCoverUrl",
                        ar.id as "artistId",
                        ar.name as "artistName",
                        te.embedding <=> ${emb}::vector AS distance
                    FROM track_embeddings te
                    JOIN "Track" t ON te.track_id = t.id
                    JOIN "Album" a ON t."albumId" = a.id
                    JOIN "Artist" ar ON a."artistId" = ar.id
                    WHERE te.track_id != ALL(${excluded})
                    ORDER BY te.embedding <=> ${emb}::vector
                    LIMIT ${candidatesPerWaypoint}
                `;
                results.push(...rows.map(r => ({ ...r, waypointIndex: idx })));
            }
            return results;
        },
    );
}

async function getTrackInfo(trackId: string): Promise<PathTrack | null> {
    const result = await prisma.$queryRaw<PathTrack[]>`
        SELECT
            t.id, t.title, t.duration,
            a.id as "albumId", a.title as "albumTitle", a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId", ar.name as "artistName"
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t.id = ${trackId}
    `;
    return result[0] || null;
}

async function getEmbedding(trackId: string): Promise<number[] | null> {
    const result = await prisma.$queryRaw<Array<{ embedding: string }>>`
        SELECT embedding::text as embedding FROM track_embeddings WHERE track_id = ${trackId}
    `;
    if (!result[0]) return null;
    return parseEmbedding(result[0].embedding);
}

function cosineDistance(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 2;
    return 1 - (dot / denom);
}

/**
 * Spherical linear interpolation (SLERP) between two unit vectors.
 * Produces uniform spacing along the great circle connecting start and end,
 * which is correct for cosine-distance-indexed embeddings.
 * Falls back to LERP + normalize for near-parallel vectors where SLERP is numerically unstable.
 */
function interpolateEmbeddings(start: number[], end: number[], t: number): number[] {
    let dot = 0;
    for (let i = 0; i < start.length; i++) dot += start[i] * end[i];
    dot = Math.max(-1, Math.min(1, dot));

    const theta = Math.acos(dot);

    // For near-parallel vectors, fall back to LERP + normalize
    if (theta < 1e-6) {
        const result = new Array(start.length);
        for (let i = 0; i < start.length; i++) {
            result[i] = start[i] + (end[i] - start[i]) * t;
        }
        let norm = 0;
        for (let i = 0; i < result.length; i++) norm += result[i] * result[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < result.length; i++) result[i] /= norm;
        return result;
    }

    const sinTheta = Math.sin(theta);
    const w0 = Math.sin((1 - t) * theta) / sinTheta;
    const w1 = Math.sin(t * theta) / sinTheta;

    const result = new Array(start.length);
    for (let i = 0; i < start.length; i++) {
        result[i] = w0 * start[i] + w1 * end[i];
    }
    return result;
}
