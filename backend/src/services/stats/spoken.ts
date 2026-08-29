/**
 * Audiobooks and podcasts, where the listening time is real.
 *
 * Both progress tables store an actual position and an actual duration, so
 * none of this is estimated the way music time is. That asymmetry is worth
 * showing rather than hiding — spoken word gets a plain number, music gets an
 * "about".
 *
 * "Set aside" means started, not finished, and untouched for three months. It
 * is deliberately not called "abandoned"; people come back to books.
 */

import { prisma } from "../../utils/db";

const SET_ASIDE_DAYS = 90;

export interface SpokenStats {
    audiobooks: {
        seconds: number;
        finished: number;
        inProgress: number;
        setAside: number;
        topAuthors: Array<{ name: string; seconds: number }>;
        current: { title: string; author: string | null; percent: number } | null;
    };
    podcasts: {
        seconds: number;
        finished: number;
        inProgress: number;
        subscriptions: number;
        /** Episodes from subscribed shows this user has never opened. */
        backlog: number;
    };
}

export async function spokenStats(userId: string): Promise<SpokenStats> {
    const cutoff = new Date(Date.now() - SET_ASIDE_DAYS * 24 * 60 * 60 * 1000);

    const [books, authors, current, casts, subs, backlog] = await Promise.all([
        prisma.$queryRaw<Array<{ secs: number; finished: number; active: number; aside: number }>>`
        SELECT coalesce(sum("currentTime"), 0)::int                                        AS secs,
               count(*) FILTER (WHERE "isFinished")::int                                   AS finished,
               count(*) FILTER (WHERE NOT "isFinished" AND "lastPlayedAt" >= ${cutoff})::int AS active,
               count(*) FILTER (WHERE NOT "isFinished" AND "lastPlayedAt" <  ${cutoff})::int AS aside
        FROM "AudiobookProgress" WHERE "userId" = ${userId}`,

        prisma.$queryRaw<Array<{ name: string; secs: number }>>`
        SELECT author AS name, sum("currentTime")::int AS secs
        FROM "AudiobookProgress"
        WHERE "userId" = ${userId} AND author IS NOT NULL
        GROUP BY 1 ORDER BY secs DESC LIMIT 5`,

        prisma.$queryRaw<Array<{ title: string; author: string | null; percent: number }>>`
        SELECT title, author,
               (CASE WHEN duration > 0 THEN "currentTime" / duration ELSE 0 END)::float8 AS percent
        FROM "AudiobookProgress"
        WHERE "userId" = ${userId} AND NOT "isFinished"
        ORDER BY "lastPlayedAt" DESC LIMIT 1`,

        prisma.$queryRaw<Array<{ secs: number; finished: number; active: number }>>`
        SELECT coalesce(sum("currentTime"), 0)::int                    AS secs,
               count(*) FILTER (WHERE "isFinished")::int               AS finished,
               count(*) FILTER (WHERE NOT "isFinished")::int           AS active
        FROM "PodcastProgress" WHERE "userId" = ${userId}`,

        prisma.podcastSubscription.count({ where: { userId } }),

        prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "PodcastSubscription" s
        JOIN "PodcastEpisode" e ON e."podcastId" = s."podcastId"
        LEFT JOIN "PodcastProgress" pr ON pr."episodeId" = e.id AND pr."userId" = ${userId}
        WHERE s."userId" = ${userId} AND pr.id IS NULL`,
    ]);

    return {
        audiobooks: {
            seconds: books[0]?.secs ?? 0,
            finished: books[0]?.finished ?? 0,
            inProgress: books[0]?.active ?? 0,
            setAside: books[0]?.aside ?? 0,
            topAuthors: authors.map((a) => ({ name: a.name, seconds: a.secs })),
            current: current[0] ?? null,
        },
        podcasts: {
            seconds: casts[0]?.secs ?? 0,
            finished: casts[0]?.finished ?? 0,
            inProgress: casts[0]?.active ?? 0,
            subscriptions: subs,
            backlog: backlog[0]?.n ?? 0,
        },
    };
}
