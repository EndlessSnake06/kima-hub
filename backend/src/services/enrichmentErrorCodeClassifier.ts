/**
 * Enrichment failure classification — the Node mirror of
 * `services/audio-analyzer/classifier.py`.
 *
 * The distinction this module exists for: a source refusing our requests
 * (rate limit / quota) is NOT a failure class at all — it is a pause, and
 * it must not consume a retry or brand good work as impossible. What the
 * ledger records instead are the four classes the analyzer's classifier
 * already speaks: DAMAGED / UNSUPPORTED / MULTICANNEL / INCONCLUSIVE.
 *
 * The old API returned `"quota" | "work"`: every error that was not a rate
 * limit got the generic "Work" code, so an unclassifiable error was
 * indistinguishable from a genuinely impossible one. Now an unclassifiable
 * error stays INCONCLUSIVE — retryable, with its raw evidence kept — and
 * there is no generic code to fall through to.
 *
 * Patterns are kept aligned with `classifier.py` (same signatures, same
 * precedence: MULTICANNEL, then UNSUPPORTED, then DAMAGED, else
 * INCONCLUSIVE). Precision dominates recall: a message that is not a
 * strong damage or codec signature stays INCONCLUSIVE rather than being
 * wrongly doomed — retrying a good file that hiccuped is worth more than
 * a speculative terminal tag.
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
 * True when the transport signals a temporary source refusal (rate limit /
 * quota): HTTP 429, MusicBrainz's 503-for-rate-limit, Last.fm's
 * HTTP-200-with-body-error-29 pattern, or explicit "rate limit" wording.
 * A rate limit is NOT a failure class — callers pause the source instead
 * of recording a failure, so the retry ladder is never consumed by
 * someone else's quota ceiling.
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

    // Last.fm error 29 arrives as HTTP 200 with a body error code, not a
    // status — match its message ("... API error 29: ..." / "API error
    // code 29: ..." / "error 29").
    if (/error\s*(?:code\s*)?29/i.test(message)) return true;
    if (/rate\s*limit|rate-limited|too many requests/i.test(message)) return true;
    if (/\b429\b/.test(message)) return true;
    if (status === 429 || status === 503) return true;

    return false;
}