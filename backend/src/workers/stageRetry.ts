/**
 * Reported failures a question may have before its record closes as terminal: one ask plus
 * three retries. Waiting for a paused source or a re-issued claim is not a failure.
 */
export const STAGE_RETRY_CAP = 4;

/** Waits before retries 1-3 (1 min, 10 min, 1 h), then the record closes, so a
 * short outage is ridden out and a lasting refusal stops being asked. */
const RETRY_LADDER_MS = [60_000, 600_000, 3_600_000];

/** The wait before the next ask after the given number of reported failures. */
export function computeStageRetryWaitMs(failures: number): number {
    return RETRY_LADDER_MS[Math.min(Math.max(1, failures), 3) - 1];
}
