"use client";

/**
 * Completed listens of the current track, fetched when the track changes so
 * "45th play" stays true for the whole song. Cached per track for the session
 * and not invalidated when a play records, so it never renumbers mid-song.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** Session-lived, so a queue you move around in asks once per track. */
const counted = new Map<string, number>();

export function useTrackPlays(trackId: string | null | undefined): number | null {
    // What came back, and which track it was for. Stored together so a result
    // can never be shown under the wrong name.
    const [fetched, setFetched] = useState<{ id: string; plays: number } | null>(null);
    // Only the newest request may write, so a fast skip through a queue cannot
    // land an earlier track's count under a later track's.
    const ticket = useRef(0);

    useEffect(() => {
        if (!trackId || counted.has(trackId)) return;

        const mine = ++ticket.current;
        let cancelled = false;
        (async () => {
            try {
                const res = await api.get<{ plays: number }>(
                    `/stats/track/${encodeURIComponent(trackId)}/plays`,
                );
                if (cancelled || ticket.current !== mine) return;
                counted.set(trackId, res.plays);
                setFetched({ id: trackId, plays: res.plays });
            } catch {
                // A count that cannot be read is a line that does not appear.
                // There is nothing useful to say about a failure here.
            }
        })();
        return () => { cancelled = true; };
    }, [trackId]);

    // Derived during render rather than pushed into state by the effect. The
    // two cases that need no request — no track, and a track already counted —
    // are answered without a state write at all, which is what keeps this off
    // the cascading-render path.
    if (!trackId) return null;
    const cached = counted.get(trackId);
    if (cached !== undefined) return cached;
    return fetched?.id === trackId ? fetched.plays : null;
}
