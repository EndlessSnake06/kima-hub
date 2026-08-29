"use client";

/**
 * "45th play" — one fact about the track in front of you, in every player.
 *
 * There are three players (docked, mini, overlay) and they all show the same
 * title-and-artist block, so this is one component rather than three copies of
 * the same six lines. The first version lived inline in `MiniPlayer` alone,
 * which meant the line simply did not exist on a desktop, where the docked
 * `FullPlayer` renders instead. An end-to-end journey caught that; three copies
 * would have let it drift again.
 *
 * Silent unless there is something to say: a track you have heard once gets no
 * line, because "1st play" tells nobody anything.
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
            title="See your listening"
            className={`text-brand hover:underline ${className}`.trim()}
        >
            {ordinal(heardBefore + 1)} play
        </Link>
    );
}
