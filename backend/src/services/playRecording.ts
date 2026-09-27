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
const MIN_DEDUP_WINDOW_MS = 30 * 1000;

/**
 * How long a repeat of the same track is treated as the same listen.
 *
 * The track's own length, not a fixed number of minutes. The reasoning is
 * simple: if the song could not have finished yet, a second report of it is the
 * same listen being described twice. Once it could have finished, a second
 * report is a second listen and suppressing it loses something real.
 *
 * The window is applied on **both sides** of the play being reported (see
 * `recordPlay`): a report that lands within one length BEFORE an existing row
 * is the same listen described late, exactly as one that lands within one
 * length AFTER it is the same listen described twice.
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
    userId: string;
    artistName: string;
    trackTitle: string;
    releaseTitle?: string | null;
    listenedAt: number; // unix seconds
}): void {
    const { userId, artistName, trackTitle, releaseTitle, listenedAt } = params;
    listenBrainzService
        .submitListens(userId, [
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
 * What the caller knows about the listening.
 *
 * - `secondsListened`: the web player measured it. The half-or-four-minutes
 *   rule is applied to it here.
 * - `clientAttestedComplete`: a Subsonic scrobble with `submission=true`. The
 *   Subsonic contract leaves "was this played" to the client, which reports no
 *   seconds, only that it counted the play. The listening rule is taken as met;
 *   the 30-second track floor and the duplicate window still apply.
 *
 * Exactly one of the two, so a caller cannot pass a made-up number of seconds
 * to stand in for "the client said so".
 */
export type PlayEvidence =
    | { secondsListened: number; clientAttestedComplete?: never }
    | { clientAttestedComplete: true; secondsListened?: never };

/**
 * Key space for the play dedupe lock.
 *
 * `pg_advisory_xact_lock` has a two-integer form and a one-integer form, and
 * Postgres keeps them in **different** key spaces. `playlistService.ts` locks
 * with the one-integer form (`hashtext(playlistId)`); using the two-integer
 * form here with this namespace means a play can never wait on a playlist
 * lock, or a playlist on a play, however their ids hash.
 */
const PLAY_DEDUP_LOCK_NAMESPACE = 7001;

/**
 * Serialise play reports for one (user, track) pair.
 *
 * The duplicate check and the insert have to be one decision. Two concurrent
 * reports of the same play — a Subsonic client retrying a scrobble, or the
 * same track started on two devices — otherwise both read "no earlier play"
 * from an empty window and both write, because nothing between the two
 * statements stops the second one. The lock is transaction-scoped, so it is
 * released when the transaction that took it commits or rolls back.
 *
 * It has to be taken **inside** the transaction, and the transaction must run
 * on the database's default READ COMMITTED. Do not add an `isolationLevel`:
 * under REPEATABLE READ each transaction reads from the snapshot taken when it
 * started, so the writer that waits on the lock still reads the pre-insert
 * snapshot, still sees no duplicate, and still writes a second row — silently,
 * with no error to notice it by.
 */
async function lockPlayDedupe(
    tx: Pick<typeof prisma, "$executeRaw">,
    userId: string,
    trackId: string,
): Promise<void> {
    // Both arguments need the explicit `::int` cast: Prisma binds a JS number
    // as `bigint`, and the two-argument `pg_advisory_xact_lock` only has an
    // `(int, int)` signature — `(bigint, int)` matches nothing and the query
    // fails with 42883 before the first statement even runs.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLAY_DEDUP_LOCK_NAMESPACE}::int, hashtext(${`${userId}:${trackId}`}))`;
}

/**
 * Record a play if the listening earns it.
 *
 * The caller reports how many seconds were actually heard (or that a Subsonic
 * client attested the play); this decides. The track's own duration is read
 * here rather than trusted from the request, so a client cannot claim a
 * three-second track is an hour long and scrobble it on two seconds of audio.
 *
 * The duplicate check and the insert are one transaction behind a
 * per-(user, track) advisory lock, so two concurrent reports of one play —
 * and the two reports of one play that arrive hours apart when a device
 * back-fills — cannot both write.
 */
export async function recordPlay(
    params: {
        userId: string;
        trackId: string;
        source?: ListenSource;
        playedAt?: Date;
    } & PlayEvidence,
): Promise<PlayOutcome> {
    const { userId, trackId, source = ListenSource.LIBRARY, playedAt } = params;
    const attested = params.clientAttestedComplete === true;

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
    if (!attested) {
        const seconds = params.secondsListened;
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < required) {
            return { recorded: false, reason: "not-enough-listened" };
        }
    }

    // The window is centred on the play being reported, not started at it.
    // A late sync reports something that happened hours ago; anything newer
    // than that is a different listen and must not veto it.
    const anchor = playedAt?.getTime() ?? Date.now();
    const window = dedupWindowMs(track.duration);

    // Check and insert inside one transaction, ordered by a per-(user, track)
    // advisory lock — see `lockPlayDedupe`. No `isolationLevel` is passed on
    // purpose: Prisma's default (READ COMMITTED) is what makes the lock work,
    // and REPEATABLE READ would put the second writer back to a stale
    // snapshot and restore the duplicate silently.
    const outcome = await prisma.$transaction(async (tx) => {
        await lockPlayDedupe(tx, userId, trackId);

        const recent = await tx.play.findFirst({
            // Both bounds strict, and both required. `gt`, not `gte`: the
            // rule is that a row is a duplicate while the song could not have
            // finished — strictly inside the window. At exactly one duration
            // before or after the reported play the song HAS finished, so a
            // play that far out is a real replay. Subsonic clients scrobble
            // with exact timestamps, which is precisely where two plays land
            // one duration apart.
            where: {
                userId,
                trackId,
                playedAt: {
                    gt: new Date(anchor - window),
                    lt: new Date(anchor + window),
                },
            },
            select: { id: true },
        });
        if (recent) return { recorded: false, reason: "duplicate" } as const;

        const play = await tx.play.create({
            data: { userId, trackId, source, ...(playedAt ? { playedAt } : {}) },
            select: { id: true },
        });
        return { recorded: true, playId: play.id } as const;
    });

    // Past this point the row is committed (or the duplicate call is over), so
    // nothing below may change `outcome` — the mirror is fire-and-forget.
    if (outcome.recorded) {
        logger.debug(
            attested
                ? `[Play] ${trackId} counted for ${userId} on the client's attestation (${track.duration}s track)`
                : `[Play] ${trackId} counted for ${userId} after ${Math.round(params.secondsListened ?? 0)}s ` +
                      `(needed ${Math.round(required)}s of ${track.duration}s)`,
        );

        // Mirror to ListenBrainz only when we know what was actually played.
        // Mocked/partial track rows (tests, half-enriched libraries) simply
        // skip the mirror; the local play log is unaffected either way.
        if (track.title && track.album?.artist?.name) {
            mirrorToListenBrainz({
                userId,
                artistName: track.album.artist.name,
                trackTitle: track.title,
                releaseTitle: track.album.title,
                // The play's own clock: Subsonic back-fills with the client's
                // timestamp, and LB wants the listen anchored to when it
                // happened, not to when the report arrived.
                listenedAt: Math.floor(anchor / 1000),
            });
        }
    } else {
        logger.debug(
            `[Play] ${trackId} skipped for ${userId}: a play of it is already logged within ` +
                `±${Math.round(window / 1000)}s of ${new Date(anchor).toISOString()}`,
        );
    }

    return outcome;
}
