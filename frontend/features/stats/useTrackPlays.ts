"use client";

/**
 * How many times you have heard the track that is playing.
 *
 * The player bar is the one surface you are always looking at, so it is the one
 * place a fact about the current track costs nothing to read. This supplies
 * that fact, and the link to the stats page is a side effect of stating it
 * rather than the reason for it.
 *
 * ## Why it counts before the current play, not after
 *
 * A play is recorded once you are half way through. Asking for the count at
 * that moment would return a number that changes underneath the sentence. So
 * the count is fetched when the track CHANGES, which makes it the number of
 * completed listens before this one — and therefore the one you are hearing is
 * the next. "45th play" is then true from the first second to the last.
 *
 * ## Why it is cached per track
 *
 * Skipping back and forth through a queue would otherwise refetch the same
 * count repeatedly. The cache lives for the session and is keyed by track id;
 * it is deliberately not invalidated when a play records, because the sentence
 * is about the listen in progress and must not renumber itself mid-song.
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
