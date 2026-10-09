import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { rateLimiter } from "./rateLimiter";
import { sourcePauseController } from "./sourcePauseController";
import { USER_AGENT, config } from "../config";
import { Outcome, answered, absent, rateLimited, transient, permanent } from "../utils/outcome";
import { titlesAgree } from "./albumIdentity";
import { lengthsAgree, versionOf } from "./recordingMatch";

/**
 * AcoustID lookup client. The POST body is form-encoded with `meta` as
 * "recordings%20releasegroups" (the server does not decode '+'), and the length
 * goes in `duration`. Results without a `recordings` array are skipped.
 * Failures come back as `Outcome` kinds, never as a null that means "nothing".
 */
interface AcoustIDRecording {
    id: string;
    title?: string;
    duration?: number;
    artists?: { id: string; name: string }[];
    releasegroups?: { id: string; title?: string; type?: string }[];
}

interface AcoustIDResultRaw {
    id: string;
    score: number;
    duration?: number;
    recordings?: AcoustIDRecording[];
}

interface AcoustIDLookupResponse {
    status: string;
    results?: AcoustIDResultRaw[];
}

export interface AcoustIDResult {
    recordingMbid: string;
    artistMbid: string;
    releaseGroupMbid: string;
    title: string;
    artist: string;
    album: string;
}

/** Confidence floor: below this AcoustID is effectively guessing. */
const MIN_SCORE = 0.5;

class AcoustIDService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: "https://api.acoustid.org",
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * An explicit key, else the encrypted SystemSettings key, else the config
     * default. Never throws; getSystemSettings is imported lazily to avoid a cycle.
     */
    private async resolveApiKey(explicit?: string): Promise<string | undefined> {
        if (explicit) return explicit;
        try {
            const { getSystemSettings } = await import("../utils/systemSettings");
            const settings = await getSystemSettings();
            if (settings?.acoustidApiKey) return settings.acoustidApiKey;
        } catch (err: any) {
            logger.debug(
                `[AcoustID] Settings read failed, using config key: ${err?.message}`
            );
        }
        return process.env.ACOUSTID_CLIENT_KEY || config.acoustid.clientKey;
    }

    /**
     * application/x-www-form-urlencoded encoding done by hand. URLSearchParams
     * would emit a literal '+' for the space inside the meta parameter, which
     * this server does not decode back to a space (see module docstring).
     */
    private formEncode(params: Record<string, string>): string {
        return Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
    }

    /**
     * Ask AcoustID which recording a fingerprint is; never throws. `duration` is the track's length in
     * seconds, `fingerprint` fpcalc's, and `title` the track's own (`pickFingerprintMatch`).
     */
    async lookup(
        duration: number,
        fingerprint: string,
        options: { clientKey?: string; title?: string } = {}
    ): Promise<Outcome<AcoustIDResult>> {
        const apiKey = await this.resolveApiKey(options.clientKey);
        if (!apiKey) {
            logger.debug("[AcoustID] No client key configured; not asking");
            return permanent(
                "NO_CLIENT_KEY",
                "No AcoustID client key configured — the question was never asked"
            );
        }
        if (!fingerprint || !Number.isFinite(duration) || duration <= 0) {
            logger.debug(
                `[AcoustID] Skipping lookup: fingerprint=${
                    fingerprint ? "present" : "missing"
                }, duration=${duration}`
            );
            return permanent(
                "NO_FINGERPRINT",
                `Cannot ask: fingerprint=${
                    fingerprint ? "present" : "missing"
                }, duration=${duration}`
            );
        }

        try {
            const body = this.formEncode({
                client: apiKey,
                duration: String(Math.round(duration)),
                fingerprint: fingerprint.trim(),
                meta: "recordings releasegroups",
            });
            const response = await rateLimiter.execute("acoustid", () =>
                this.client.post("/v2/lookup", body, {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                })
            );

            const data = response?.data as AcoustIDLookupResponse | undefined;
            if (!data || data.status !== "ok") {
                return transient(
                    "BAD_RESPONSE",
                    `AcoustID returned status '${data?.status ?? "unreadable"}'`
                );
            }
            const picked = this.pickFingerprintMatch(data, duration, options.title);
            if (!picked) {
                logger.debug(
                    `[AcoustID] No confident match for ${Math.round(duration)}s track`
                );
                return absent({
                    askedDuration: Math.round(duration),
                    topScore: data.results?.[0]?.score ?? null,
                    reason:
                        "no result above the confidence floor has a recording of this track's length",
                });
            }

            const { result, recording } = picked;
            const artist = recording.artists?.[0];
            const releaseGroup = recording.releasegroups?.[0];
            const outcome: AcoustIDResult = {
                recordingMbid: recording.id,
                artistMbid: artist?.id || "",
                releaseGroupMbid: releaseGroup?.id || "",
                title: recording.title || "",
                artist: artist?.name || "",
                album: releaseGroup?.title || "",
            };

            logger.debug(
                `[AcoustID] Match recording=${outcome.recordingMbid} rg=${outcome.releaseGroupMbid} title="${outcome.title}"`
            );
            return answered(outcome, {
                score: result.score,
                acoustidId: result.id,
            });
        } catch (error: any) {
            const message = error?.response?.status || error?.message;
            if (await sourcePauseController.handleRateLimit("acoustid", error)) {
                logger.warn(
                    `[AcoustID] Rate limited; source 'acoustid' paused until ${
                        (await sourcePauseController.getPause("acoustid"))?.until?.toISOString() ?? "?"
                    }`
                );
                const pause = await sourcePauseController.getPause("acoustid");
                return rateLimited(
                    pause?.until ?? new Date(Date.now() + 30_000),
                    { reason: "rate-limited", error: String(message) }
                );
            }
            logger.debug(`[AcoustID] Lookup failed: ${message}`);
            return transient("REQUEST_FAILED", String(message));
        }
    }

    /**
     * The first result above the confidence floor that has a recording of this
     * track's length (`lengthsAgree`; the length is the recording's, AcoustID
     * gives none for the result). Among those, a recording whose title is the
     * track's wins, then the closest length. Bare results (a fingerprint with no
     * recording) cannot identify anything and are skipped.
     */
    private pickFingerprintMatch(
        data: AcoustIDLookupResponse,
        duration: number,
        title?: string
    ): { result: AcoustIDResultRaw; recording: AcoustIDRecording } | null {
        for (const result of data.results || []) {
            if (result.score < MIN_SCORE) continue;
            const fits = (result.recordings || []).filter(
                (rec) => lengthsAgree(duration, rec.duration != null ? rec.duration * 1000 : null) !== false
            );
            if (fits.length === 0) continue;
            const titled = title
                ? fits.filter((rec) => !!rec.title && titlesAgree(rec.title, title) && versionOf(rec.title) === versionOf(title))
                : [];
            const gap = (rec: AcoustIDRecording) =>
                rec.duration != null ? Math.abs(rec.duration - duration) : Number.POSITIVE_INFINITY;
            const recording = [...(titled.length > 0 ? titled : fits)].sort((a, b) => gap(a) - gap(b))[0];
            return { result, recording };
        }
        return null;
    }
}

export const acoustidService = new AcoustIDService();