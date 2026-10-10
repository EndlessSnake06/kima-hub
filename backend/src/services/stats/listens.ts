/**
 * One row per actual listen. A Play row joins the listen in progress while the
 * song could still be playing, measured from where that listen began. Rows
 * further apart than the track's length always split, so the recursive walk
 * only runs inside short bursts. Leaves relation `p`.
 */

import { Prisma } from "@prisma/client";

/**
 * The window clause, or nothing at all for "all". The interval text comes from a
 * closed map keyed by a validated `Period`, never from the request, so `Prisma.raw`
 * cannot carry anything a caller supplied.
 */
function window(period: Period): Prisma.Sql {
    if (period === "all") return Prisma.empty;
    return Prisma.sql`AND "playedAt" >= now() - ${Prisma.raw(`interval '${WINDOW[period]}'`)}`;
}

/** A row closer than this to its listen's start is the same listen. The play-history audit uses it too, so both group alike. */
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

/**
 * A `WITH RECURSIVE` chain ending in `p`, one row per listen; append the rest
 * of the query (extra CTEs with a leading comma). The date window applies after
 * the walk, or a listen starting before it would look like one starting inside
 * it. `onlyTrackId` can narrow the input because the walk is per track.
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
