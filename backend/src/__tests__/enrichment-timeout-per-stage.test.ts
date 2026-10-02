/**
 * Each stage has its own timeout sized to its work: identification a network
 * budget, analysis enough to decode and analyse the first 90 seconds,
 * embedding a CLAP-window budget. Track duration plays no part.
 */

import * as unified from "../workers/unifiedEnrichment";
import { closeEngineConnections } from "./helpers/engineConnections";

afterAll(async () => {
    // Reading constants still loads the module: the four BullMQ queues
    // built at module scope in enrichmentQueues, the enrichmentState
    // singleton's two clients, and the shared Redis client all come with
    // it. Left open, Jest finishes and outlives those sockets.
    await closeEngineConnections();
});

describe("per-stage timeouts", () => {
    describe("each stage has its own timeout", () => {
        it("declares a timeout for exactly the four stages", () => {
            expect(Object.keys(unified.STAGE_TIMEOUT_MS).sort()).toEqual(
                ["analysis", "embedding", "fingerprint", "recording"].sort(),
            );
        });

        it("gives every stage a distinct budget", () => {
            const { recording, analysis, embedding } = unified.STAGE_TIMEOUT_MS;
            expect(recording).not.toBe(analysis);
            expect(recording).not.toBe(embedding);
            expect(analysis).not.toBe(embedding);
        });

        it("sizes each to its real work", () => {
            // Recording is identification: fpcalc (<1s) plus one or two HTTP
            // lookups. A network budget, not a duration budget.
            expect(unified.STAGE_TIMEOUT_MS.recording).toBe(30_000);
            // Analysis decodes the first 90s and runs the Essentia chain;
            // the analyzer's own DECODE_TIMEOUT is 120s. 300s covers the
            // 90s window plus the design's two-minute headroom.
            expect(unified.STAGE_TIMEOUT_MS.analysis).toBe(300_000);
            expect(unified.STAGE_TIMEOUT_MS.analysis).toBeGreaterThanOrEqual(
                90_000 + 120_000,
            );
            // Embedding runs CLAP over the same 90s window — smaller than
            // the full analysis budget, larger than a pure network call.
            expect(unified.STAGE_TIMEOUT_MS.embedding).toBe(120_000);
            expect(unified.STAGE_TIMEOUT_MS.embedding).toBeLessThan(
                unified.STAGE_TIMEOUT_MS.analysis,
            );
        });
    });

    describe("identification shares no budget with anything", () => {
        it("getStageTimeoutMs answers per stage, independent of track duration", () => {
            // The old formula took the track's duration as its input; the
            // stage's real work does not depend on it.
            expect(unified.getStageTimeoutMs("recording")).toBe(30_000);
            expect(unified.getStageTimeoutMs("analysis")).toBe(300_000);
            expect(unified.getStageTimeoutMs("embedding")).toBe(120_000);
            expect(unified.getStageTimeoutMs("recording")).toBe(
                unified.STAGE_TIMEOUT_MS.recording,
            );
        });

        it("the recording budget is smaller than analysis and embedding", () => {
            // Identification must not share (or exceed) the budget of the
            // stages that actually read the file.
            expect(unified.getStageTimeoutMs("recording")).toBeLessThan(
                unified.getStageTimeoutMs("analysis"),
            );
            expect(unified.getStageTimeoutMs("recording")).toBeLessThan(
                unified.getStageTimeoutMs("embedding"),
            );
        });
    });

    describe("the shared-budget function is gone", () => {
        it("computeTrackEnrichmentTimeoutMs no longer exists", () => {
            // One duration-derived formula applied to every stage is exactly
            // the shared budget this section removes — not kept as a
            // fallback, not aliased to the new constants.
            expect(
                (unified as Record<string, unknown>).computeTrackEnrichmentTimeoutMs,
            ).toBeUndefined();
        });

        it("getStageTimeoutMs is the only timeout accessor", () => {
            expect(typeof unified.getStageTimeoutMs).toBe("function");
            expect(
                (unified as Record<string, unknown>).computeStageTimeoutMs,
            ).toBeUndefined();
        });
    });
});