import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { findSimilarTracks } from "../services/hybridSimilarity";
import { getMapProjectionState } from "../services/umapProjection";
import { generateSongPath } from "../services/songPath";
import { parseEmbedding } from "../utils/embedding";
import { searchTracksByText } from "../services/textEmbeddingBridge";
import { efFor, withEfSearch } from "../utils/knn";

const router = Router();
const gzipAsync = promisify(gzip);

const CUID_RE = /^c[a-z0-9]{20,30}$/;

function sanitizeForLog(s: string): string {
    return s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
}

// A large library's map is tens of megabytes of JSON that compresses ~8x, and
// the app has no global compression middleware. Gzip it here, once per
// computed map (keyed by computedAt), not once per request.
let gzippedMap: { key: string; body: Buffer } | null = null;
async function sendMapJson(req: Request, res: Response, mapData: { computedAt?: string }) {
    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    if (!acceptsGzip) {
        res.json(mapData);
        return;
    }
    const key = `${mapData.computedAt ?? ""}:${(mapData as { trackCount?: number }).trackCount ?? 0}`;
    if (gzippedMap?.key !== key) {
        gzippedMap = { key, body: await gzipAsync(Buffer.from(JSON.stringify(mapData))) };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.send(gzippedMap.body);
}

/**
 * GET /api/vibe/map
 * Returns UMAP 2D projections for all tracks with embeddings.
 * Cached in Redis, invalidated when embedding count changes.
 *
 * DESIGN-INFRA MOCK: when MOCK_VIBE_MAP is set to a JSON file (a snapshot
 * of a real instance's /api/vibe/map response), serve it verbatim instead
 * of computing. This exists so the galaxy scene can be designed against the
 * REAL embedded data on the testbed without touching any real
 * database. Off by default — unset env = original behaviour. Never point it
 * at committed data: the snapshot lives outside the repo and must not be
 * committed (it is the operator's private library).
 */
router.get("/map", requireAuth, async (req, res) => {
    try {
        const mockPath = process.env.MOCK_VIBE_MAP;
        if (mockPath && fs.existsSync(mockPath)) {
            res.json(JSON.parse(fs.readFileSync(mockPath, "utf8")));
            return;
        }
        const state = await getMapProjectionState();
        if (state.status === "computing") {
            // First layout of a large library: answer now, the client polls.
            res.status(202).json({ computing: true });
            return;
        }
        if (state.status === "failed") {
            logger.error("Vibe map computation failed:", state.message);
            res.status(500).json({ error: "Failed to compute map projection" });
            return;
        }
        await sendMapJson(req, res, state.data);
    } catch (error) {
        logger.error("Vibe map error:", error);
        res.status(500).json({ error: "Failed to compute map projection" });
    }
});

/**
 * POST /api/vibe/path
 * Generate a smooth musical journey between two tracks.
 */
router.post("/path", requireAuth, async (req, res) => {
    try {
        const { startTrackId, endTrackId, length, mode } = req.body;

        if (!startTrackId || !endTrackId || typeof startTrackId !== "string" || typeof endTrackId !== "string") {
            return res.status(400).json({ error: "startTrackId and endTrackId are required strings" });
        }

        if (!CUID_RE.test(startTrackId) || !CUID_RE.test(endTrackId)) {
            return res.status(400).json({ error: "Invalid track ID format" });
        }

        if (startTrackId === endTrackId) {
            return res.status(400).json({ error: "Start and end tracks must be different" });
        }

        const result = await generateSongPath(startTrackId, endTrackId, {
            length: length ? Math.max(5, Math.min(50, length)) : undefined,
            mode: mode === "discovery" ? "discovery" : "smooth",
        });

        res.json(result);
    } catch (error) {
        if (error instanceof Error && error.message === "TRACKS_TOO_SIMILAR") {
            return res.status(400).json({
                error: "These tracks are too similar for a meaningful journey. Try \"Similar Tracks\" instead.",
            });
        }
        logger.error("Song path error:", error);
        res.status(500).json({ error: "Failed to generate song path" });
    }
});

/**
 * POST /api/vibe/alchemy
 * Vector arithmetic playlist generation.
 * Computes: mean(add_embeddings) - mean(subtract_embeddings), finds nearest tracks.
 */
router.post("/alchemy", requireAuth, async (req, res) => {
    try {
        const { add, subtract, limit: requestedLimit } = req.body;

        if (!add || !Array.isArray(add) || add.length === 0) {
            return res.status(400).json({ error: "At least one track ID in 'add' is required" });
        }

        if (add.length > 10) {
            return res.status(400).json({ error: "'add' may contain at most 10 tracks" });
        }

        if (subtract && (!Array.isArray(subtract) || subtract.length > 10)) {
            return res.status(400).json({ error: "'subtract' must be an array of at most 10 tracks" });
        }

        if (!add.every((id: unknown) => typeof id === "string" && CUID_RE.test(id))) {
            return res.status(400).json({ error: "'add' must contain valid track IDs" });
        }

        if (subtract && !subtract.every((id: unknown) => typeof id === "string" && CUID_RE.test(id))) {
            return res.status(400).json({ error: "'subtract' must contain valid track IDs" });
        }

        const limit = Math.min(Math.max(1, requestedLimit || 20), 100);
        const allInputIds = [...add, ...(subtract || [])];

        // Fetch embeddings for all input tracks
        const embeddings = await prisma.$queryRaw<Array<{
            track_id: string;
            embedding: string;
        }>>`
            SELECT track_id, embedding::text as embedding
            FROM track_embeddings
            WHERE track_id = ANY(${allInputIds})
        `;

        const embMap = new Map<string, number[]>();
        for (const row of embeddings) {
            embMap.set(row.track_id, parseEmbedding(row.embedding));
        }

        // Verify all requested tracks have embeddings
        const missingAdd = add.filter((id: string) => !embMap.has(id));
        const missingSubtract = (subtract || []).filter((id: string) => !embMap.has(id));
        if (missingAdd.length > 0 || missingSubtract.length > 0) {
            return res.status(400).json({
                error: "Some tracks are missing CLAP embeddings",
                missingAdd,
                missingSubtract,
            });
        }

        // Compute: mean(add) - mean(subtract)
        const dim = embMap.get(add[0])!.length;
        const result = new Array(dim).fill(0);

        for (const id of add) {
            const emb = embMap.get(id)!;
            for (let i = 0; i < dim; i++) result[i] += emb[i] / add.length;
        }

        if (subtract && subtract.length > 0) {
            for (const id of subtract) {
                const emb = embMap.get(id)!;
                for (let i = 0; i < dim; i++) result[i] -= emb[i] / subtract.length;
            }
        }

        // L2 normalize
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += result[i] * result[i];
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < dim; i++) result[i] /= norm;
        }

        // Query for nearest tracks, excluding inputs. S1: the HNSW index walks
        // hnsw.ef_search candidates (default 40) and the input exclusions are
        // applied AFTER the walk, so each input also eats one of those 40
        // candidates -- size the width from the limit plus the input count and
        // run the query on the transaction's own connection.
        const tracks = await withEfSearch(efFor(limit, allInputIds.length), (tx) =>
            tx.$queryRaw<Array<{
                id: string;
                title: string;
                duration: number;
                distance: number;
                albumId: string;
                albumTitle: string;
                albumCoverUrl: string | null;
                artistId: string;
                artistName: string;
            }>>`
                SELECT
                    t.id, t.title, t.duration,
                    te.embedding <=> ${result}::vector AS distance,
                    a.id as "albumId", a.title as "albumTitle", a."coverUrl" as "albumCoverUrl",
                    ar.id as "artistId", ar.name as "artistName"
                FROM track_embeddings te
                JOIN "Track" t ON te.track_id = t.id
                JOIN "Album" a ON t."albumId" = a.id
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE te.track_id != ALL(${allInputIds})
                ORDER BY te.embedding <=> ${result}::vector
                LIMIT ${limit}
            `,
        );

        res.json({
            tracks: tracks.map(t => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                distance: t.distance,
                similarity: distanceToSimilarity(t.distance),
                album: { id: t.albumId, title: t.albumTitle, coverUrl: t.albumCoverUrl },
                artist: { id: t.artistId, name: t.artistName },
            })),
        });
    } catch (error) {
        logger.error("Alchemy error:", error);
        res.status(500).json({ error: "Failed to compute alchemy blend" });
    }
});

/**
 * GET /api/vibe/similar/:trackId
 * Find tracks similar to a given track using hybrid similarity (CLAP + audio features)
 */
router.get("/similar/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;
        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit as string) || 20),
            100
        );

        const tracks = await findSimilarTracks(trackId, limit);

        if (tracks.length === 0) {
            return res.status(404).json({
                error: "No similar tracks found",
                message: "This track may not have been analyzed yet, or no analyzer is running",
            });
        }

        res.json({
            sourceTrackId: trackId,
            tracks: tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                distance: t.distance,
                similarity: t.similarity,
                album: {
                    id: t.albumId,
                    title: t.albumTitle,
                    coverUrl: t.albumCoverUrl,
                },
                artist: {
                    id: t.artistId,
                    name: t.artistName,
                },
            })),
        });
    } catch (error) {
        logger.error("Hybrid similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

// Convert pgvector cosine distance to similarity (0-1)
// distance 0 = identical, distance 1 = orthogonal, distance 2 = opposite
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance);
}

/**
 * POST /api/vibe/search
 * Search for tracks using natural language text via CLAP text embeddings.
 * Returns the nearest `limit` tracks, best first, with no similarity cut-off
 * (see searchTracksByText for why a fixed or per-query floor does not work).
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        if (query.length > 500) {
            return res.status(400).json({
                error: "Query must be at most 500 characters",
            });
        }

        const limit = Math.min(
            Math.max(1, requestedLimit || 20),
            100
        );

        const trimmedQuery = query.trim();
        const rows = await searchTracksByText(trimmedQuery, limit);

        logger.debug(`[VIBE-SEARCH] "${sanitizeForLog(trimmedQuery)}": ${rows.length} tracks, top: ${rows[0]?.title || "none"}`);

        res.json({
            query: trimmedQuery,
            tracks: rows.map((row) => ({
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo: row.trackNo,
                distance: row.distance,
                similarity: distanceToSimilarity(row.distance),
                album: {
                    id: row.albumId,
                    title: row.albumTitle,
                    coverUrl: row.albumCoverUrl,
                },
                artist: {
                    id: row.artistId,
                    name: row.artistName,
                },
            })),
        });
    } catch (error) {
        logger.error("Vibe text search error:", error);
        if (error instanceof Error && error.message.includes("timed out")) {
            return res.status(504).json({
                error: "Text embedding service unavailable",
                message: "The CLAP analyzer service did not respond in time",
            });
        }
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * GET /api/vibe/status
 * Get embedding analysis progress statistics
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const totalTracks = await prisma.track.count();

        const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;

        const embeddedCount = Number(embeddedTracks[0]?.count || 0);
        const progress = totalTracks > 0
            ? Math.round((embeddedCount / totalTracks) * 100)
            : 0;

        res.json({
            totalTracks,
            embeddedTracks: embeddedCount,
            progress,
            isComplete: embeddedCount >= totalTracks && totalTracks > 0,
        });
    } catch (error) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

export default router;
