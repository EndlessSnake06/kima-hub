import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/** fpcalc on a full-length track is fast (<1s typical) but be generous. */
const FPCALC_TIMEOUT_MS = 30000;

interface Fingerprint {
    duration: number;
    fingerprint: string;
}

/**
 * Runner for `fpcalc`, the Chromaprint fingerprinter that feeds AcoustID.
 *
 * chromaprint is installed in the backend Docker image via apt; on dev boxes
 * it may be missing entirely, which must degrade to "AcoustID path disabled"
 * (the enrichment loop falls back to MusicBrainz) instead of crashing the
 * worker. isAvailable() latches after the first probe — the binary cannot
 * appear mid-process in production.
 */
/**
 * A real fpcalc failure. With `-ignore-errors` set, a non-zero exit cannot be
 * explained by a single damaged frame — it is a genuine failure of the run —
 * so the error carries the exit code and fpcalc's stderr text verbatim:
 * classifyFailure reads the message and routes the stage record accordingly.
 */
export class FpcalcFailure extends Error {
    readonly exitCode: number;
    readonly stderr: string;

    constructor(filePath: string, exitCode: number, stderr: string) {
        super(
            `fpcalc exited with code ${exitCode} for ${filePath}` +
                (stderr.trim() ? `: ${stderr.trim()}` : ""),
        );
        this.name = "FpcalcFailure";
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

class FpcalcService {
    private available: boolean | null = null;

    /** True when the fpcalc binary exists and executes. Probed once. */
    async isAvailable(): Promise<boolean> {
        if (this.available !== null) return this.available;
        try {
            await execFileAsync("fpcalc", ["-version"], { timeout: 5000 });
            this.available = true;
        } catch {
            this.available = false;
            logger.warn(
                "[fpcalc] chromaprint fpcalc binary not found — AcoustID identification disabled (install chromaprint or set ACOUSTID_CLIENT_KEY off to silence)"
            );
        }
        return this.available;
    }

    /**
     * Fingerprint an audio file. Throws on any failure (binary missing,
     * non-zero exit, unparseable output) — callers record the failure.
     *
     * Always runs with `-ignore-errors`: fpcalc stops at the first frame it
     * cannot decode, and without the flag a mid-file bad frame both fails the
     * run AND truncates the fingerprint instead of skipping the frame. The
     * analyzer's decode path tolerates damaged frames by design; with the
     * flag the fingerprint path agrees with it about the same file. A
     * non-zero exit WITH the flag is then a real failure, and stdout is never
     * parsed after one — silently using whatever the failed run left in the
     * buffer would make the answer disagree with its own exit code.
     */
    async fingerprintFile(filePath: string): Promise<Fingerprint> {
        if (!(await this.isAvailable())) {
            throw new FpcalcFailure(filePath, -1, "fpcalc binary not available");
        }
        let stdout: string;
        try {
            ({ stdout } = await execFileAsync(
                "fpcalc",
                ["-json", "-ignore-errors", filePath],
                { timeout: FPCALC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
            ));
        } catch (err: any) {
            // Failed exit: do not look at stdout. Report the exit code and
            // fpcalc's own stderr text so the failure is classifiable.
            logger.debug(
                `[fpcalc] Failed for ${filePath} (exit ${err?.code ?? -1}): ${err?.stderr ?? err?.message}`
            );
            throw new FpcalcFailure(
                filePath,
                typeof err?.code === "number" ? err.code : -1,
                typeof err?.stderr === "string" ? err.stderr : "",
            );
        }
        const parsed = JSON.parse(stdout) as {
            duration?: number;
            fingerprint?: string;
        };
        if (
            !parsed.fingerprint ||
            !Number.isFinite(parsed.duration) ||
            (parsed.duration ?? 0) <= 0
        ) {
            throw new FpcalcFailure(
                filePath,
                0,
                "incomplete fpcalc output (no fingerprint or duration)",
            );
        }
        return {
            duration: Math.round(parsed.duration as number),
            fingerprint: parsed.fingerprint,
        };
    }
}

export const fpcalcService = new FpcalcService();
