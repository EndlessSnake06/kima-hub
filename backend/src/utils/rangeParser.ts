export type RangeParseResult =
    | { ok: true; start: number; end: number }
    | { ok: false; status: 416; reason: "unsatisfiable" }
    | { ok: false; status: 200; reason: "multi" };

/**
 * Parse a Range header into byte offsets: standard, open-ended and suffix
 * (bytes=-N) ranges, with the end clamped to the file (RFC 7233 §2.1).
 * Multi-range requests return reason "multi" and callers serve the whole file
 * as 200, which RFC 9110 §14.2 permits.
 */
export function parseRangeHeader(
    rangeHeader: string,
    fileSize: number
): RangeParseResult {
    const value = rangeHeader.replace(/bytes=/, "");

    if (value.includes(",")) {
        return { ok: false, status: 200, reason: "multi" };
    }

    const parts = value.split("-");
    const startPart = parts[0];
    const endPart = parts[1];

    let start: number;
    let end: number;

    if (startPart === "") {
        const suffixLength = parseInt(endPart || "", 10);
        if (Number.isNaN(suffixLength) || suffixLength <= 0) {
            return { ok: false, status: 416, reason: "unsatisfiable" };
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        const parsedStart = parseInt(startPart, 10);
        const parsedEnd = endPart ? parseInt(endPart, 10) : fileSize - 1;

        if (Number.isNaN(parsedStart)) {
            return { ok: false, status: 416, reason: "unsatisfiable" };
        }

        start = parsedStart;
        end = Number.isNaN(parsedEnd) ? fileSize - 1 : parsedEnd;
    }

    // Clamp end to file boundary per RFC 7233 Section 2.1
    end = Math.min(end, fileSize - 1);

    // Validate range
    if (start >= fileSize || start > end || start < 0) {
        return { ok: false, status: 416, reason: "unsatisfiable" };
    }

    return { ok: true, start, end };
}
