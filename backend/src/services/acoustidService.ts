import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { rateLimiter } from "./rateLimiter";
import { USER_AGENT, config } from "../config";

/**
 * AcoustID lookup client (https://api.acoustid.org/v2/lookup).
 *
 * Wire format verified live against api.acoustid.org on 2026-09-10 with a
 * real Chromaprint fingerprint (Carpenter Brut, score 0.9986):
 *  - POST body must be application/x-www-form-urlencoded. AcoustID's server
 *    percent-decodes WITHOUT form '+'-means-space handling, so "meta" must be
 *    space-separated and encoded as %20 — "recordings+releasegroups" is read
 *    as one invalid token and silently degrades the response to bare
 *    {id, score} with no recordings attached.
 *  - The duration parameter is named "duration" (not "track").
 *  - The response is {status: "ok", results: [...]} — each result carries
 *    {id: <recording MBID>, score, recordings: [{id, title, artists,
 *    releasegroups}]}. Results without a "recordings" array exist (bare
 *    fingerprint match) and must be skipped.
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
/** Matches shorter than this are jingles/samples, not library tracks. */
const MIN_DURATION = 30;

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
     * Look up a track by its Chromaprint fingerprint.
     *
     * @param duration Track length in seconds (AcoustID scores against it).
     * @param fingerprint Chromaprint fingerprint as produced by `fpcalc`.
     * @returns The best matching recording + release-group identity, or null
     * when there is no confident match or the call failed. Null is the
     * contract that lets the caller fall through to MusicBrainz silently —
     * this function never throws.
     */
    async lookup(
        duration: number,
        fingerprint: string
    ): Promise<AcoustIDResult | null> {
        const apiKey = process.env.ACOUSTID_CLIENT_KEY || config.acoustid.clientKey;
        if (!apiKey) {
            logger.debug("[AcoustID] No client key configured; skipping lookup");
            return null;
        }
        if (!fingerprint || !Number.isFinite(duration) || duration <= 0) {
            logger.debug(
                `[AcoustID] Skipping lookup: fingerprint=${
                    fingerprint ? "present" : "missing"
                }, duration=${duration}`
            );
            return null;
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
            const recording = this.pickRecording(data, duration);
            if (!recording) {
                logger.debug(
                    `[AcoustID] No confident match for ${Math.round(duration)}s track`
                );
                return null;
            }

            const artist = recording.artists?.[0];
            const releaseGroup = recording.releasegroups?.[0];
            const result: AcoustIDResult = {
                recordingMbid: recording.id,
                artistMbid: artist?.id || "",
                releaseGroupMbid: releaseGroup?.id || "",
                title: recording.title || "",
                artist: artist?.name || "",
                album: releaseGroup?.title || "",
            };

            logger.debug(
                `[AcoustID] Match recording=${result.recordingMbid} rg=${result.releaseGroupMbid} title="${result.title}"`
            );
            return result;
        } catch (error: any) {
            // Network failure, bad key, non-2xx — all fall through to the
            // MusicBrainz path. Never throw from here: AcoustID is best-effort.
            logger.debug(
                `[AcoustID] Lookup failed: ${error?.response?.status || error?.message}`
            );
            return null;
        }
    }

    /**
     * Walk the ranked results and return the first recording that passes the
     * confidence floor and the duration sanity window. Bare results (fingerprint
     * match with no attached recording metadata) are skipped — they cannot
     * identify anything for us.
     */
    private pickRecording(
        data: AcoustIDLookupResponse | undefined,
        duration: number
    ): AcoustIDRecording | null {
        if (!data || data.status !== "ok") return null;
        const results = data.results || [];

        for (const result of results) {
            if (result.score < MIN_SCORE) continue;
            const resultDuration = result.duration ?? duration;
            if (
                resultDuration < MIN_DURATION ||
                Math.abs(resultDuration - duration) > duration * 0.5
            ) {
                continue;
            }
            const recording = result.recordings?.[0];
            if (recording) return recording;
        }
        return null;
    }
}

export const acoustidService = new AcoustIDService();
