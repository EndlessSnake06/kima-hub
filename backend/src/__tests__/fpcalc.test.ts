/**
 * fpcalc runs with `-ignore-errors` so a bad frame is skipped, as the analyzer
 * does. A non-zero exit is then a real failure, thrown with its code and
 * stderr; stdout is never parsed after a failed exit. The `child_process` mock
 * honours promisify.custom so execFile resolves `{stdout, stderr}` as in production.
 */


jest.mock("child_process", () => {
    const { promisify } = require("util") as typeof import("util");
    const execFileMock = jest.fn();
    (execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = (
        file: string,
        args: string[],
        opts?: { timeout?: number },
    ) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            execFileMock(file, args, opts ?? {}, (err: unknown, stdout: string, stderr: string) => {
                if (err) {
                    reject(Object.assign(err as Error, { stdout, stderr }));
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    return { execFile: execFileMock };
});

jest.mock("../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { execFile } from "child_process";
import { fpcalcService } from "../services/fpcalc";

const execFileMock = execFile as unknown as jest.Mock;

const FINGERPRINT_JSON = JSON.stringify({
    duration: 213.4,
    fingerprint: "AQAA02pzKUaUokpxJQpzCAc_eNhx...",
});

interface Scenario {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** Queue the scenario the next non-version fpcalc run resolves with. */
function runScenario(sc: Scenario): void {
    execFileMock.mockImplementation(
        (
            _file: string,
            args: string[],
            _opts: unknown,
            cb: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
        ) => {
            // isAvailable() probes `fpcalc -version`; it must keep working.
            if (args.includes("-version")) {
                cb(null, "fpcalc 1.5.1", "");
                return;
            }
            if (sc.ok) {
                cb(null, sc.stdout, sc.stderr);
                return;
            }
            const err = Object.assign(new Error(`Command failed: fpcalc`), {
                code: sc.exitCode,
            });
            cb(err, sc.stdout, sc.stderr);
        },
    );
}

describe("fpcalcService.fingerprintFile", () => {
    beforeEach(() => {
        execFileMock.mockReset();
        // isAvailable() latches after the first probe; reset so each test
        // re-probes through the mock.
        (fpcalcService as unknown as { available: boolean | null }).available = null;
    });

    it("always invokes fpcalc with -ignore-errors (tolerate damaged frames)", async () => {
        runScenario({ ok: true, stdout: FINGERPRINT_JSON, stderr: "", exitCode: 0 });

        const fp = await fpcalcService.fingerprintFile("/music/track.flac");

        expect(fp).toEqual({ duration: 213, fingerprint: "AQAA02pzKUaUokpxJQpzCAc_eNhx..." });
        const run = execFileMock.mock.calls.find((c) =>
            (c[1] as string[]).includes("/music/track.flac"),
        );
        expect(run).toBeDefined();
        const args = run![1] as string[];
        expect(args).toContain("-json");
        // The flag that makes the fingerprinter agree with the analyzer's
        // decode path: skip the undecodable frame, keep fingerprinting.
        expect(args).toContain("-ignore-errors");
    });

    it("throws with the exit code and stderr when fpcalc exits non-zero", async () => {
        runScenario({
            ok: false,
            stdout: "",
            stderr: "ERROR: Error decoding audio frame (End of file)",
            exitCode: 3,
        });

        const err = await fpcalcService.fingerprintFile("/music/bad.flac").catch(
            (e: Error & { exitCode?: number; stderr?: string }) => e,
        );

        expect(err).toBeInstanceOf(Error);
        expect((err as { exitCode?: number }).exitCode).toBe(3);
        expect((err as { stderr?: string }).stderr).toContain(
            "Error decoding audio frame",
        );
        // classifyFailure reads the message: it must carry the REAL reason.
        expect((err as Error).message).toContain("3");
        expect((err as Error).message).toContain("Error decoding audio frame");
    });

    it("never parses stdout after a failed exit", async () => {
        // Even when the killed run left a perfectly good fingerprint in the
        // buffer (the 1.5.1 behaviour that motivated this defect), the failed
        // exit wins: the caller must see the failure, not stale output.
        runScenario({
            ok: false,
            stdout: FINGERPRINT_JSON,
            stderr: "ERROR: Error decoding audio frame (End of file)",
            exitCode: 3,
        });

        const outcome = await fpcalcService
            .fingerprintFile("/music/bad.flac")
            .then(
                (fp) => ({ resolved: true as const, fp }),
                (e: Error) => ({ resolved: false as const, error: e }),
            );

        expect(outcome.resolved).toBe(false);
    });
});
