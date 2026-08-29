/**
 * One row per actual listen, instead of one row per record. The only copy.
 *
 * ## What this corrects in the data
 *
 * Until 1.10.1 the streaming endpoint wrote a Play row every time the browser
 * asked for another chunk of a file, suppressed only for thirty seconds at a
 * time. So a long track wrote a row roughly every half minute while it played,
 * and a short one wrote two. Measured against a real library: 1.25 rows per
 * listen under three minutes, and 5.06 over seven. Counting rows therefore does
 * not measure listening, it measures file size — left uncorrected it put an
 * artist of nine-minute tracks fourth in a top ten they belong tenth in.
 *
 * That history is fixed and will not grow, because 1.10.1 stopped writing those
 * rows. It still has to be read correctly, because the eight months already
 * recorded do not repair themselves.
 *
 * ## The rule, and the bug it replaces (2026-08-25)
 *
 * A row belongs to the listen already in progress while the song could still be
 * playing; once the song could have finished, the row is a genuine replay.
 *
 * The previous implementation measured that from the PREVIOUS ROW rather than
 * from where the listen began — a `LAG` over the track's plays. Those two rules
 * are identical only when a listen produces one row, and diverge exactly when
 * it produces a run of them, which is the entire situation this exists for.
 * Each dropped chunk-write reset the clock, so a replay starting soon after the
 * last chunk of the previous listen was swallowed into it.
 *
 * Proven on the live library. "GUNGHO", 214 seconds long, has plays at +0, +44,
 * +126, +173 and +230 seconds. The middle three are chunk-writes and are
 * correctly dropped. The one at +230 is a real replay — the track ended at 214
 * — but it sits only 57 seconds after the row before it, so the old rule
 * counted the whole thing as one listen. Across the library that lost 18
 * listens of 4,107, and it lost them from the most-replayed tracks, because
 * those are the ones with long runs of rows.
 *
 * ## Why this needs a recursive walk, and why it is still cheap
 *
 * "Distance from the start of the current listen" cannot be written with a
 * window function, because where the current listen started depends on the
 * decisions already made about earlier rows. That is a gaps-and-islands problem
 * and it has to be walked in order.
 *
 * Walked naively — one recursion step per row-position within a track — it cost
 * 177ms against 9ms for the broken window-function version, a 20x regression on
 * a helper that twelve queries embed. The depth was the busiest track's total
 * row count, 142 on the measured library, and the cost is per iteration rather
 * than per row.
 *
 * Almost all of that depth is unnecessary. Two consecutive rows further apart
 * than the track is long ALWAYS start separate listens — no walking required,
 * a `LAG` settles it. Only a run of rows packed closer than that is ambiguous,
 * and those runs are short: they are one listen's worth of chunk-writes. So the
 * cheap rule partitions the plays into runs, and the walk happens inside a run,
 * where the depth is the longest single burst rather than the whole history.
 *
 * The relation this leaves behind is called `p`, and it carries every column any
 * caller needs — one join to `Track` here rather than one in each caller.
 */

import { Prisma } from "@prisma/client";

/**
 * The window clause, or nothing at all for "all".
 *
 * The interval text is chosen from a closed map keyed by a validated `Period`,
 * never taken from the request, so `Prisma.raw` here cannot carry anything a
 * caller supplied.
 */
function window(period: Period): Prisma.Sql {
    if (period === "all") return Prisma.empty;
    return Prisma.sql`AND "playedAt" >= now() - ${Prisma.raw(`interval '${WINDOW[period]}'`)}`;
}

/**
 * A row closer than this to its listen's start is the same listen, always.
 *
 * Exported because the play-history audit groups the same rows in TypeScript in
 * order to name the individual plays it would delete, and the two groupings
 * deciding differently is how a maintenance tool comes to remove a listen the
 * stats page is still counting.
 */
export const MIN_LISTEN_WINDOW_SECONDS = 30;

/** The windows the page offers. Rolling, so there is no start-of-month cliff. */
export type Period = "30d" | "12mo" | "all";

/** Guard a string off the wire into a `Period`, defaulting to all time. */
export function asPeriod(value: unknown): Period {
    return value === "30d" || value === "12mo" ? value : "all";
}

/** How far back each window reaches, said the way Postgres wants it. */
const WINDOW: Record<Exclude<Period, "all">, string> = {
    "30d": "30 days",
    "12mo": "12 months",
};

/** What the window is called in a sentence. */
export const PERIOD_LABEL: Record<Period, string> = {
    "30d": "the last 30 days",
    "12mo": "the last 12 months",
    all: "all time",
};

/**
 * A `WITH RECURSIVE` chain ending in a relation `p`: one row per listen.
 *
 * Append the rest of the query to it. Callers needing further CTEs of their own
 * add them with a leading comma, as with any `WITH` list.
 *
 * ## Why the window is applied last, not first
 *
 * The obvious way to add a date filter is to put it in the `WHERE` beside the
 * user id, so the recursion only walks rows in range. That is wrong at the
 * boundary. A listen that began just before the window opens can have its
 * chunk-writes land inside it, and with the earlier rows filtered away the
 * first surviving chunk looks like the start of a listen — inventing a play
 * that never happened, at the edge of every window, every time.
 *
 * So the walk always sees the whole history and the window is applied to its
 * result. A row is in the window because the listen it opens is, which is the
 * only definition that makes "listens in the last 30 days" mean what it says.
 * It also costs nothing extra: the recursion was walking those rows anyway.
 */
/**
 * @param onlyTrackId Restrict the walk to one track.
 *
 * Safe to push into the input, unlike the date window above, and for a reason
 * worth stating: the walk is partitioned by track, so a track's listens are
 * decided entirely by that track's own rows. Narrowing the input to one track
 * removes nothing the answer depended on. The date window is the opposite case
 * — it cuts across every partition midway — which is why one is applied before
 * the walk and the other after.
 */
export function listenRows(
    userId: string,
    period: Period = "all",
    onlyTrackId?: string,
): Prisma.Sql {
    return Prisma.sql`
        WITH RECURSIVE ordered AS (
            SELECT p.id, p."trackId", p."playedAt", p.source,
                   t.duration, t."albumId", t."trackNo",
                   t.energy, t.valence, t.bpm, t.key, t."keyScale",
                   t.instrumentalness, t."dynamicRange", t.acousticness,
                   GREATEST(t.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS listen_window,
                   -- A gap wider than the track is long settles the row on its
                   -- own: nothing that far from its predecessor can be the same
                   -- listen, whatever happened before it.
                   coalesce(EXTRACT(EPOCH FROM (p."playedAt" - LAG(p."playedAt")
                       OVER (PARTITION BY p."trackId" ORDER BY p."playedAt", p.id))), 1e9)
                       > GREATEST(t.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS opens_run
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            WHERE p."userId" = ${userId}
              ${onlyTrackId ? Prisma.sql`AND p."trackId" = ${onlyTrackId}` : Prisma.empty}
        ),
        -- Two passes, because Postgres will not let a window function appear
        -- inside another one's PARTITION BY: number the runs first, then
        -- number the rows within a run.
        grouped AS (
            SELECT o.*,
                   sum(CASE WHEN o.opens_run THEN 1 ELSE 0 END)
                       OVER (PARTITION BY o."trackId" ORDER BY o."playedAt", o.id) AS run_id
            FROM ordered o
        ),
        runs AS (
            SELECT g.*,
                   row_number() OVER (PARTITION BY g."trackId", g.run_id
                                      ORDER BY g."playedAt", g.id) AS seq
            FROM grouped g
        ),
        -- Inside a run every row sits within one duration of the row before it,
        -- so which of them open listens depends on the running decision. Walk
        -- it, carrying the timestamp the current listen began at. Depth here is
        -- the longest single burst of rows, not the track's whole history.
        walk AS (
            SELECT r.*, r."playedAt" AS listen_started, TRUE AS starts_listen
            FROM runs r
            WHERE r.seq = 1
          UNION ALL
            SELECT r.*,
                   -- Greater-or-equal: at exactly one duration the track has
                   -- finished, so that row opens a new listen. The recording
                   -- path and the audit draw the line in the same place.
                   CASE WHEN EXTRACT(EPOCH FROM (r."playedAt" - w.listen_started)) >= r.listen_window
                        THEN r."playedAt" ELSE w.listen_started END,
                   EXTRACT(EPOCH FROM (r."playedAt" - w.listen_started)) >= r.listen_window
            FROM runs r
            JOIN walk w ON w."trackId" = r."trackId"
                       AND w.run_id = r.run_id
                       AND r.seq = w.seq + 1
        ),
        p AS (SELECT * FROM walk WHERE starts_listen ${window(period)})`;
}
