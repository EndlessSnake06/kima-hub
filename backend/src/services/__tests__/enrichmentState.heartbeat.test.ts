/**
 * Heartbeat-honesty tests for enrichmentState's progress signature.
 *
 * The hang detector keys on lastActivity staleness. These tests pin the rule
 * that lastActivity may ONLY be refreshed by real work (counter changes and
 * status transitions) -- never by phase churn, which runPhase() emits several
 * times per 5-second cycle and which previously kept a wedged "running" loop
 * looking alive forever (the prod hang signature).
 */
import {
    progressSignature,
    shouldRefreshLastActivity,
} from "../enrichmentState";

function baseState(overrides: Record<string, unknown> = {}) {
    return {
        status: "running" as const,
        currentPhase: "artists" as const,
        lastActivity: "2026-01-01T00:00:00.000Z",
        artists: { total: 10, completed: 2, failed: 0 },
        tracks: { total: 100, completed: 20, failed: 0 },
        audio: { total: 100, completed: 30, failed: 1, processing: 2 },
        ...overrides,
    };
}

describe("progressSignature", () => {
    it("changes when an audio counter moves", () => {
        const a = baseState();
        const b = baseState({
            audio: { total: 100, completed: 31, failed: 1, processing: 2 },
        });
        expect(progressSignature(a)).not.toBe(progressSignature(b));
    });

    it("changes when an artist counter moves", () => {
        const a = baseState();
        const b = baseState({ artists: { total: 10, completed: 3, failed: 0 } });
        expect(progressSignature(a)).not.toBe(progressSignature(b));
    });

    it("changes on status transition", () => {
        const a = baseState();
        const b = baseState({ status: "idle" as const });
        expect(progressSignature(a)).not.toBe(progressSignature(b));
    });

    it("changes on paused status", () => {
        const a = baseState();
        const b = baseState({ status: "paused" as const });
        expect(progressSignature(a)).not.toBe(progressSignature(b));
    });

    it("does NOT change on phase rotation alone", () => {
        const a = baseState();
        const b = baseState({ currentPhase: "audio" as const });
        expect(progressSignature(a)).toBe(progressSignature(b));
    });

    it("does NOT change on bookkeeping flags (completionNotificationSent, cache-cleared)", () => {
        const a = baseState();
        const b = baseState({
            completionNotificationSent: true,
            coreCacheCleared: true,
            fullCacheCleared: true,
        });
        expect(progressSignature(a)).toBe(progressSignature(b));
    });

    it("does NOT change on lastActivity alone", () => {
        const a = baseState();
        const b = baseState({ lastActivity: "2026-06-01T00:00:00.000Z" });
        expect(progressSignature(a)).toBe(progressSignature(b));
    });
});

describe("shouldRefreshLastActivity", () => {
    it("returns true when a counter moves (real work)", () => {
        const prev = baseState();
        const next = baseState({
            audio: { total: 100, completed: 31, failed: 1, processing: 2 },
        });
        expect(shouldRefreshLastActivity(prev, next)).toBe(true);
    });

    it("returns true on status transition", () => {
        expect(
            shouldRefreshLastActivity(baseState(), baseState({ status: "idle" as const })),
        ).toBe(true);
        expect(
            shouldRefreshLastActivity(baseState(), baseState({ status: "paused" as const })),
        ).toBe(true);
    });

    it("returns FALSE when only the phase rotates (the false-heartbeat trap)", () => {
        expect(
            shouldRefreshLastActivity(baseState(), baseState({ currentPhase: "audio" as const })),
        ).toBe(false);
        expect(
            shouldRefreshLastActivity(baseState(), baseState({ currentPhase: "vibe" as const })),
        ).toBe(false);
    });

    it("returns FALSE for an identical state (idempotent cycle rewrite)", () => {
        expect(shouldRefreshLastActivity(baseState(), baseState())).toBe(false);
    });

    it("returns FALSE when only lastActivity is newer (pure heartbeat write)", () => {
        const next = baseState({ lastActivity: "2026-06-01T00:00:00.000Z" });
        expect(shouldRefreshLastActivity(baseState(), next)).toBe(false);
    });
});