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
import { listenBrainzService } from "./listenBrainz";

/** A track at or below this length can never be scrobbled. Last.fm's floor. */
export const MIN_TRACK_DURATION_SECONDS = 30;

/** Nobody has to finish a long track. Four minutes is always enough. */
export const MAX_REQUIRED_SECONDS = 240;

/**
 * The shortest window a repeat is ever suppressed for, whatever the track's
 * length. A ten second loop is a stuck client, not a listener.
 */
export const MIN_DEDUP_WINDOW_MS = 30 * 1000;

/**
 * How long a repeat of the same track is treated as the same listen.
 *
 * The track's own length, not a fixed number of minutes. The reasoning is
 * simple: if the song could not have finished yet, a second report of it is the
 * same listen being described twice. Once it could have finished, a second
 * report is a second listen and suppressing it loses something real.
 *
 * A flat five minutes was the first attempt and it is measurably wrong. Against
 * eight months of a real library it wrongly merged 250 genuine replays of short
 * tracks, and using the duration instead wrongly split 10. Twenty five to one,
 * in favour of asking the track how long it is.
 */
export function dedupWindowMs(durationSeconds: number | null | undefined): number {
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return MAX_REQUIRED_SECONDS * 1000;
    }
    return Math.max(MIN_DEDUP_WINDOW_MS, durationSeconds * 1000);
}

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
 * Mirror a recorded play to ListenBrainz, fire-and-forget.
 *
 * Kima's play log is the record; ListenBrainz is a mirror the operator opts
 * into by saving a user token. The play is already committed by the time this
 * runs, so nothing here may change the outcome: the call is never awaited,
 * rejections are swallowed with a warn, and with no token configured
 * `submitListens` skips itself with a debug log. A ListenBrainz outage must
 * never fail a play.
 */
function mirrorToListenBrainz(params: {
    artistName: string;
    trackTitle: string;
    releaseTitle?: string | null;
    listenedAt: number; // unix seconds
}): void {
    const { artistName, trackTitle, releaseTitle, listenedAt } = params;
    listenBrainzService
        .submitListens([
            {
                artist: artistName,
                track: trackTitle,
                ...(releaseTitle ? { release: releaseTitle } : {}),
                listenedAt,
            },
        ])
        .then((ok) => {
            if (ok) {
                logger.debug(`[Play] mirrored "${artistName} – ${trackTitle}" to ListenBrainz`);
            }
        })
        .catch((err: unknown) => {
            logger.warn(
                `[Play] ListenBrainz mirror failed for "${artistName} – ${trackTitle}":`,
                err,
            );
        });
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
        select: {
            id: true,
            duration: true,
            title: true,
            album: { select: { title: true, artist: { select: { name: true } } } },
        },
    });
    if (!track) return { recorded: false, reason: "unknown-track" };

    const required = requiredListenSeconds(track.duration);
    if (required === null) return { recorded: false, reason: "too-short" };
    if (!Number.isFinite(secondsListened) || secondsListened < required) {
        return { recorded: false, reason: "not-enough-listened" };
    }

    const since = new Date((playedAt?.getTime() ?? Date.now()) - dedupWindowMs(track.duration));
    const recent = await prisma.play.findFirst({
        // `gt`, not `gte`. The rule above is that a row is a duplicate while
        // the song could not have finished — strictly inside the window. At
        // exactly one duration earlier the song HAS finished, so a second
        // complete play back-to-back is a real replay. Subsonic clients
        // scrobble with exact timestamps, which is precisely where two plays
        // land one duration apart.
        where: { userId, trackId, playedAt: { gt: since } },
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

    // Mirror to ListenBrainz only when we know what was actually played.
    // Mocked/partial track rows (tests, half-enriched libraries) simply
    // skip the mirror; the local play log above is unaffected either way.
    if (track.title && track.album?.artist?.name) {
        mirrorToListenBrainz({
            artistName: track.album.artist.name,
            trackTitle: track.title,
            releaseTitle: track.album.title,
            // The play's own clock: Subsonic back-fills with the client's
            // timestamp, and LB wants the listen anchored to when it
            // happened, not to when the report arrived.
            listenedAt: Math.floor((playedAt?.getTime() ?? Date.now()) / 1000),
        });
    }

    return { recorded: true, playId: play.id };
}
