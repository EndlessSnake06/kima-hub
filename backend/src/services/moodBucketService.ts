/**
 * A track's moods from five Essentia heads: happy (Upbeat), sad (Melancholic), relaxed (Calm), aggressive (Intense),
 * party (Energetic). A track has a mood when its head gives P > 0.5, whatever else the library holds; library rank is
 * display only (the dominant label, map colouring), never membership. Buckets rebuild when the analysed library changes.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { shuffleArray } from "../utils/shuffle";
import { NOT_MISSING } from "../utils/libraryEligibility";

// The heads' own lean: strictly more likely than not (two-class softmax
// argmax), not a tuned value. Exactly 0.5 is the model not leaning either
// way, so it carries no mood. It stops a dirge-heavy library from labelling
// its least-gloomy tracks "Upbeat": a dirge scores ~0.2.
const HEAD_DECISION = 0.5;

export const MOODS = [
    { id: "happy", field: "moodHappy", name: "Upbeat", color: "from-yellow-400 to-orange-500", icon: "Smile" },
    { id: "sad", field: "moodSad", name: "Melancholic", color: "from-blue-600 to-indigo-700", icon: "CloudRain" },
    { id: "chill", field: "moodRelaxed", name: "Calm", color: "from-teal-400 to-cyan-500", icon: "Wind" },
    { id: "aggressive", field: "moodAggressive", name: "Intense", color: "from-red-700 to-gray-900", icon: "Flame" },
    { id: "party", field: "moodParty", name: "Energetic", color: "from-pink-500 to-rose-600", icon: "PartyPopper" },
] as const;

export type MoodType = (typeof MOODS)[number]["id"];
export type MoodField = (typeof MOODS)[number]["field"];
export const VALID_MOODS: MoodType[] = MOODS.map((m) => m.id);
const MOOD_FIELDS: MoodField[] = MOODS.map((m) => m.field);

/** Analysed, but no mood stands out for this track. */
export const NEUTRAL = "neutral";
/** Mood values not written yet (analysis pending or failed). */
export const UNANALYZED = "unanalyzed";

const MOOD_BY_ID: Record<MoodType, (typeof MOODS)[number]> = Object.fromEntries(
    MOODS.map((m) => [m.id, m])
) as Record<MoodType, (typeof MOODS)[number]>;

// Mood gradient colors for mix display
const MOOD_GRADIENTS: Record<MoodType, string> = {
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    sad: "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    party: "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",
    aggressive:
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",
};

export type MoodValues = { [F in MoodField]: number | null };

export interface MoodView {
    /** A MoodField, NEUTRAL, or UNANALYZED. */
    dominant: string;
    /** Library rank (0..1) of the dominant mood; 0 for NEUTRAL / UNANALYZED. */
    score: number;
    /** Library rank (0..1) per mood; empty when UNANALYZED. */
    ranks: Partial<Record<MoodField, number>>;
    /** Every mood the track has (head says yes). */
    moods: MoodField[];
}

function lowerBound(sorted: Float64Array, v: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function upperBound(sorted: Float64Array, v: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] <= v) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Each mood's sorted library values, for ranking a value within the library. */
export class MoodDistribution {
    private readonly sorted: Record<MoodField, Float64Array>;
    readonly size: number;

    constructor(rows: MoodValues[]) {
        const complete = rows.filter(isAnalysed);
        this.size = complete.length;
        this.sorted = Object.fromEntries(
            MOOD_FIELDS.map((f) => [
                f,
                Float64Array.from(complete.map((r) => r[f] as number)).sort(),
            ])
        ) as Record<MoodField, Float64Array>;
    }

    /** Share of the library below v on this mood, counting ties as half. */
    rank(field: MoodField, v: number): number {
        const s = this.sorted[field];
        if (s.length === 0) return 0;
        return (lowerBound(s, v) + upperBound(s, v)) / 2 / s.length;
    }
}

function isAnalysed(row: MoodValues): boolean {
    return MOOD_FIELDS.every((f) => row[f] !== null && row[f] !== undefined);
}

/** Decide a track's moods against its library. Pure. */
export function classifyMoods(row: MoodValues, dist: MoodDistribution): MoodView {
    if (!isAnalysed(row) || dist.size === 0) {
        return { dominant: UNANALYZED, score: 0, ranks: {}, moods: [] };
    }
    const ranks: Partial<Record<MoodField, number>> = {};
    const moods: MoodField[] = [];
    let dominant: string = NEUTRAL;
    let score = 0;
    for (const f of MOOD_FIELDS) {
        const value = row[f] as number;
        const r = dist.rank(f, value);
        ranks[f] = r;
        if (value > HEAD_DECISION) {
            moods.push(f);
            if (r > score) {
                dominant = f;
                score = r;
            }
        }
    }
    return { dominant, score, ranks, moods };
}

export interface MoodSnapshot {
    /** Changes whenever the analysed library changes. */
    signature: string;
    views: Map<string, MoodView>;
    /** Tracks still waiting for mood values. */
    pending: number;
}

let snapshot: MoodSnapshot | null = null;
let building: Promise<MoodSnapshot> | null = null;

async function librarySignature(): Promise<{ signature: string; pending: number }> {
    const rows = await prisma.$queryRaw<
        Array<{ analysed: bigint; pending: bigint; latest: Date | null }>
    >`
        SELECT
            COUNT(*) FILTER (WHERE "analysisStatus" = 'completed' AND "moodHappy" IS NOT NULL
                AND "moodSad" IS NOT NULL AND "moodRelaxed" IS NOT NULL
                AND "moodAggressive" IS NOT NULL AND "moodParty" IS NOT NULL) AS analysed,
            COUNT(*) FILTER (WHERE "analysisStatus" IN ('pending', 'queued', 'processing')) AS pending,
            MAX("analyzedAt") AS latest
        FROM "Track"
        WHERE "missingSince" IS NULL
    `;
    const r = rows[0];
    return {
        signature: `${r?.analysed ?? 0}:${r?.latest?.toISOString() ?? ""}`,
        pending: Number(r?.pending ?? 0),
    };
}

async function buildSnapshot(signature: string, pending: number): Promise<MoodSnapshot> {
    const rows = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            moodHappy: { not: null },
            moodSad: { not: null },
            moodRelaxed: { not: null },
            moodAggressive: { not: null },
            moodParty: { not: null },
            ...NOT_MISSING,
        },
        select: {
            id: true,
            moodHappy: true,
            moodSad: true,
            moodRelaxed: true,
            moodAggressive: true,
            moodParty: true,
        },
    });
    const dist = new MoodDistribution(rows);
    const views = new Map<string, MoodView>();
    for (const row of rows) {
        views.set(row.id, classifyMoods(row, dist));
    }
    return { signature, views, pending };
}

/**
 * The current library's mood decisions. Re-reads the library only when its
 * signature changed; `changed` says whether this call rebuilt it.
 */
export async function refreshMoodSnapshot(): Promise<{ snapshot: MoodSnapshot; changed: boolean }> {
    const { signature, pending } = await librarySignature();
    if (snapshot && snapshot.signature === signature) {
        snapshot.pending = pending;
        return { snapshot, changed: false };
    }
    if (!building) {
        building = buildSnapshot(signature, pending).finally(() => {
            building = null;
        });
    }
    snapshot = await building;
    return { snapshot, changed: true };
}

/**
 * The last built snapshot (the mood bucket worker refreshes it every cycle),
 * or a fresh one if none exists yet. For read paths that must not query the
 * library on every request.
 */
export async function currentMoodSnapshot(): Promise<MoodSnapshot> {
    if (snapshot) return snapshot;
    return (await refreshMoodSnapshot()).snapshot;
}

/** Map a track's view to the fields the vibe map serves. */
export function moodOutput(view: MoodView | undefined): {
    dominantMood: string;
    moodScore: number;
    moods: Record<string, number>;
} {
    if (!view) return { dominantMood: UNANALYZED, moodScore: 0, moods: {} };
    return { dominantMood: view.dominant, moodScore: view.score, moods: view.ranks as Record<string, number> };
}

class MoodBucketService {
    /**
     * Rebuild every bucket from the snapshot: one row per mood the verdict gives
     * a track, scored by its library rank (ordering only). One transaction, so
     * readers never see a half-built table.
     */
    async rebuildBuckets(snap: MoodSnapshot): Promise<{ tracks: number; assignments: number }> {
        const rows: { trackId: string; mood: MoodType; score: number }[] = [];
        let tracks = 0;
        for (const [trackId, view] of snap.views) {
            if (view.moods.length === 0) continue;
            tracks++;
            for (const field of view.moods) {
                const mood = MOODS.find((m) => m.field === field)!;
                rows.push({ trackId, mood: mood.id, score: view.ranks[field] as number });
            }
        }
        await prisma.$transaction([
            prisma.moodBucket.deleteMany({}),
            prisma.moodBucket.createMany({ data: rows }),
        ]);
        logger.debug(`[MoodBucket] Rebuilt buckets: ${rows.length} assignments over ${tracks} tracks`);
        return { tracks, assignments: rows.length };
    }

    /**
     * Get mood presets with track counts for the UI. `pendingTracks` is how
     * many library tracks are still waiting for mood analysis, so the UI can
     * say "not analysed yet" instead of showing an empty mood as final.
     */
    async getMoodPresets(): Promise<
        {
            id: string;
            name: string;
            color: string;
            icon: string;
            trackCount: number;
            pendingTracks: number;
        }[]
    > {
        const [counts, snap] = await Promise.all([
            prisma.moodBucket.groupBy({ by: ["mood"], _count: { _all: true } }),
            currentMoodSnapshot(),
        ]);
        const byMood = new Map(counts.map((c) => [c.mood, c._count._all]));
        return MOODS.map((m) => ({
            id: m.id,
            name: m.name,
            color: m.color,
            icon: m.icon,
            trackCount: byMood.get(m.id) ?? 0,
            pendingTracks: snap.pending,
        }));
    }

    /**
     * Get a mood mix for a specific mood
     * Fast lookup from pre-computed MoodBucket table
     */
    async getMoodMix(
        mood: MoodType,
        limit: number = 15,
        excludeTrackIds: string[] = []
    ): Promise<{
        id: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
    } | null> {
        if (!VALID_MOODS.includes(mood)) {
            throw new Error(`Invalid mood: ${mood}`);
        }

        const config = MOOD_BY_ID[mood];

        // Draw uniformly from the whole bucket; scores never enter the draw.
        const moodBuckets = await prisma.moodBucket.findMany({
            where: { mood },
            select: { trackId: true, score: true },
        });

        // Skip what this user was already served, unless that leaves too
        // small a pool to mix from -- then start over from the full bucket.
        let pool = moodBuckets;
        if (excludeTrackIds.length > 0) {
            const excluded = new Set(excludeTrackIds);
            const fresh = moodBuckets.filter((b) => !excluded.has(b.trackId));
            if (fresh.length >= 8) {
                pool = fresh;
            }
        }

        if (pool.length < 8) {
            logger.debug(
                `[MoodBucket] Not enough tracks for mood ${mood}: ${pool.length}`
            );
            return null;
        }

        // Randomly sample from the pool
        const shuffled = shuffleArray(pool);
        const selectedIds = shuffled.slice(0, limit).map((b) => b.trackId);

        // Get cover URLs for the selected tracks
        const tracks = await prisma.track.findMany({
            where: { id: { in: selectedIds } },
            select: {
                id: true,
                album: { select: { coverUrl: true } },
            },
        });

        // Preserve order of selectedIds
        const orderedTracks = selectedIds
            .map((id) => tracks.find((t) => t.id === id))
            .filter(Boolean);
        const coverUrls = orderedTracks
            .filter((t) => t?.album.coverUrl)
            .slice(0, 4)
            .map((t) => t!.album.coverUrl!);

        const timestamp = Date.now();
        return {
            id: `mood-${mood}-${timestamp}`,
            mood,
            name: `${config.name} Mix`,
            description: `Tracks that match your ${config.name.toLowerCase()} vibe`,
            trackIds: orderedTracks.map((t) => t!.id),
            coverUrls,
            trackCount: orderedTracks.length,
            color: MOOD_GRADIENTS[mood],
        };
    }

    /**
     * Save the user's active mood mix: the given trackIds that resolve (order kept,
     * unknown ids dropped), or a fresh mix when none are given. Returns the mix.
     */
    async saveUserMoodMix(
        userId: string,
        mood: MoodType,
        limit: number = 15,
        trackIds?: string[]
    ): Promise<{
        id: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
        generatedAt: string;
    } | null> {
        const config = MOOD_BY_ID[mood];
        const generatedAt = new Date();

        // If explicit trackIds are provided, derive coverUrls from them and persist
        if (trackIds && trackIds.length > 0) {
            const tracks = await prisma.track.findMany({
                where: { id: { in: trackIds } },
                select: {
                    id: true,
                    album: { select: { coverUrl: true } },
                },
            });

            // Preserve order of provided trackIds
            const orderedTracks = trackIds
                .map((id) => tracks.find((t) => t.id === id))
                .filter(Boolean);

            const coverUrls = orderedTracks
                .filter((t) => t?.album.coverUrl)
                .slice(0, 4)
                .map((t) => t!.album.coverUrl!);

            const persistedTrackIds = orderedTracks.map((t) => t!.id);

            // Upsert the user's mood mix with explicit trackIds
            await prisma.userMoodMix.upsert({
                where: { userId },
                create: {
                    userId,
                    mood,
                    trackIds: persistedTrackIds,
                    coverUrls,
                    servedTrackIds: persistedTrackIds,
                    generatedAt,
                },
                update: {
                    mood,
                    trackIds: persistedTrackIds,
                    coverUrls,
                    servedTrackIds: persistedTrackIds,
                    generatedAt,
                },
            });

            logger.debug(
                `[MoodBucket] Saved ${mood} mix for user ${userId} (${persistedTrackIds.length} explicit tracks)`
            );

            return {
                id: `your-mood-mix-${generatedAt.getTime()}`,
                mood,
                name: `Your ${config.name} Mix`,
                description: `Based on your ${config.name.toLowerCase()} preferences`,
                trackIds: persistedTrackIds,
                coverUrls,
                trackCount: persistedTrackIds.length,
                color: MOOD_GRADIENTS[mood],
                generatedAt: generatedAt.toISOString(),
            };
        }

        // Fallback: regenerate a fresh mix via getMoodMix, skipping what this
        // user was already served so the next mix doesn't repeat it
        const remembered = await this.getRememberedTrackIds(userId, mood);
        const mix = await this.getMoodMix(mood, limit, remembered);
        if (!mix) return null;

        // Upsert the user's mood mix
        await prisma.userMoodMix.upsert({
            where: { userId },
            create: {
                userId,
                mood,
                trackIds: mix.trackIds,
                coverUrls: mix.coverUrls,
                servedTrackIds: mix.trackIds,
                generatedAt,
            },
            update: {
                mood,
                trackIds: mix.trackIds,
                coverUrls: mix.coverUrls,
                servedTrackIds: mix.trackIds,
                generatedAt,
            },
        });

        logger.debug(
            `[MoodBucket] Saved ${mood} mix for user ${userId} (${mix.trackCount} tracks)`
        );

        // Return with user-specific naming
        return {
            id: `your-mood-mix-${generatedAt.getTime()}`,
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: mix.trackIds,
            coverUrls: mix.coverUrls,
            trackCount: mix.trackCount,
            color: MOOD_GRADIENTS[mood],
            generatedAt: generatedAt.toISOString(),
        };
    }

    /**
     * Get user's current saved mood mix for display on home page
     */
    async getUserMoodMix(userId: string): Promise<{
        id: string;
        type: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
    } | null> {
        const userMix = await prisma.userMoodMix.findUnique({
            where: { userId },
        });

        if (!userMix) return null;

        const mood = userMix.mood as MoodType;
        if (!VALID_MOODS.includes(mood)) return null;

        const config = MOOD_BY_ID[mood];

        return {
            id: `your-mood-mix-${userMix.generatedAt.getTime()}`,
            type: "mood",
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: userMix.trackIds,
            coverUrls: userMix.coverUrls,
            trackCount: userMix.trackIds.length,
            color: MOOD_GRADIENTS[mood],
        };
    }

    /**
     * Forget the user's saved mood mix, so the next one is built from the
     * current mood values. Only the 1.11 release window calls this, and only
     * when the user asks for it: mixes saved before 1.11 were picked from the
     * inverted mood heads. deleteMany, so a repeat is a no-op, not an error.
     */
    async clearUserMoodMix(userId: string): Promise<{ removed: number }> {
        const { count } = await prisma.userMoodMix.deleteMany({ where: { userId } });
        if (count) logger.debug(`[MoodBucket] Cleared saved mood mix for user ${userId}`);
        return { removed: count };
    }

    /**
     * Track ids this user was already given for a mood: what the last serving
     * remembered, plus the saved mix itself. The next getMoodMix for that mood
     * skips them, so regenerating doesn't replay the same tracks.
     */
    async getRememberedTrackIds(
        userId: string,
        mood: MoodType
    ): Promise<string[]> {
        const row = await prisma.userMoodMix.findUnique({
            where: { userId },
        });

        if (!row || row.mood !== mood) return [];

        // Rows written before the servedTrackIds migration carry no history.
        return Array.from(new Set([...(row.servedTrackIds ?? []), ...row.trackIds]));
    }

    /**
     * Remember the exact ids a mix was served with, so the next mix for this
     * user skips them. Update-only: without a saved mix there is nothing to
     * remember against, and creating one would surface an empty mix on the
     * home page. Keyed on the mood too, so the memory can't leak across moods.
     */
    async recordServedTracks(
        userId: string,
        mood: MoodType,
        trackIds: string[]
    ): Promise<void> {
        if (trackIds.length === 0) return;

        await prisma.userMoodMix.updateMany({
            where: { userId, mood },
            data: { servedTrackIds: trackIds },
        });
    }

    /**
     * Rebuild all mood buckets from the current library (admin backfill).
     */
    async backfillAllTracks(): Promise<{ processed: number; assigned: number }> {
        const { snapshot: snap } = await refreshMoodSnapshot();
        const result = await this.rebuildBuckets(snap);
        return { processed: result.tracks, assigned: result.assignments };
    }
}

export const moodBucketService = new MoodBucketService();
