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
// Imported, not redeclared. Two copies of this number is two definitions of
// what a listen is, and this file deletes rows based on its answer.
import { MIN_LISTEN_WINDOW_SECONDS } from "./stats/listens";

/* ────────────────────────────────────────────────────────────────────────────
 * The audit, rebuilt around listens instead of rows
 *
 * The row-level rule above was written believing each row was one attempt to
 * play something. It is not. Until 1.10.1 the streaming endpoint wrote a row
 * every time the browser asked for another chunk of a file, suppressed for only
 * thirty seconds at a time, so a long track wrote a row every half minute while
 * it played. Measured on a real library: 1.25 rows per listen under three
 * minutes, 5.06 over seven.
 *
 * That breaks the row-level rule at its foundation. Inside one of those runs the
 * gap to the "next play" is the gap to the next chunk — thirty-odd seconds — and
 * the rule reads that as proof the listener bailed. It scored the strongest
 * evidence of listening in the data as the strongest evidence against. On real
 * data it took a nine-minute track played nine times and left one play.
 *
 * ## Two passes
 *
 * 1. **Group.** Rows for the same track less than that track's own length apart
 *    are one listen. While the song could still be playing, another row for it
 *    describes the same listen; once it could have finished, it is a replay.
 *    Measured against a flat five-minute window: duration wrongly splits 10
 *    listens where five minutes wrongly merges 250.
 *
 * 2. **Judge.** A run of rows spanning six minutes is not a guess about six
 *    minutes of listening, it is close to a measurement — those requests
 *    happened while audio was playing. So the span is a floor on what was heard,
 *    and only what happened after the last row needs inferring.
 *
 * The three answers that come out:
 *
 * - **heard** — the span alone clears the threshold. Nothing is inferred.
 * - **unclear** — it might have finished after the last row; left alone.
 * - **skipped** — the span plus everything before the next play still falls
 *   short. Provable, and the only thing offered for deletion.
 *
 * A listen that wrote one row has a span of zero, and this collapses exactly to
 * the old rule. Nothing about the reasoning changed; it now runs on the right
 * unit.
 * ──────────────────────────────────────────────────────────────────────────── */



export type ListenVerdict = "heard" | "unclear" | "skipped" | "never-counts";

export interface Listen {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Rows this one listen wrote. Everything past the first is duplication. */
    rows: number;
    playIds: string[];
    startedAt: Date;
    /** Seconds from the first row to the last: a floor on what was heard. */
    spanSeconds: number;
    /** Seconds from the last row to the next play of anything. */
    gapAfterSeconds: number | null;
    verdict: ListenVerdict;
}

function judge(span: number, gapAfter: number | null, required: number | null): ListenVerdict {
    if (required === null) return "never-counts";
    if (span >= required) return "heard";
    if (gapAfter === null) return "unclear";
    return span + gapAfter < required ? "skipped" : "unclear";
}

/**
 * Every listen in a user's history, with what can and cannot be shown about it.
 *
 * Reads the whole history. That is why nothing calls it on a page load.
 */
export async function listensOf(userId: string): Promise<Listen[]> {
    const plays = await prisma.play.findMany({
        where: { userId },
        // The id is a tiebreaker, not decoration -- see the note in
        // analysePlayHistory. Same reasoning, same consequence if omitted.
        orderBy: [{ playedAt: "asc" }, { id: "asc" }],
        select: {
            id: true,
            trackId: true,
            playedAt: true,
            track: {
                select: {
                    title: true,
                    displayTitle: true,
                    duration: true,
                    album: { select: { artist: { select: { name: true, displayName: true } } } },
                },
            },
        },
    });

    // The gap to the next play of anything, in the order they happened. This is
    // the only thing that can bound a listen from above, so it is measured on
    // the global sequence rather than per track.
    const gapAfterRow = plays.map((p, i) => {
        const next = plays[i + 1];
        return next ? (next.playedAt.getTime() - p.playedAt.getTime()) / 1000 : null;
    });

    const open = new Map<string, Listen>();
    // Where the listen currently open on each track BEGAN — not the last row
    // seen on it.
    //
    // This used to hold the last row, updated on every play. That made the
    // window slide forward with each chunk-write, so a genuine replay starting
    // soon after the previous listen's final chunk was folded into it. Since
    // `collapseDuplicateRows` deletes every play id after the first in a group,
    // that did not merely miscount the replay — it queued its row for
    // permanent deletion. Measured on the live library: 18 real listens across
    // 17 tracks, all of them on heavily replayed tracks, because those are the
    // ones with long runs of rows. Same defect as the SQL had; see
    // `stats/listens.ts` for the proof and the corrected rule.
    const listenStartedAt = new Map<string, number>();
    const out: Listen[] = [];

    plays.forEach((p, i) => {
        const window = Math.max(MIN_LISTEN_WINDOW_SECONDS, p.track.duration);
        const startedAt = listenStartedAt.get(p.trackId);
        // `<`, so a row landing exactly one duration after its listen began
        // opens a new one: at that instant the track has finished, which is the
        // whole test. All three places that decide this now agree — the
        // recording path treats the same instant as a genuine replay rather
        // than a duplicate, and `stats/listens.ts` starts a new listen there.
        const sameListen =
            startedAt !== undefined && (p.playedAt.getTime() - startedAt) / 1000 < window;

        if (sameListen) {
            const listen = open.get(p.trackId)!;
            listen.rows += 1;
            listen.playIds.push(p.id);
            listen.spanSeconds = (p.playedAt.getTime() - listen.startedAt.getTime()) / 1000;
            listen.gapAfterSeconds = gapAfterRow[i];
        } else {
            const listen: Listen = {
                trackId: p.trackId,
                title: p.track.displayTitle ?? p.track.title,
                artist: p.track.album.artist.displayName ?? p.track.album.artist.name,
                durationSeconds: p.track.duration,
                requiredSeconds: requiredListenSeconds(p.track.duration),
                rows: 1,
                playIds: [p.id],
                startedAt: p.playedAt,
                spanSeconds: 0,
                gapAfterSeconds: gapAfterRow[i],
                verdict: "unclear",
            };
            open.set(p.trackId, listen);
            out.push(listen);
            // Only a row that opens a listen becomes the anchor. Advancing this
            // on every row is the bug described above.
            listenStartedAt.set(p.trackId, p.playedAt.getTime());
        }
    });

    for (const listen of out) {
        listen.verdict = judge(listen.spanSeconds, listen.gapAfterSeconds, listen.requiredSeconds);
    }
    return out;
}

export interface FalseStartTrack {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Listens on this track that can be proven to have been skipped. */
    skipped: number;
    /**
     * Listens of a track under 30 seconds, which can never register a play.
     *
     * Counted apart from `skipped` and never deleted. That the recording rule
     * cannot credit a track is a fact about its length, not evidence about
     * whether anybody stayed for it — an interlude heard end to end lands here
     * exactly like one skipped past.
     */
    tooShort: number;
    /** Listens the span alone proves were heard. Nothing inferred. */
    heard: number;
    /** Every listen of this track, whatever the verdict. */
    listens: number;
    /** Rows behind those listens. The excess is pure duplication. */
    rows: number;
    /** The shortest run recorded among the skipped listens. */
    shortestRunSeconds: number | null;
    lastAt: Date;
}

export interface FalseStartAudit {
    /** Rows in the table. Not the number of times anything was listened to. */
    totalRows: number;
    /** What those rows actually represent. */
    totalListens: number;
    /** Rows that are a second or later record of a listen already counted. */
    duplicateRows: number;
    /**
     * Rows a merge would actually delete, which is fewer.
     *
     * A collapse keeps the first AND last row of each listen, because the
     * distance between them is the span every verdict is measured from. So a
     * listen of five rows loses three, not four, and a listen of two loses
     * none. Reporting `duplicateRows` on the button promised a number the
     * merge would not deliver — and once every listen is down to two rows it
     * offered to merge records and removed nothing at all.
     */
    collapsibleRows: number;
    /** Listens the span alone proves were real. */
    heard: number;
    /** Listens that fall short even allowing for everything after the last row. */
    skipped: number;
    /**
     * Listens of tracks under 30 seconds, which can never register a play.
     *
     * Reported apart from `skipped` and never deleted. These used to be added
     * to the skipped total and removed along with it, under a heading reading
     * "listens we can prove nobody stayed for" — which is not what this is. A
     * short interlude heard end to end lands here identically to one skipped
     * past, so the deletion had no proof behind it and the count overstated
     * what the audit had actually established.
     */
    tooShort: number;
    /** Listens with no way to tell. Left alone. */
    unclear: number;
    earliest: Date | null;
    tracks: FalseStartTrack[];
    ignored: Array<{ trackId: string; title: string; artist: string; ignoredAt: Date }>;
}

/** Everything the review screen shows, in one read. Touches nothing. */
export async function auditFalseStarts(userId: string): Promise<FalseStartAudit> {
    const [listens, ignoredRows] = await Promise.all([
        listensOf(userId),
        prisma.playAuditIgnore.findMany({
            where: { userId },
            orderBy: { ignoredAt: "desc" },
            select: {
                trackId: true,
                ignoredAt: true,
                track: {
                    select: {
                        title: true,
                        displayTitle: true,
                        album: { select: { artist: { select: { name: true, displayName: true } } } },
                    },
                },
            },
        }),
    ]);

    const ignoredIds = new Set(ignoredRows.map((r) => r.trackId));
    const byTrack = new Map<string, FalseStartTrack>();

    for (const l of listens) {
        let row = byTrack.get(l.trackId);
        if (!row) {
            row = {
                trackId: l.trackId,
                title: l.title,
                artist: l.artist,
                durationSeconds: l.durationSeconds,
                requiredSeconds: l.requiredSeconds,
                skipped: 0,
                tooShort: 0,
                heard: 0,
                listens: 0,
                rows: 0,
                shortestRunSeconds: null,
                lastAt: l.startedAt,
            };
            byTrack.set(l.trackId, row);
        }
        row.listens += 1;
        row.rows += l.rows;
        if (l.startedAt > row.lastAt) row.lastAt = l.startedAt;
        if (l.verdict === "heard") row.heard += 1;
        if (l.verdict === "never-counts") row.tooShort += 1;
        if (l.verdict === "skipped") {
            row.skipped += 1;
            const ran = l.spanSeconds + (l.gapAfterSeconds ?? 0);
            if (row.shortestRunSeconds === null || ran < row.shortestRunSeconds) {
                row.shortestRunSeconds = ran;
            }
        }
    }

    const tracks = [...byTrack.values()]
        .filter((t) => t.skipped > 0 && !ignoredIds.has(t.trackId))
        .sort((a, b) => b.skipped - a.skipped);

    return {
        totalRows: listens.reduce((n, l) => n + l.rows, 0),
        totalListens: listens.length,
        duplicateRows: listens.reduce((n, l) => n + (l.rows - 1), 0),
        collapsibleRows: collapseCandidates(listens).length,
        heard: listens.filter((l) => l.verdict === "heard").length,
        skipped: listens.filter((l) => l.verdict === "skipped").length,
        tooShort: listens.filter((l) => l.verdict === "never-counts").length,
        unclear: listens.filter((l) => l.verdict === "unclear").length,
        earliest: listens[0]?.startedAt ?? null,
        tracks,
        ignored: ignoredRows.map((r) => ({
            trackId: r.trackId,
            title: r.track.displayTitle ?? r.track.title,
            artist: r.track.album.artist.displayName ?? r.track.album.artist.name,
            ignoredAt: r.ignoredAt,
        })),
    };
}

/**
 * Collapse duplicate records, keeping the first row of every listen.
 *
 * Nothing is judged here and nothing is inferred. A row written while the track
 * was demonstrably still playing describes a listen already counted, and one
 * listen should be one row. Safe to run over the whole history, which is why it
 * takes no list of tracks.
 */
export async function collapseDuplicateRows(userId: string): Promise<{ removed: number }> {
    const listens = await listensOf(userId);
    const doomed = collapseCandidates(listens);
    if (doomed.length === 0) return { removed: 0 };

    let removed = 0;
    for (let i = 0; i < doomed.length; i += 5000) {
        const { count } = await prisma.play.deleteMany({
            where: { id: { in: doomed.slice(i, i + 5000) }, userId },
        });
        removed += count;
    }
    logger.info(`[PlayAudit] ${userId} collapsed ${removed} duplicate rows`);
    return { removed };
}

/**
 * The rows a collapse may delete: everything between the first and the last.
 *
 * First AND last, not first alone. A listen's span is the distance from its
 * first row to its last, and the "heard" verdict is `span >= required`. Keeping
 * only the first row set every span to zero, so every listen the audit had
 * proved was heard dropped to "can't tell" — and, measured on a real history,
 * one listen crossed the other way and became eligible for deletion that had
 * not been. The safe half of the tool was destroying the evidence the judging
 * half runs on.
 *
 * Two rows carry the span exactly, so every verdict survives a collapse
 * unchanged. On the library this was measured against it removes 799 rows
 * rather than 1,644 — 845 rows is what the evidence costs, out of 5,751.
 *
 * Pure, and separate from the delete, so it can be tested without a database.
 * Getting this wrong is expensive and silent.
 */
export function collapseCandidates(listens: Listen[]): string[] {
    return listens.flatMap((l) => (l.playIds.length > 2 ? l.playIds.slice(1, -1) : []));
}

/**
 * Delete the listens that can be proven skipped on the given tracks.
 *
 * Track ids come from the client; play ids never do. Verdicts are recomputed
 * here against current data, so a review screen left open cannot delete
 * something that has since stopped looking like a skip. An ignored track is
 * skipped even when named — the quieter answer wins.
 */
export async function removeFalseStarts(
    userId: string,
    trackIds: string[],
): Promise<{ removed: number; tracks: number }> {
    if (trackIds.length === 0) return { removed: 0, tracks: 0 };
    const wanted = new Set(trackIds);

    const [listens, ignored] = await Promise.all([
        listensOf(userId),
        prisma.playAuditIgnore.findMany({ where: { userId }, select: { trackId: true } }),
    ]);
    const ignoredIds = new Set(ignored.map((r) => r.trackId));

    const doomedListens = listens.filter(
        (l) =>
            wanted.has(l.trackId) &&
            !ignoredIds.has(l.trackId) &&
            l.verdict === "skipped",
    );
    const doomed = doomedListens.flatMap((l) => l.playIds);
    if (doomed.length === 0) return { removed: 0, tracks: 0 };

    let removed = 0;
    for (let i = 0; i < doomed.length; i += 5000) {
        const { count } = await prisma.play.deleteMany({
            where: { id: { in: doomed.slice(i, i + 5000) }, userId },
        });
        removed += count;
    }
    const touched = new Set(doomedListens.map((l) => l.trackId));
    logger.info(`[PlayAudit] ${userId} removed ${removed} rows across ${touched.size} track(s)`);
    return { removed, tracks: touched.size };
}

/** Stop raising these tracks. Deletes nothing; counting is unaffected. */
export async function ignoreTracks(userId: string, trackIds: string[]): Promise<{ ignored: number }> {
    if (trackIds.length === 0) return { ignored: 0 };
    const { count } = await prisma.playAuditIgnore.createMany({
        data: trackIds.map((trackId) => ({ userId, trackId })),
        skipDuplicates: true,
    });
    logger.info(`[PlayAudit] ${userId} ignored ${count} track(s)`);
    return { ignored: count };
}

/** Put tracks back in front of the audit. */
export async function unignoreTracks(userId: string, trackIds: string[]): Promise<{ restored: number }> {
    if (trackIds.length === 0) return { restored: 0 };
    const { count } = await prisma.playAuditIgnore.deleteMany({
        where: { userId, trackId: { in: trackIds } },
    });
    return { restored: count };
}
