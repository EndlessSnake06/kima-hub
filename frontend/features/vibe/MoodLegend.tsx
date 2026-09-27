"use client";

import { useMemo } from "react";
import { MOOD_COLORS, isMood, moodLabel } from "./mapUtils";
import type { MapTrack } from "./types";

interface MoodLegendProps {
    tracks: MapTrack[];
    activeMood: string | null;
    /** One scrolling row instead of wrapping (phones). */
    scroll?: boolean;
    onPreview: (mood: string | null) => void;
    onToggle: (mood: string) => void;
}

/**
 * The moods in this library, counted. Hovering one lights its tracks in that
 * mood's colour and lets the rest fall away; clicking keeps it lit until
 * clicked again. The five moods come first, by size; "No single mood" and
 * "Not analysed yet" follow, so they never read as a mood of their own.
 */
export function MoodLegend({ tracks, activeMood, scroll = false, onPreview, onToggle }: MoodLegendProps) {
    const moods = useMemo(() => {
        const counts = new Map<string, number>();
        for (const t of tracks) counts.set(t.dominantMood, (counts.get(t.dominantMood) ?? 0) + 1);
        return [...counts.entries()].sort(
            (a, b) => Number(isMood(b[0])) - Number(isMood(a[0])) || b[1] - a[1],
        );
    }, [tracks]);

    return (
        <div
            className={scroll ? "-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" : "flex flex-wrap gap-1.5"}
            onMouseLeave={() => onPreview(null)}
            role="group"
            aria-label="Moods in your library"
        >
            {moods.map(([mood, count]) => {
                const [r, g, b] = MOOD_COLORS[mood] ?? MOOD_COLORS.neutral;
                const on = activeMood === mood;
                return (
                    <button
                        key={mood}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onToggle(mood)}
                        onMouseEnter={() => onPreview(mood)}
                        onFocus={() => onPreview(mood)}
                        onBlur={() => onPreview(null)}
                        className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                        style={{
                            borderColor: on ? `rgb(${r} ${g} ${b} / 0.7)` : "rgba(255,255,255,0.1)",
                            background: on ? `rgb(${r} ${g} ${b} / 0.16)` : "rgba(8,5,14,0.5)",
                            color: on ? "#fff" : "rgba(255,255,255,0.72)",
                        }}
                    >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(${r} ${g} ${b})`, boxShadow: `0 0 6px rgb(${r} ${g} ${b} / 0.8)` }} />
                        {moodLabel(mood)}
                        <span className="tabular-nums text-white/60">{count.toLocaleString()}</span>
                    </button>
                );
            })}
        </div>
    );
}
