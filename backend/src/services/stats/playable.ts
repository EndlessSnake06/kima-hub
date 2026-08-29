/**
 * Turning a figure on the stats page into something you can put on.
 *
 * A page of numbers about music that cannot play any of it is a report. The
 * difference between a report and a tool is whether the interesting thing you
 * just noticed can be acted on without leaving the page — "seven thousand
 * tracks you have never played" should be one press away from playing some of
 * them, not a fact to feel bad about.
 *
 * Every slice below corresponds to something the page states. Nothing here
 * invents a new query the reader has not already been shown the answer to.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { listenRows, type Period } from "./listens";

/** The shape the player wants. Matches what the library routes hand back. */
export interface PlayableTrack {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
}

// "region" was in this union and in the route's allow-list, but `playableSlice`
// has no case for it, so /stats/tracks?of=region answered 200 with an empty
// list. Nothing asked for it — the taste plot's region readout uses
// /stats/region, which is a different endpoint and does work. Removed rather
// than left advertised; playing a corner of the plot would be a good feature,
// and it should be written before it is offered.
export type Slice = "top" | "never" | "core" | "key" | "decade";

const MAX_TRACKS = 100;

/**
 * The two ways the analyser may spell one pitch.
 *
 * Essentia writes whichever spelling its key detector settles on, so the same
 * pitch appears as both "C#" and "Db" across a library. Anything that counts by
 * pitch has to fold them, and anything that then queries by pitch has to accept
 * both — the wheel folded and the query did not, which is how a wedge could
 * show hundreds of listens and hand back nothing.
 */
const ENHARMONIC: Record<string, [string, string]> = {
    "F#": ["F#", "Gb"], "Gb": ["F#", "Gb"],
    "Db": ["Db", "C#"], "C#": ["Db", "C#"],
    "Ab": ["Ab", "G#"], "G#": ["Ab", "G#"],
    "Eb": ["Eb", "D#"], "D#": ["Eb", "D#"],
    "Bb": ["Bb", "A#"], "A#": ["Bb", "A#"],
    "B": ["B", "Cb"], "Cb": ["B", "Cb"],
    "E": ["E", "Fb"], "Fb": ["E", "Fb"],
    "F": ["F", "E#"], "E#": ["F", "E#"],
    "C": ["C", "B#"], "B#": ["C", "B#"],
};

/** Every spelling that means this pitch, including the one asked for. */
export function spellingsOf(pitch: string): string[] {
    return ENHARMONIC[pitch] ?? [pitch];
}

/** One listen per record, the same view every other figure is built on. */

interface Row {
    id: string; title: string; duration: number;
    artist_id: string; artist_name: string;
    album_id: string; album_title: string; cover: string | null;
}

const shape = (rows: Row[]): PlayableTrack[] =>
    rows.map((r) => ({
        id: r.id,
        title: r.title,
        duration: r.duration,
        artist: { id: r.artist_id, name: r.artist_name },
        album: { id: r.album_id, title: r.album_title, coverArt: r.cover },
    }));

/** The columns every slice returns, so the player always gets the same shape. */
const SELECT = Prisma.sql`
    t.id, coalesce(t."displayTitle", t.title) AS title, t.duration,
    ar.id AS artist_id, coalesce(ar."displayName", ar.name) AS artist_name,
    al.id AS album_id, coalesce(al."displayTitle", al.title) AS album_title,
    coalesce(al."userCoverUrl", al."coverUrl") AS cover`;

const JOINS = Prisma.sql`
    JOIN "Album"  al ON al.id = t."albumId"
    JOIN "Artist" ar ON ar.id = al."artistId"`;

export async function playableSlice(params: {
    userId: string;
    slice: Slice;
    /** For "key": e.g. "E minor". For "decade": 1990. */
    key?: string;
    decade?: number;
    limit?: number;
    /**
     * The window the page was showing when the button was pressed.
     *
     * "Play those 64" has to hand back the 64 the reader just read about. If
     * the page says 64 songs are half of the last 30 days and this returns the
     * all-time 64, the button quietly plays a different set than the sentence
     * beside it names. The slices that read the shelf rather than the listening
     * — "never" and "decade" — ignore it, because they are not about a period.
     */
    period?: Period;
}): Promise<PlayableTrack[]> {
    const { userId, slice, key, decade, period = "all" } = params;
    // Defended here as well as at the route, because NaN survives every guard
    // that looks like one: it is not nullish so `?? 40` keeps it, and
    // `Math.min`/`Math.max` both return it. Measured: a NaN limit reaching this
    // function returned 628 tracks — the whole set, straight past MAX_TRACKS —
    // rather than erroring, which is the worse of the two failures.
    const asked = Number(params.limit);
    const limit = Math.min(MAX_TRACKS, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 40));

    switch (slice) {
        case "top":
        case "core": {
            // "core" is the handful that make up half the listening, so it is
            // the same ordering — the page has already said how many.
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                ${listenRows(userId, period)}
                SELECT ${SELECT}, count(*)::int AS n
                FROM p JOIN "Track" t ON t.id = p."trackId" ${JOINS}
                GROUP BY t.id, t."displayTitle", t.title, t.duration, ar.id, ar."displayName", ar.name,
                         al.id, al."displayTitle", al.title, al."userCoverUrl", al."coverUrl"
                ORDER BY n DESC LIMIT ${limit}`);
            return shape(rows);
        }

        case "never": {
            // Shuffled, because a fixed order would hand back the same corner of
            // the alphabet every time and the point is to find something.
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                SELECT ${SELECT}
                FROM "Track" t ${JOINS}
                WHERE al.location = 'LIBRARY'
                  AND NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = t.id AND p."userId" = ${userId})
                ORDER BY random() LIMIT ${limit}`);
            return shape(rows);
        }

        case "key": {
            const [pitch, scale] = (key ?? "").split(" ");
            if (!pitch || (scale !== "major" && scale !== "minor")) return [];
            // Both spellings, because the analyser writes either and the wheel
            // draws one wedge for the pair. Matching the wedge's own label
            // exactly made a press do nothing at all: on the library this was
            // found against there are 379 tracks written "C#" and none written
            // "Db", yet the wheel counts them into a wedge labelled Db — so it
            // showed a large number and returned an empty queue, silently.
            const pitches = spellingsOf(pitch);
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                ${listenRows(userId, period)}
                SELECT ${SELECT}, count(*)::int AS n
                FROM p JOIN "Track" t ON t.id = p."trackId" ${JOINS}
                WHERE t.key IN (${Prisma.join(pitches)}) AND t."keyScale" = ${scale}
                GROUP BY t.id, t."displayTitle", t.title, t.duration, ar.id, ar."displayName", ar.name,
                         al.id, al."displayTitle", al.title, al."userCoverUrl", al."coverUrl"
                ORDER BY n DESC LIMIT ${limit}`);
            return shape(rows);
        }

        case "decade": {
            if (!decade) return [];
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                SELECT ${SELECT}
                FROM "Track" t ${JOINS}
                WHERE al.location = 'LIBRARY'
                  AND coalesce(al."displayYear", al.year) BETWEEN ${decade} AND ${decade + 9}
                ORDER BY random() LIMIT ${limit}`);
            return shape(rows);
        }

        default:
            return [];
    }
}
