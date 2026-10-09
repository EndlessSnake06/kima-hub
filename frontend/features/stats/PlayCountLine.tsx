"use client";

/**
 * "45th play" under the title in all three players. Renders nothing for a
 * first listen.
 */

import Link from "next/link";
import { useTrackPlays } from "./useTrackPlays";
import { ordinal } from "./format";

export function PlayCountLine({
    trackId,
    className = "",
}: {
    /** Null for a book or a podcast, which are not counted this way. */
    trackId: string | null | undefined;
    /** Size and spacing belong to the player this sits in, not to this line. */
    className?: string;
}) {
    // Counted before the play in progress records, so the one being heard is
    // the next one up. See `useTrackPlays` for why that is the honest number.
    const heardBefore = useTrackPlays(trackId);
    if (heardBefore === null || heardBefore < 1) return null;

    return (
        <Link
            href="/stats"
            title="open stats"
            className={`text-brand hover:underline ${className}`.trim()}
        >
            {ordinal(heardBefore + 1)} play
        </Link>
    );
}
