"use client";

/**
 * The current track's dominant mood, the one that colours its star on the map.
 * Cached per track for the session, like the play count beside it.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

const known = new Map<string, string>();

export function useTrackMood(trackId: string | null | undefined): string | null {
    const [fetched, setFetched] = useState<{ id: string; mood: string } | null>(null);
    const ticket = useRef(0);

    useEffect(() => {
        if (!trackId || known.has(trackId)) return;

        const mine = ++ticket.current;
        let cancelled = false;
        (async () => {
            try {
                const res = await api.get<{ dominantMood: string }>(
                    `/vibe/mood/${encodeURIComponent(trackId)}`,
                );
                if (cancelled || ticket.current !== mine) return;
                // A song not yet analyzed is asked about again next time.
                if (res.dominantMood !== "unanalyzed") known.set(trackId, res.dominantMood);
                setFetched({ id: trackId, mood: res.dominantMood });
            } catch {
                // No mood to show is a dot that does not appear.
            }
        })();
        return () => { cancelled = true; };
    }, [trackId]);

    if (!trackId) return null;
    const cached = known.get(trackId);
    if (cached !== undefined) return cached;
    return fetched?.id === trackId ? fetched.mood : null;
}
