/**
 * Undoing eight months of "a stream request is a play".
 *
 * Until 1.10.1 a Play row was written when the stream endpoint was hit, so
 * skipping through an album recorded a play for every track. That history feeds
 * the vibe profile, recently-played and the decay model, and there is no record
 * anywhere of how long anything was actually heard — the Play table holds a user,
 * a track and a timestamp, nothing else.
 *
 * ## The one signal in the data
 *
 * Two plays by the same person, close together, bound the first one from above.
 * If a play is followed 8 seconds later by another play, that track ran for at
 * most 8 seconds — whatever else was going on, the person had moved to something
 * else by then.
 *
 * ## Why that only ever justifies deleting one side
 *
 * The bound is a ceiling, not a measurement, and the asymmetry is total:
 *
 * - A **short** gap proves the track cannot have met the threshold. It is a skip,
 *   provably, and safe to remove.
 * - A **long** gap proves nothing at all. Twelve minutes between plays is equally
 *   consistent with listening to the whole track and with walking away after four
 *   seconds. There is no evidence either way.
 *
 * So this only removes what it can prove, and leaves everything else exactly as
 * it is — including the last play of every session, which has no following row
 * and therefore no bound. A repair that guessed at the ambiguous cases would
 * delete real listening to make a nicer-looking number.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { requiredListenSeconds } from "./playRecording";

export interface RepairRow {
    playId: string;
    trackId: string;
    title: string;
    playedAt: Date;
    durationSeconds: number;
    /** Seconds until this user's next play. Null when there isn't one. */
    gapSeconds: number | null;
    /** What the track needed to count. Null when it could never count. */
    requiredSeconds: number | null;
    verdict: "provable-skip" | "unprovable" | "no-following-play";
}

export interface RepairReport {
    totalPlays: number;
    earliest: Date | null;
    latest: Date | null;
    provableSkips: number;
    unprovable: number;
    noFollowingPlay: number;
    /** A sample of what would go, for showing someone before they agree to it. */
    sample: RepairRow[];
}

/**
 * Look at the history without touching it.
 *
 * Everything the UI shows comes from here, so what a user agrees to is exactly
 * what was described to them.
 */
export async function analysePlayHistory(userId: string, sampleSize = 25): Promise<RepairReport> {
    const plays = await prisma.play.findMany({
        where: { userId },
        orderBy: { playedAt: "asc" },
        select: {
            id: true,
            trackId: true,
            playedAt: true,
            track: { select: { title: true, duration: true } },
        },
    });

    const rows: RepairRow[] = plays.map((p, i) => {
        const next = plays[i + 1];
        const gapSeconds = next
            ? (next.playedAt.getTime() - p.playedAt.getTime()) / 1000
            : null;
        const requiredSeconds = requiredListenSeconds(p.track.duration);

        let verdict: RepairRow["verdict"];
        if (gapSeconds === null) {
            verdict = "no-following-play";
        } else if (requiredSeconds === null) {
            // The track is too short to ever count. It was never a legitimate
            // play under the rule, whatever the gap says.
            verdict = "provable-skip";
        } else if (gapSeconds < requiredSeconds) {
            verdict = "provable-skip";
        } else {
            verdict = "unprovable";
        }

        return {
            playId: p.id,
            trackId: p.trackId,
            title: p.track.title,
            playedAt: p.playedAt,
            durationSeconds: p.track.duration,
            gapSeconds,
            requiredSeconds,
            verdict,
        };
    });

    const skips = rows.filter((r) => r.verdict === "provable-skip");

    return {
        totalPlays: rows.length,
        earliest: rows[0]?.playedAt ?? null,
        latest: rows[rows.length - 1]?.playedAt ?? null,
        provableSkips: skips.length,
        unprovable: rows.filter((r) => r.verdict === "unprovable").length,
        noFollowingPlay: rows.filter((r) => r.verdict === "no-following-play").length,
        sample: skips.slice(0, sampleSize),
    };
}

/**
 * Remove the plays the analysis could prove were skips.
 *
 * Deliberately re-derives the verdicts rather than accepting a list of ids from
 * the client: what gets deleted is decided here, on the current data, not by
 * whatever a browser tab computed some minutes ago.
 */
export async function repairPlayHistory(userId: string): Promise<{ removed: number; kept: number }> {
    const report = await analysePlayHistory(userId, Number.MAX_SAFE_INTEGER);
    const doomed = report.sample.map((r) => r.playId);

    if (doomed.length === 0) {
        return { removed: 0, kept: report.totalPlays };
    }

    const { count } = await prisma.play.deleteMany({ where: { id: { in: doomed }, userId } });
    logger.info(
        `[PlayRepair] removed ${count} provable skips for ${userId}, ` +
            `kept ${report.totalPlays - count} (${report.unprovable} unprovable, ` +
            `${report.noFollowingPlay} with no following play)`,
    );
    return { removed: count, kept: report.totalPlays - count };
}
