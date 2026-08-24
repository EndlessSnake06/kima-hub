/**
 * What counts as a play.
 *
 * Until now a `Play` row meant "the stream endpoint was hit" — the byte request
 * itself logged one, so skipping through an album wrote a play per track and
 * nobody had listened to any of them. Play history fed the vibe profile,
 * recently-played and the decay model, all of which were reading intent that was
 * never there.
 *
 * The rule here is Last.fm's, restated verbatim by ListenBrainz: a track counts
 * once it is longer than 30 seconds AND has been played for half its length or
 * four minutes, whichever comes first.
 *
 * Two edges are deliberate rather than incidental:
 *
 * - **An unknown duration gets the four-minute bound, not a pass.** `duration` is
 *   a non-null Int, so an unscanned track arrives as 0. Treating that as
 *   "eligible immediately" would make a missing scan the cheapest possible way to
 *   log a play, which is exactly backwards.
 * - **Half a length is not capped at the bottom.** A 40-second track needs 20
 *   seconds, not 30. The 30-second floor is about the track, not the listening.
 */

import { ListenSource } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/** A track at or below this length can never be scrobbled. Last.fm's floor. */
export const MIN_TRACK_DURATION_SECONDS = 30;

/** Nobody has to finish a long track. Four minutes is always enough. */
export const MAX_REQUIRED_SECONDS = 240;

/**
 * Two plays of the same track by the same person inside this window collapse to
 * one. Long enough to absorb a re-buffer, a reconnect or a client retrying its
 * report; short enough that deliberately replaying a track still counts.
 */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export type PlayOutcome =
    | { recorded: true; playId: string }
    | { recorded: false; reason: "too-short" | "not-enough-listened" | "duplicate" | "unknown-track" };

/**
 * How many seconds of a track must be heard before it counts.
 *
 * Returns `null` when the track can never qualify, which is a different answer
 * from "a very large number" — callers should not be able to satisfy it by
 * listening harder.
 */
export function requiredListenSeconds(durationSeconds: number | null | undefined): number | null {
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        // Unknown length. Demand the upper bound rather than waving it through.
        return MAX_REQUIRED_SECONDS;
    }
    if (durationSeconds <= MIN_TRACK_DURATION_SECONDS) return null;
    return Math.min(durationSeconds / 2, MAX_REQUIRED_SECONDS);
}

/** Whether this much listening, of a track this long, is a play. */
export function qualifiesAsPlay(
    secondsListened: number,
    durationSeconds: number | null | undefined,
): boolean {
    const required = requiredListenSeconds(durationSeconds);
    if (required === null) return false;
    if (!Number.isFinite(secondsListened) || secondsListened < 0) return false;
    return secondsListened >= required;
}

/**
 * Record a play if the listening earns it.
 *
 * The caller reports how many seconds were actually heard; this decides. The
 * track's own duration is read here rather than trusted from the request, so a
 * client cannot claim a three-second track is an hour long and scrobble it on
 * two seconds of audio.
 */
export async function recordPlay(params: {
    userId: string;
    trackId: string;
    secondsListened: number;
    source?: ListenSource;
    playedAt?: Date;
}): Promise<PlayOutcome> {
    const { userId, trackId, secondsListened, source = ListenSource.LIBRARY, playedAt } = params;

    const track = await prisma.track.findUnique({
        where: { id: trackId },
        select: { id: true, duration: true },
    });
    if (!track) return { recorded: false, reason: "unknown-track" };

    const required = requiredListenSeconds(track.duration);
    if (required === null) return { recorded: false, reason: "too-short" };
    if (!Number.isFinite(secondsListened) || secondsListened < required) {
        return { recorded: false, reason: "not-enough-listened" };
    }

    const since = new Date((playedAt?.getTime() ?? Date.now()) - DEDUP_WINDOW_MS);
    const recent = await prisma.play.findFirst({
        where: { userId, trackId, playedAt: { gte: since } },
        select: { id: true },
    });
    if (recent) return { recorded: false, reason: "duplicate" };

    const play = await prisma.play.create({
        data: { userId, trackId, source, ...(playedAt ? { playedAt } : {}) },
        select: { id: true },
    });

    logger.debug(
        `[Play] ${trackId} counted for ${userId} after ${Math.round(secondsListened)}s ` +
            `(needed ${Math.round(required)}s of ${track.duration}s)`,
    );
    return { recorded: true, playId: play.id };
}
