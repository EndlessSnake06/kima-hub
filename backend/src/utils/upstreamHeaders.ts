/**
 * Converts header values read off an axios response (which can be `true`, an
 * array or an AxiosHeaders) into what Node's `res.setHeader` accepts, for the
 * routes that proxy upstream audio. Passing `true` through makes Node throw.
 */

/** An axios response-header value, before narrowing. */
type UpstreamHeaderValue = string | number | boolean | string[] | object | null | undefined;

/**
 * An upstream header value in a form Node accepts; `undefined` when absent.
 * A valueless header (`true`) becomes an empty string.
 */
export function upstreamHeader(value: UpstreamHeaderValue): string | number | string[] | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.map((entry) => String(entry));
    if (typeof value === "boolean") return value ? "" : undefined;
    // An AxiosHeaders instance, or anything else exotic: stringify rather than
    // throw. A malformed upstream header must not be able to kill the response.
    return String(value);
}

/**
 * Read an upstream header as a non-negative integer, e.g. `content-length`.
 *
 * Returns 0 for a missing, empty, non-numeric or negative value, so callers can
 * test `> 0` for "the upstream told us a real size". Never returns NaN.
 */
export function upstreamHeaderNumber(value: UpstreamHeaderValue): number {
    const narrowed = upstreamHeader(value);
    if (narrowed === undefined) return 0;
    const raw = Array.isArray(narrowed) ? narrowed[0] : narrowed;
    const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
