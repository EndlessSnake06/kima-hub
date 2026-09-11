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
     * Fingerprint an audio file. Returns null on any failure (binary missing,
     * unreadable file, unparseable output) so callers can fall through.
     */
    async fingerprintFile(filePath: string): Promise<Fingerprint | null> {
        if (!(await this.isAvailable())) return null;
        try {
            const { stdout } = await execFileAsync(
                "fpcalc",
                ["-json", filePath],
                { timeout: FPCALC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
            );
            const parsed = JSON.parse(stdout) as {
                duration?: number;
                fingerprint?: string;
            };
            if (
                !parsed.fingerprint ||
                !Number.isFinite(parsed.duration) ||
                (parsed.duration ?? 0) <= 0
            ) {
                logger.debug(`[fpcalc] Incomplete output for ${filePath}`);
                return null;
            }
            return {
                duration: Math.round(parsed.duration as number),
                fingerprint: parsed.fingerprint,
            };
        } catch (err: any) {
            logger.debug(`[fpcalc] Failed for ${filePath}: ${err?.message}`);
            return null;
        }
    }
}

export const fpcalcService = new FpcalcService();
