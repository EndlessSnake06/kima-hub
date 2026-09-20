/**
 * Duration-aware per-track enrichment timeout.
 *
 * The casualty this formula supersedes: every metadata job burned a FLAT 30s
 * inside the `getTrackInfo` withTimeout window when a source hung or refused it
 * (dead Last.fm default key -> error 29, a dead analyzer, or any request that
 * simply never answered) and then retried -- producing the signature
 * "1,047 attempt-3 failures / 45 min, 16 cores 96% idle".
 *
 * The fix derives the cap from the track's own duration so a short clip stays
 * tight and a long FLAC buys room:
 *
 *   cap = min(180_000, 30_000 + round(seconds) * 40)
 *
 * i.e. a 30s base floor plus 40ms per second (2.4s per minute), bounded above by
 * the 3-min ceiling. This suite pins the boundaries.
 *
 * Run with: npx jest computeTrackEnrichmentTimeoutMs --no-coverage
 */

import { computeTrackEnrichmentTimeoutMs } from "../unifiedEnrichment";

const BASE_MS = 30_000;
const CAP_MS = 180_000;
const MS_PER_SECOND = 40;

describe("computeTrackEnrichmentTimeoutMs", () => {
    describe("boundaries", () => {
        it("returns exactly the 30s base floor for a 0s track", () => {
            expect(computeTrackEnrichmentTimeoutMs(0)).toBe(BASE_MS);
        });

        it("grows 40ms per second of track, still below the cap", () => {
            // 5 min == 300s -> 30_000 + 300*40 == 42_000.
            expect(computeTrackEnrichmentTimeoutMs(300)).toBe(
                BASE_MS + 300 * MS_PER_SECOND,
            );
        });

        it("caps a 90-minute FLAC at the 3-min ceiling", () => {
            // 90 min == 5400s: 30_000 + 216_000 == 246_000, then clamped to 180_000.
            expect(computeTrackEnrichmentTimeoutMs(60 * 90)).toBe(CAP_MS);
            // Sanity: without the cap this exact duration would blow past it.
            expect(60 * 90 * MS_PER_SECOND + BASE_MS).toBeGreaterThan(CAP_MS);
        });

        it("returns the base floor for a NaN duration", () => {
            expect(computeTrackEnrichmentTimeoutMs(NaN)).toBe(BASE_MS);
        });
    });

    describe("monotonic shape through the band", () => {
        it("is non-decreasing until the cap, then pinned at the cap", () => {
            const seconds = [0, 60, 300, 600, 900, 5400, 6000];
            let prev = BASE_MS - 1;
            for (const s of seconds) {
                const v = computeTrackEnrichmentTimeoutMs(s);
                expect(v).toBeGreaterThanOrEqual(prev);
                prev = v;
            }
            // Both the longest values saturate identically on the ceiling.
            expect(computeTrackEnrichmentTimeoutMs(60 * 90)).toBe(CAP_MS);
            expect(computeTrackEnrichmentTimeoutMs(60 * 100)).toBe(CAP_MS);
        });
    });
});
