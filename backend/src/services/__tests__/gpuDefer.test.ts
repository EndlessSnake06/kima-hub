/**
 * The GPU embedding-deferral truth table (gpuRuntime.gpuDeferDecision): after the
 * toggle flips on, embedding offers hold while the runtime installs, and nothing
 * else ever defers. Every row is a case someone could ship a bug in.
 */

import { GPU_INSTALL_HOLD_MS, gpuDeferDecision } from "../gpuRuntime";

const T0 = 1_790_000_000_000;
const min = (m: number) => m * 60 * 1000;

describe("gpuDeferDecision", () => {
    it("never defers when the toggle is off", () => {
        expect(
            gpuDeferDecision({ enabled: false, status: "installing", enabledAtMs: T0, nowMs: T0 + min(1) }),
        ).toBe(false);
    });

    it("defers while installing, inside the hold window", () => {
        expect(
            gpuDeferDecision({ enabled: true, status: "installing", enabledAtMs: T0, nowMs: T0 + min(1) }),
        ).toBe(true);
    });

    it("stops deferring the moment the hold window expires, even mid-install", () => {
        expect(
            gpuDeferDecision({
                enabled: true,
                status: "installing",
                enabledAtMs: T0,
                nowMs: T0 + GPU_INSTALL_HOLD_MS + 1,
            }),
        ).toBe(false);
    });

    it("bridges the gap between toggle and first status line", () => {
        // No status file yet (analyzer has not picked the toggle up): hold,
        // inside the window only.
        expect(
            gpuDeferDecision({ enabled: true, status: undefined, enabledAtMs: T0, nowMs: T0 + min(2) }),
        ).toBe(true);
        expect(
            gpuDeferDecision({ enabled: true, status: null, enabledAtMs: T0, nowMs: T0 + min(2) }),
        ).toBe(true);
        expect(
            gpuDeferDecision({
                enabled: true,
                status: undefined,
                enabledAtMs: T0,
                nowMs: T0 + GPU_INSTALL_HOLD_MS + 1,
            }),
        ).toBe(false);
    });

    it("defers on no-status without an enabledAt only never — no timestamp, no hold", () => {
        // enabled.json unreadable: the window cannot be measured, so CPU runs.
        expect(
            gpuDeferDecision({ enabled: true, status: undefined, enabledAtMs: null, nowMs: T0 }),
        ).toBe(false);
    });

    it("releases the stage the moment the runtime is installed", () => {
        expect(
            gpuDeferDecision({ enabled: true, status: "installed", enabledAtMs: T0, nowMs: T0 + min(1) }),
        ).toBe(false);
    });

    it("never holds on a failed install — a broken download cannot freeze the pipeline", () => {
        for (const status of ["failed", "error", "removed", "idle"]) {
            expect(
                gpuDeferDecision({ enabled: true, status, enabledAtMs: T0, nowMs: T0 + min(1) }),
            ).toBe(false);
        }
    });

    it("releases an installing runtime with no measurable window rather than wait blind", () => {
        // enabled.json vanished mid-install: the hold is timed from the toggle,
        // and a hold nobody can time must expire, not run forever. CPU proceeds.
        expect(
            gpuDeferDecision({ enabled: true, status: "installing", enabledAtMs: null, nowMs: T0 }),
        ).toBe(false);
    });
});
