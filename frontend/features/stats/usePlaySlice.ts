"use client";

/**
 * Put on whatever the page just told you about.
 *
 * A page of numbers about music that cannot play any of it is a report. The
 * gap between a report and a tool is whether the interesting thing you just
 * noticed is one press from happening — "seven thousand tracks you have never
 * played" ought to be an invitation, not a fact to feel bad about.
 *
 * Every slice here matches a figure the page already states, so nothing plays
 * that the reader was not just looking at.
 */

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";

export interface PlayableTrack {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
}

export type Slice = "top" | "never" | "core" | "key" | "decade";

export function usePlaySlice() {
    const { playTracks } = useAudioControls();
    const [busy, setBusy] = useState<string | null>(null);

    const play = useCallback(
        async (
            slice: Slice,
            opts: {
                key?: string;
                decade?: number;
                limit?: number;
                startIndex?: number;
                token?: string;
                /**
                 * The window the page was showing when the button was pressed.
                 *
                 * "Play those 64" has to hand back the 64 the sentence beside it
                 * names. Without this the button plays the all-time set while the
                 * page is describing the last thirty days, and nothing on screen
                 * says they differ. The shelf slices ("never", "decade") ignore
                 * it server-side, because they are not about a period.
                 */
                period?: string;
            } = {},
        ) => {
            const token = opts.token ?? slice;
            setBusy(token);
            try {
                const params = new URLSearchParams({ of: slice });
                if (opts.key) params.set("key", opts.key);
                if (opts.decade) params.set("decade", String(opts.decade));
                if (opts.limit) params.set("limit", String(opts.limit));
                if (opts.period) params.set("period", opts.period);
                const { tracks } = await api.get<{ tracks: PlayableTrack[] }>(
                    `/stats/tracks?${params.toString()}`,
                );
                if (!tracks.length) return 0;
                // The player treats a missing cover as undefined, not null.
                playTracks(
                    tracks.map((t) => ({
                        ...t,
                        album: { ...t.album, coverArt: t.album.coverArt ?? undefined },
                    })),
                    Math.min(opts.startIndex ?? 0, tracks.length - 1),
                );
                return tracks.length;
            } catch {
                // A failed press is not worth a dialogue on a page about music.
                return 0;
            } finally {
                setBusy(null);
            }
        },
        [playTracks],
    );

    return { play, busy };
}
