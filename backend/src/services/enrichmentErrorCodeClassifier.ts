/**
 * Enrichment failure classes, mirroring `services/audio-analyzer/classifier.py`
 * (same patterns and precedence): MULTICANNEL, UNSUPPORTED, DAMAGED, else
 * INCONCLUSIVE, which stays retryable. Only strong signatures are terminal. A
 * rate limit is not a failure class: the source is paused instead.
 */

export type FailureClass = "DAMAGED" | "UNSUPPORTED" | "MULTICANNEL" | "INCONCLUSIVE";

/** Strong corruption signatures — mirrors `_DAMAGED_PATTERNS` in classifier.py. */
const DAMAGED_PATTERNS: RegExp[] = [
    /truncated/i,
    /\bcrc\b/i,
    /over[hr]ead/i,
    /missing\s+keyframe/i,
    /non[- ]?monotonou[sd]\s+dts/i,
    /error\s+while\s+decoding/i,
    /cannot\s+decode/i,
    /could\s+not\s+decode/i,
    /failed\s+to\s+decode/i,
    /stretched\s+frame/i,
    /invalid\s+start/i,
    /invalid\s+end/i,
    /invalid\s+\S+\s+frame/i,
    /corrupt(?:ed|ion)?\s*(?:bitstream|audio|data|stream|file)/i,
    /malformed\s+(?:audio|bitstream|data|stream|file)/i,
    /decode[_\s]frame\b/i,
    /\bheader\s+missing\b/i,
    /invalid\s+dts/i,
];

/** Codec-the-engine-lacks signatures — mirrors `_UNSUPPORTED_PATTERNS`. */
const UNSUPPORTED_PATTERNS: RegExp[] = [
    /unsupported\s+codec/i,
    /not\s+capable\s+of\s+decoding/i,
    /unknown\s+demuxer/i,
    /decoder\s+.*not\s+found/i,
    /codec\s+.*not\s+found/i,
];

/** MonoLoader refusal signatures — mirrors `_MULTICANNEL_PATTERNS`. */
const MULTICANNEL_PATTERNS: RegExp[] = [
    /more\s+than\s+2\s+audio\s+channels?/i,
    /more\s+than\s+2\s+channels?/i,
    /multichannel/i,
];

function messageOf(err: unknown): string {
    if (!err) return "";
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "";
}

function matchesAny(message: string, patterns: RegExp[]): boolean {
    return patterns.some((re) => re.test(message));
}

/**
 * Classify an error into one of the four ledger classes. An error with no
 * recognizable signature is INCONCLUSIVE — never a generic "Work" code,
 * so the record keeps its evidence and its retry gate.
 */
export function classifyFailure(err: unknown): FailureClass {
    const message = messageOf(err);
    if (!message) return "INCONCLUSIVE";
    if (matchesAny(message, MULTICANNEL_PATTERNS)) return "MULTICANNEL";
    if (matchesAny(message, UNSUPPORTED_PATTERNS)) return "UNSUPPORTED";
    if (matchesAny(message, DAMAGED_PATTERNS)) return "DAMAGED";
    return "INCONCLUSIVE";
}

/**
 * True when a source is refusing us for now: HTTP 429, MusicBrainz's 503, or
 * "rate limit" wording. Callers pause the source rather than record a failure.
 */
export function isRateLimited(err: unknown): boolean {
    if (!err) return false;
    const e = err as {
        response?: { status?: number };
        status?: number;
        message?: string;
    };
    const status: number | undefined =
        typeof e.response?.status === "number"
            ? e.response.status
            : typeof e.status === "number"
              ? e.status
              : undefined;
    const message = typeof e.message === "string" ? e.message : messageOf(err);

    if (/rate\s*limit|rate-limited|too many requests/i.test(message)) return true;
    if (/\b429\b/.test(message)) return true;
    if (status === 429 || status === 503) return true;

    return false;
}