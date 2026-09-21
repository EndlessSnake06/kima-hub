"use client";

import Link from "next/link";
import { Play, Sparkles, AudioWaveform, Waypoints } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import type { MapTrack } from "@/features/vibe/types";

/**
 * TrackDetails -- the scrollable body of the TrackDrawer.
 *
 * Renders the selected track's OWN data from the MapTrack object the map
 * already carries (zero new fetches): cover, title, artist, dominant mood,
 * a normalized mood spread, and energy/valence. The four action buttons call
 * the page's existing handlers (playTracks for Play now; handleTrackContextMenu
 * for vibe/similar; driftSourceId for Song path).
 *
 * The artist name links to the artist page, mirroring the app's other track
 * listings. When the cover url is missing a placeholder stands in.
 */
export function TrackDetails({
    track,
    onPlay,
    onVibe,
    onSimilar,
    onSongPath,
    songPathActive,
}: {
    track: MapTrack;
    onPlay: () => void;
    onVibe: () => void;
    onSimilar: () => void;
    onSongPath: () => void;
    songPathActive: boolean;
}) {
    const sortedMoods = Object.entries(track.moods ?? {})
        .filter(([, v]) => v > 0)
        .sort((a, b) => (b[1] as number) - (a[1] as number));
    const dominant = sortedMoods.length > 0 ? sortedMoods[0][0] : track.dominantMood;
    const totalWeight = sortedMoods.reduce((acc, [, v]) => acc + (v as number), 0) || 1;

    return (
        <div className="space-y-4">
            <div className="relative aspect-square w-32 self-center overflow-hidden rounded-md bg-white/5 shadow-lg">
                <CachedImage
                    src={track.coverUrl ?? null}
                    alt={`${track.title} album cover`}
                    className="h-full w-full object-cover"
                    sizes="128px"
                />
            </div>

            <div className="min-w-0 text-center">
                <p className="truncate text-base font-semibold text-[var(--text-primary)]">
                    {track.title}
                </p>
                {track.artistId && (
                    <Link
                        href={`/artist/${track.artistId}`}
                        className="mt-0.5 block truncate text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                        tabIndex={-1}
                    >
                        {track.artist}
                    </Link>
                )}
                {track.albumId && (
                    <p tabIndex={-1} className="mt-0.5 block text-xs text-[var(--text-muted)] truncate">
                        Link to album
                    </p>
                )}
            </div>

            {/* Dominant mood + normalized mood spread */}
            <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] font-semibold">
                    {dominant}
                </p>
                {sortedMoods.map(([mood, score]) => (
                    <div key={mood} className="grid grid-cols-[2.5rem_1fr] items-center gap-2 text-[10px]">
                        <span className="truncate capitalize text-[var(--text-muted)]">{mood}</span>
                        <div className="relative h-1 overflow-hidden rounded-full bg-white/10">
                            <div
                                className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-brand)]/80"
                                style={{ width: `${((score as number) / totalWeight) * 100}%` }}
                            />
                        </div>
                    </div>
                ))}
            </div>

            {/* Energy + valence, when present */}
            {(track.energy != null || track.valence != null) && (
                <div className="grid grid-cols-2 gap-2">
                    {track.energy != null && (
                        <div className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Energy</p>
                            <p className="text-sm font-medium text-[var(--text-primary)]">
                                {Math.round((track.energy as number) * 100)}%
                            </p>
                        </div>
                    )}
                    {track.valence != null && (
                        <div className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Valence</p>
                            <p className="text-sm font-medium text-[var(--text-primary)]">
                                {Math.round((track.valence as number) * 100)}%
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                    type="button"
                    onClick={onPlay}
                    aria-label="Play this track"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.08] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-white/15 transition-colors"
                >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Play
                </button>
                <button
                    type="button"
                    onClick={onVibe}
                    aria-label="Build vibe playlist from this track"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-purple-500/20 bg-purple-500/10 px-3 py-2 text-xs font-medium text-purple-300 hover:bg-purple-500/20 transition-colors"
                >
                    <Sparkles className="h-3.5 w-3.5" />
                    Match Vibe
                </button>
                <button
                    type="button"
                    onClick={onSimilar}
                    aria-label="Find tracks similar to this one"
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.08] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-white/15 transition-colors"
                >
                    <AudioWaveform className="h-3.5 w-3.5" />
                    Similar
                </button>
                <button
                    type="button"
                    onClick={onSongPath}
                    aria-label="Start song path from this track"
                    className={
                        songPathActive
                            ? "flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-brand)]/60 bg-[var(--color-brand)]/15 px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors"
                            : "flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.08] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-white/15 transition-colors"
                    }
                >
                    <Waypoints className="h-3.5 w-3.5" />
                    Path
                </button>
            </div>
        </div>
    );
}
