/**
 * Whether a recording a source offers is this track: the same title, version and
 * length, and an artist the track is credited to. The ISRC, album-tracklist and
 * name-search paths all pick through this check; AcoustID, whose evidence is the
 * audio, matches on length and title and asks no artist (`pickFingerprintMatch`).
 */
import { titlesAgree } from "./albumIdentity";
import { artistIdentityKey, artistSortName } from "./artistIdentity";

/** An ISRC in its canonical 12-character form (country, registrant, year, designation), or null when the
 * text is not one. Hyphens and spaces are dropped and letters upper-cased first. */
export function normalizeIsrc(text: string | null | undefined): string | null {
    const code = (text ?? "").replace(/[\s-]/g, "").toUpperCase();
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) ? code : null;
}

export interface ExpectedRecording {
    title: string;
    /** Every name the track is credited to locally: its own artist tag and its album artist. */
    artists: string[];
    /** Whole seconds, as the scanner stores them; null when unknown. */
    durationSec: number | null;
}

export interface CandidateRecording {
    id: string;
    title: string;
    lengthMs: number | null;
    /** Each credited artist's name as the source gives it, and the whole credit as one line ("Hall & Oates"). */
    artists: string[];
    /** The source's own relevance score, higher is better, when it gives one. */
    score?: number;
}

/**
 * The most a file's length may differ from the source's length for the same recording. On 293 library
 * tracks identified by their own recording tags, 291 were within 1.9 s and one 4.0 s; other versions of a
 * song (edits, live takes) differ by 70 s or more.
 */
export const LENGTH_TOLERANCE_SEC = 5;

const VERSION_WORDS = [
    "remix", "mix", "dub", "edit", "live", "acoustic", "demo", "instrumental",
    "reprise", "rework", "unplugged", "session", "version", "karaoke", "cover",
];

/** The version words a title carries (remix, live, acoustic...), sorted, so two titles of different versions differ. */
export function versionOf(title: string): string {
    const words = title.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u);
    return [...new Set(words.filter((w) => VERSION_WORDS.includes(w)))].sort().join(" ");
}

/** True when both lengths are known and agree, false when both are known and differ, null when either is unknown. */
export function lengthsAgree(fileSec: number | null, sourceMs: number | null): boolean | null {
    if (fileSec == null || fileSec <= 0 || sourceMs == null || sourceMs <= 0) return null;
    return Math.abs(sourceMs / 1000 - fileSec) <= LENGTH_TOLERANCE_SEC;
}

function nameKeys(name: string): string[] {
    const key = artistIdentityKey(name);
    const sorted = artistIdentityKey(artistSortName(name));
    return [key, sorted].filter((k) => k !== "");
}

/** Whether any locally credited name is one of the source's credited names. */
export function artistsAgree(local: string[], credited: string[]): boolean {
    const offered = new Set(credited.flatMap(nameKeys));
    return local.some((name) => nameKeys(name).some((k) => offered.has(k)));
}

/** Whether this candidate is the track: title, version and artist agree, and the lengths agree when both are known. */
export function recordingAgrees(candidate: CandidateRecording, expected: ExpectedRecording): boolean {
    return (
        titlesAgree(candidate.title, expected.title) &&
        versionOf(candidate.title) === versionOf(expected.title) &&
        artistsAgree(expected.artists, candidate.artists) &&
        lengthsAgree(expected.durationSec, candidate.lengthMs) !== false
    );
}

/**
 * The candidate that is the track, or null when none agrees. Among agreeing
 * candidates a known, agreeing length beats an unknown one, then the source's
 * score, then the closer length.
 */
export function pickRecording<T extends CandidateRecording>(
    candidates: T[],
    expected: ExpectedRecording,
): T | null {
    const agreeing = candidates.filter((c) => recordingAgrees(c, expected));
    if (agreeing.length === 0) return null;
    const gap = (c: T) =>
        c.lengthMs == null || expected.durationSec == null
            ? Number.POSITIVE_INFINITY
            : Math.abs(c.lengthMs / 1000 - expected.durationSec);
    return [...agreeing].sort((a, b) => {
        const known = Number(gap(a) === Number.POSITIVE_INFINITY) - Number(gap(b) === Number.POSITIVE_INFINITY);
        if (known !== 0) return known;
        const score = (b.score ?? 0) - (a.score ?? 0);
        if (score !== 0) return score;
        return gap(a) - gap(b);
    })[0];
}
