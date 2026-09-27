import type { MapTrack } from "./types";

/**
 * Backend mood keys, in a fixed order (the index is what the star shader sees).
 * Five moods; acoustic/electronic are a sound, not a mood, and are not shown.
 * Each value the backend sends is the track's rank on that mood within this
 * library (0..1), so moods compare fairly with each other.
 */
export const MOOD_KEYS = [
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
] as const;

/** Analysed, but no single mood stands out for the track. */
export const NO_SINGLE_MOOD = "neutral";
/** The track's mood analysis has not run yet. */
export const NOT_ANALYSED = "unanalyzed";

// Warm, muted "matter, not neon" tones so the map reads as a night sky, with
// each mood still distinct from its neighbours.
export const MOOD_COLORS: Record<string, [number, number, number]> = {
    moodHappy:      [240, 178, 90],  // Upbeat — gold
    moodSad:        [185, 143, 224], // Melancholic — lilac
    moodRelaxed:    [91, 194, 180],  // Calm — sea green
    moodAggressive: [224, 104, 94],  // Intense — ember red
    moodParty:      [224, 106, 176], // Energetic — rose
    neutral:        [163, 163, 163], // No single mood
    unanalyzed:     [96, 96, 104],   // Not analysed yet — dimmer grey
};

export const MOOD_LABEL_MAP: Record<string, string> = {
    moodHappy: "Upbeat",
    moodSad: "Melancholic",
    moodRelaxed: "Calm",
    moodAggressive: "Intense",
    moodParty: "Energetic",
    neutral: "No single mood",
    unanalyzed: "Not analysed yet",
};

/** Human name for a backend mood key ("moodHappy" → "Upbeat"). */
export function moodLabel(key: string): string {
    return MOOD_LABEL_MAP[key] ?? MOOD_LABEL_MAP.neutral;
}

/** True for one of the five moods; false for "no single mood" / "not analysed yet". */
export function isMood(key: string): boolean {
    return (MOOD_KEYS as readonly string[]).includes(key);
}

/** Index of a mood key in MOOD_KEYS, or -1 for none/neutral. */
export function moodIndex(key: string): number {
    return (MOOD_KEYS as readonly string[]).indexOf(key);
}

/**
 * Blend a track's mood ranks into one RGB colour (0–255). Ranks are cubed so
 * the mood the track stands out on dominates; `saturationBoost` pushes the blend away from grey.
 * Uncached on purpose: it runs once per track when the map is built.
 */
export function blendMoodColor(track: Pick<MapTrack, "moods">, saturationBoost = 1.6): [number, number, number] {
    const moods = track.moods;
    let r = 0, g = 0, b = 0, total = 0;
    if (moods) {
        for (const key of MOOD_KEYS) {
            const score = moods[key];
            if (!score || score <= 0) continue;
            const [cr, cg, cb] = MOOD_COLORS[key];
            const w = score * score * score;
            r += cr * w;
            g += cg * w;
            b += cb * w;
            total += w;
        }
    }
    if (total === 0) return MOOD_COLORS.neutral;
    r /= total;
    g /= total;
    b /= total;
    const grey = (r + g + b) / 3;
    const clamp = (v: number) => Math.round(Math.max(0, Math.min(255, grey + (v - grey) * saturationBoost)));
    return [clamp(r), clamp(g), clamp(b)];
}
