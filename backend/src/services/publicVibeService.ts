/**
 * The public vibe page: joins playback's track ids to the map's x,y and
 * assembles the existing map, similarity and search features for it. No user id
 * comes from the request; the route reads the public user's id from
 * SystemSettings and passes it in.
 */
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import crypto from "crypto";
import { computeMapProjection } from "./umapProjection";

// The shape of the map payload we care about — a track's coordinates and the
// bits needed to draw it. We read by structural access, not by depending on the
// private fields of the projection's own type, so the producer can change.
interface MapPoint {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    albumId: string;
    coverUrl: string | null;
}

// A queued track, whatever shape the client wrote it in. We only read the id
// (to join to the map) and the title/artist the row already carried forward.
interface QueueItem {
    id: string;
    title?: string;
    artist?: { id?: string; name: string } | null;
}

interface PlaybackRow {
    playbackType: string | null;
    trackId: string | null;
    queue: QueueItem[] | null;
    currentIndex: number;
    position: number;
    updatedAt: Date;
}

const LIVE_CACHE_TTL_SECONDS = 2;
const MAX_QUEUE_ITEMS = 500;
const MAX_MAP_POINTS = 2000;

// Only a real track plays to a point on the 2D map. An audiobook or podcast
// plays, but there is no axis for it, so the queue and context still follow a
// plain track queue and "now playing" is null for these.
const PLAYABLE_TYPE = "track";

// A `native:<albumId>.jpg` cover points at a server file and must never reach
// a client, so it becomes a public proxy URL; remote http URLs pass through.
function toPublicCoverUrl(mapUrl: string | null, trackId: string): string | null {
    if (mapUrl && mapUrl.startsWith("native:")) {
        return `/api/public/vibe/cover/${encodeURIComponent(trackId)}`;
    }
    return mapUrl;
}

// Swap every coverUrl in a point object to its public proxy form, if it is one.
function toPublicCover(trackId: string, track: MapPoint): MapPoint {
    return { ...track, coverUrl: toPublicCoverUrl(track.coverUrl, trackId) };
}

// Swap every coverUrl across a point list. (Handled in-place by asMapPoints.)

// The map is 3-D, the public page 2-D: project onto the cloud's two widest
// principal axes so clusters apart only in depth stay apart, then scale to
// 0..1. Cached per projection version.
let flatMemo: { key: string; points: Map<string, { x: number; y: number }> } | null = null;

function flatten(tracks: Array<{ id: string; x: number; y: number; z?: number }>): Map<string, { x: number; y: number }> {
    const n = tracks.length;
    const mean = [0, 0, 0];
    for (const t of tracks) { mean[0] += t.x; mean[1] += t.y; mean[2] += t.z ?? 0.5; }
    mean.forEach((_, a) => { mean[a] /= Math.max(1, n); });
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const t of tracks) {
        const d = [t.x - mean[0], t.y - mean[1], (t.z ?? 0.5) - mean[2]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
    }
    const mul = (v: number[]) => cov.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
    const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((c) => c / l); };
    // Power iteration for the widest axis, then again with it deflated away.
    let a = norm([1, 0.3, 0.2]);
    for (let k = 0; k < 64; k++) a = norm(mul(a));
    let b = norm([0.2, 1, 0.3]);
    for (let k = 0; k < 64; k++) {
        b = mul(b);
        const dot = b[0] * a[0] + b[1] * a[1] + b[2] * a[2];
        b = norm([b[0] - dot * a[0], b[1] - dot * a[1], b[2] - dot * a[2]]);
    }
    const u = tracks.map((t) => (t.x - mean[0]) * a[0] + (t.y - mean[1]) * a[1] + ((t.z ?? 0.5) - mean[2]) * a[2]);
    const v = tracks.map((t) => (t.x - mean[0]) * b[0] + (t.y - mean[1]) * b[1] + ((t.z ?? 0.5) - mean[2]) * b[2]);
    const span = (xs: number[]) => { let lo = Infinity, hi = -Infinity; for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; } return [lo, hi - lo || 1]; };
    const [u0, ur] = span(u);
    const [v0, vr] = span(v);
    return new Map(tracks.map((t, i) => [t.id, { x: (u[i] - u0) / ur, y: (v[i] - v0) / vr }]));
}

function asMapPoints(projection: any): MapPoint[] {
    const tracks = (projection?.tracks ?? []) as unknown[];
    const points = tracks.filter(
        (t): t is MapPoint =>
            !!t &&
            typeof (t as Record<string, unknown>).x === "number" &&
            typeof (t as Record<string, unknown>).y === "number",
    );
    const threeD = points.some((p) => typeof (p as MapPoint & { z?: unknown }).z === "number");
    if (!threeD) return points.map((t) => toPublicCover(t.id, t));
    const key = `${projection?.computedAt ?? ""}:${points.length}`;
    if (flatMemo?.key !== key) flatMemo = { key, points: flatten(points as Array<MapPoint & { z?: number }>) };
    const flat = flatMemo.points;
    return points.map((t) => {
        const f = flat.get(t.id);
        const { z: _z, ...rest } = t as MapPoint & { z?: number };
        return toPublicCover(t.id, f ? { ...rest, x: f.x, y: f.y } : rest);
    });
}

// Deterministic cap: keep the first N, drop the rest, by stored-id order. The
// map id set changes slowly, so slicing the same way every time gives the site
// a stable frame, not reshuffled points.
function decimate(points: MapPoint[], maxPoints: number): MapPoint[] {
    if (points.length <= maxPoints) return points;
    return points.slice(0, maxPoints);
}

async function lookupIds(ids: string[], points: MapPoint[]): Promise<MapPoint[]> {
    const wanted = new Set(ids);
    return points.filter((p) => wanted.has(p.id));
}

// Which index is playing, clamped to the (possibly capped) queue. A missing or
// negative index falls back to the front.
function clampQueueIndex(current: number, length: number): number {
    if (!Number.isFinite(current)) return 0;
    return Math.min(Math.max(0, Math.floor(current)), Math.max(0, length - 1));
}

// The stored queue is playback order. The item at the current index is what is
// playing; everything after it is queued. If the index points past the end the
// queue is exhausted ahead of now.
function splitQueue(
    queue: readonly QueueItem[] | null,
    currentIndex: number,
): { nowId: string | null; queued: QueueItem[] } {
    if (!queue || queue.length === 0) {
        return { nowId: null, queued: [] };
    }
    const length = Math.min(queue.length, MAX_QUEUE_ITEMS);
    const clamped = clampQueueIndex(currentIndex, length);
    return {
        nowId: queue[clamped]?.id ?? null,
        queued: queue.slice(clamped + 1),
    };
}

/**
 * The public user's playing point, joined to the map. `null` is a normal
 * response (idle), never an error. Any failure to read the map or playback is
 * likewise reported as "nothing playing" rather than thrown, so the site never
 * renders a failure before the operator has anything public to show.
 */
export async function getPublicLive(
    publicUserId: string,
    maxPoints: number = MAX_MAP_POINTS,
): Promise<{
    nowPlaying: {
        trackId: string;
        x: number;
        y: number;
        title: string;
        artist: string;
        coverUrl: string | null;
        position: number;
        duration: number;
    } | null;
}> {
    let playback: PlaybackRow | null = null;
    try {
        const row = await prisma.playbackState.findUnique({
            where: { userId: publicUserId },
        });
        if (row) playback = row as unknown as PlaybackRow;
    } catch (e) {
        logger.warn("[PUBLIC-VIBE] playback read failed:", (e as Error).message);
        return { nowPlaying: null };
    }

    if (!playback) return { nowPlaying: null };

    // A non-track playback has no point on the 2D map.
    if (playback.playbackType !== PLAYABLE_TYPE || !playback.trackId) {
        return { nowPlaying: null };
    }

    try {
        const projection = await computeMapProjection();
        const points = decimate(asMapPoints(projection), maxPoints);
        const [playing] = await lookupIds([playback.trackId], points);
        if (!playing) return { nowPlaying: null };
        return {
            nowPlaying: {
                trackId: playing.id,
                x: playing.x,
                y: playing.y,
                title: playing.title,
                artist: playing.artist,
                coverUrl: playing.coverUrl,
                position: playback.position,
                duration: 0, // duration is not stored in PlaybackState
            },
        };
    } catch (e) {
        logger.warn("[PUBLIC-VIBE] map read failed:", (e as Error).message);
        return { nowPlaying: null };
    }
}

/**
 * The queued tracks, joined to the map, in playback order and indexed from 0.
 * A queued track not on the map (not analysed, or above the cap) is dropped;
 * the site draws a line through the points it did resolve.
 */
export async function getPublicQueue(
    publicUserId: string,
    maxPoints: number = MAX_MAP_POINTS,
): Promise<
    {
        index: number;
        trackId: string;
        x: number;
        y: number;
        title: string;
        artist: string;
        coverUrl: string | null;
    }[]
> {
    let playback: PlaybackRow | null = null;
    try {
        const row = await prisma.playbackState.findUnique({
            where: { userId: publicUserId },
        });
        if (row) playback = row as unknown as PlaybackRow;
    } catch (e) {
        logger.warn("[PUBLIC-VIBE] playback read failed:", (e as Error).message);
        return [];
    }
    if (!playback) return [];

    const projection = await computeMapProjection();
    const points = decimate(asMapPoints(projection), maxPoints);
    const { queued } = splitQueue(
        playback.queue as QueueItem[] | null,
        playback.currentIndex,
    );

    const ids = queued.map((q) => q.id).filter(Boolean);
    const found = await lookupIds(ids, points);
    const seen = new Set<string>();
    const out: {
        index: number;
        trackId: string;
        x: number;
        y: number;
        title: string;
        artist: string;
        coverUrl: string | null;
    }[] = [];
    for (const q of queued) {
        const p = found.find((r) => r.id === q.id && !seen.has(r.id));
        if (!p) continue;
        seen.add(p.id);
        out.push({
            index: out.length,
            trackId: p.id,
            x: p.x,
            y: p.y,
            title: p.title,
            artist: p.artist,
            coverUrl: p.coverUrl,
        });
    }
    return out;
}

/**
 * The full map payload, capped to the operator's public ceiling. The map is the
 * largest payload on the site, so we trim deterministically (first N by stored
 * id order) and say in the envelope exactly how many points remain and how many
 * were dropped, so the site can decide to redraw rather than hide the gap.
 */
export async function getPublicMap(
    maxPoints: number = MAX_MAP_POINTS,
): Promise<{
    tracks: MapPoint[];
    trackCount: number;
    fullCount: number;
    sampled: boolean;
    sampledNote?: string;
    computedAt: string;
}> {
    const projection = await computeMapProjection();
    const all = asMapPoints(projection);
    const limited = decimate(all, maxPoints);
    const sampled = all.length > maxPoints;
    return {
        tracks: limited,
        trackCount: limited.length,
        fullCount: all.length,
        sampled,
        ...(sampled
            ? {
                  sampledNote: `Limited to ${limited.length} of ${
                      all.length
                  } tracks (public map cap ${maxPoints}).`,
              }
            : {}),
        // Deterministic stamp: derived from the payload, not the clock. A clock
        // stamp made every /map response unique, which defeated the route's
        // If-None-Match 304 revalidation (the etag changed on every request).
        computedAt: derivePayloadStamp(limited),
    };
}

// Two-second edge cache of the live payload, keyed only on the public user.
// Within the window a second read returns the first, so the route does not
// re-join the map more often than the operator likely intended.
interface LiveCacheEntry {
    nowPlaying: NonNullable<{
        trackId: string;
        x: number;
        y: number;
        title: string;
        artist: string;
        coverUrl: string | null;
        position: number;
        duration: number;
    }>;
    cacheAt: number;
}

const liveCache = new Map<string, LiveCacheEntry>();

export async function getPublicLiveCached(
    publicUserId: string,
    maxPoints: number = MAX_MAP_POINTS,
): Promise<{
    nowPlaying: {
        trackId: string;
        x: number;
        y: number;
        title: string;
        artist: string;
        coverUrl: string | null;
        position: number;
        duration: number;
    } | null;
}> {
    const key = `vibe:map:v3:live:${publicUserId}`;

    const cached = liveCache.get(key);
    const fresh = !!cached && Date.now() - cached.cacheAt < LIVE_CACHE_TTL_SECONDS * 1000;
    if (fresh) {
        return { nowPlaying: cached.nowPlaying };
    }

    const value = await getPublicLive(publicUserId, maxPoints);
    if (value.nowPlaying) {
        liveCache.set(key, { nowPlaying: value.nowPlaying, cacheAt: Date.now() });
    }
    return value;
}

// Stable digest of the point list — same tracks, same stamp.
function derivePayloadStamp(points: MapPoint[]): string {
    const json = JSON.stringify(points.map((p) => [p.id, p.x, p.y]));
    return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}
