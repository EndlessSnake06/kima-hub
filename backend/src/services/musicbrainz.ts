import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import { sourcePauseController } from "./sourcePauseController";
import {
    Outcome,
    answered,
    absent,
    rateLimited,
    transient,
    permanent,
} from "../utils/outcome";
import { USER_AGENT } from "../config";

/**
 * MusicBrainz Web Service v2 client. Every method returns an `Outcome`, so a
 * failed or rate-limited call is never mistaken for "the source has nothing".
 * `answered` is cached 30 days and `absent` 7; failures are never cached.
 */

const ANSWERED_TTL = 30 * 24 * 3600;
const ABSENT_TTL = 7 * 24 * 3600;

interface CacheEnvelope {
    __outcome: "answered" | "absent";
    value?: unknown;
    evidence?: Record<string, unknown>;
    savedAt?: string;
}

type StrategyError = { code: string; message: string };

class MusicBrainzService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: process.env.MUSICBRAINZ_BASE_URL || "https://musicbrainz.org/ws/2",
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * Every HTTP call goes through the rate limiter so that methods making
     * several calls (searchRecording, searchAlbum) cannot exceed the
     * 1 req/s limit.
     */
    private async rateLimitedGet(url: string, config?: any): Promise<any> {
        return rateLimiter.execute("musicbrainz", () =>
            this.client.get(url, config)
        );
    }

    /**
     * Classify a source error: a rate limit extends the MusicBrainz pause
     * (`rateLimited`), a 404 on a lookup is `absent`, other 4xx except timeouts
     * are `permanent`, and 5xx or transport errors are `transient`.
     */
    private async classifyError(
        err: any,
        notFoundMeansAbsent: boolean
    ): Promise<Outcome<never>> {
        if (await sourcePauseController.handleRateLimit("musicbrainz", err)) {
            const pause = await sourcePauseController.getPause("musicbrainz");
            return rateLimited(
                pause?.until ?? new Date(Date.now() + 30_000),
                { reason: "rate-limited", detail: String(err?.message ?? err) }
            );
        }
        const status = err?.response?.status;
        if (status === 404 && notFoundMeansAbsent) {
            return absent({ status: 404 });
        }
        const code =
            status !== undefined
                ? `HTTP_${status}`
                : err?.code === "ECONNABORTED"
                  ? "TIMEOUT"
                  : "NETWORK";
        if (
            status !== undefined &&
            status >= 400 &&
            status < 500 &&
            status !== 408
        ) {
            return permanent(code, String(err?.message ?? err));
        }
        return {
            kind: "transient",
            error: { code, message: String(err?.message ?? err) },
        };
    }

    private async cachedOutcome<T>(
        cacheKey: string,
        fetch: () => Promise<Outcome<T>>
    ): Promise<Outcome<T>> {
        try {
            const raw = await redisClient.get(cacheKey);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw) as CacheEnvelope;
                    if (parsed?.__outcome === "answered") {
                        return {
                            kind: "answered",
                            value: parsed.value as T,
                            evidence: {
                                ...parsed.evidence,
                                cached: true,
                                cachedAt: parsed.savedAt,
                            },
                        };
                    }
                    if (parsed?.__outcome === "absent") {
                        return {
                            kind: "absent",
                            evidence: {
                                ...parsed.evidence,
                                cached: true,
                                cachedAt: parsed.savedAt,
                            },
                        };
                    }
                } catch {
                    // unparseable cache value
                }
                // Legacy entry (raw pre-Outcome value) or garbage: drop it
                // and ask the source again.
                await redisClient.del(cacheKey);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        const outcome = await fetch();
        if (outcome.kind === "answered") {
            const envelope: CacheEnvelope = {
                __outcome: "answered",
                value: outcome.value,
                evidence: outcome.evidence,
                savedAt: new Date().toISOString(),
            };
            await this.cacheWrite(cacheKey, ANSWERED_TTL, envelope);
        } else if (outcome.kind === "absent") {
            const envelope: CacheEnvelope = {
                __outcome: "absent",
                evidence: outcome.evidence,
                savedAt: new Date().toISOString(),
            };
            await this.cacheWrite(cacheKey, ABSENT_TTL, envelope);
        }
        return outcome;
    }

    /**
     * A failed cache write never un-answers the source: the envelope is
     * for the next caller, and the caller in front of us already has the
     * real answer.
     */
    private async cacheWrite(
        cacheKey: string,
        ttlSeconds: number,
        envelope: CacheEnvelope
    ): Promise<void> {
        try {
            await redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(envelope));
        } catch (err) {
            logger.warn(`Redis cache write failed for ${cacheKey}:`, err);
        }
    }

    async searchArtist(
        query: string,
        limit = 10
    ): Promise<Outcome<any[]>> {
        const cacheKey = `mb:search:artist:${query}:${limit}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet("/artist", {
                    params: { query, limit, fmt: "json" },
                });
                const artists: any[] = response.data.artists || [];
                if (artists.length === 0) {
                    return absent({ query, limit, hits: 0 });
                }
                return answered(artists, { query, limit, hits: artists.length });
            } catch (err: any) {
                return this.classifyError(err, false);
            }
        });
    }

    async getArtist(
        mbid: string,
        includes: string[] = ["url-rels", "tags"]
    ): Promise<Outcome<any>> {
        const cacheKey = `mb:artist:${mbid}:${includes.join(",")}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(`/artist/${mbid}`, {
                    params: { inc: includes.join("+"), fmt: "json" },
                });
                return answered(response.data, {
                    mbid,
                    includes,
                    source: "musicbrainz",
                });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getReleaseGroups(
        artistMbid: string,
        types: string[] = ["album", "ep"],
        limit = 100
    ): Promise<Outcome<any[]>> {
        const cacheKey = `mb:rg:${artistMbid}:${types.join(",")}:${limit}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet("/release-group", {
                    params: {
                        artist: artistMbid,
                        type: types.join("|"),
                        limit,
                        fmt: "json",
                    },
                });
                const groups: any[] = response.data["release-groups"] || [];
                if (groups.length === 0) {
                    return absent({ artistMbid, types, limit, hits: 0 });
                }
                return answered(groups, {
                    artistMbid,
                    types,
                    limit,
                    hits: groups.length,
                });
            } catch (err: any) {
                return this.classifyError(err, false);
            }
        });
    }

    /**
     * Browse release-groups by style tag (replaces tag.getTopAlbums).
     * Results come back in MB relevance order.
     */
    async searchReleaseGroupsByTag(
        tag: string,
        limit = 20
    ): Promise<Outcome<Array<{ id: string; title: string; artistName: string }>>> {
        const cacheKey = `mb:tag:albums:${tag}:${limit}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet("/release-group", {
                    params: {
                        query: `tag:"${this.escapeLucene(tag)}" AND primary-type:album`,
                        limit,
                        fmt: "json",
                    },
                });
                const groups = (response.data["release-groups"] || [])
                    .filter((rg: any) => rg?.id && rg?.title)
                    .map((rg: any) => ({
                        id: rg.id,
                        title: rg.title,
                        artistName:
                            rg["artist-credit"]?.[0]?.name ||
                            rg["artist-credit"]?.[0]?.artist?.name ||
                            "",
                    }));
                if (groups.length === 0) {
                    return absent({ tag, limit, hits: 0 });
                }
                return answered(groups, { tag, limit, hits: groups.length });
            } catch (err: any) {
                return this.classifyError(err, false);
            }
        });
    }

    async getReleaseGroup(rgMbid: string): Promise<Outcome<any>> {
        const cacheKey = `mb:rg:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "artist-credits+releases", fmt: "json" } }
                );
                return answered(response.data, { rgMbid, source: "musicbrainz" });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getReleaseGroupDetails(rgMbid: string): Promise<Outcome<any>> {
        const cacheKey = `mb:rg:details:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    {
                        params: {
                            inc: "artist-credits+releases+labels",
                            fmt: "json",
                        },
                    }
                );
                return answered(response.data, { rgMbid, source: "musicbrainz" });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getAlbumDetails(rgMbid: string): Promise<Outcome<{
        id: string;
        title: string;
        artistName: string;
        releaseDate?: string;
        trackCount?: number;
        primaryType?: string;
        secondaryTypes?: string[];
    }>> {
        const cacheKey = `mb:album:details:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const rgResponse = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "releases", fmt: "json" } }
                );
                const rg = rgResponse.data;

                let trackCount = 0;
                if (rg.releases && rg.releases.length > 0) {
                    const releaseId = rg.releases[0].id;
                    const releaseResponse = await this.rateLimitedGet(
                        `/release/${releaseId}`,
                        { params: { inc: "recordings", fmt: "json" } }
                    );
                    trackCount = releaseResponse.data.media?.[0]?.["track-count"] || 0;
                }

                return answered(
                    {
                        id: rg.id,
                        title: rg.title,
                        artistName: rg["artist-credit"]?.[0]?.name || "",
                        releaseDate: rg["first-release-date"],
                        trackCount,
                        primaryType: rg["primary-type"],
                        secondaryTypes: rg["secondary-types"] || [],
                    },
                    { rgMbid, source: "musicbrainz" }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getRelease(releaseMbid: string): Promise<Outcome<any>> {
        const cacheKey = `mb:release:${releaseMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(`/release/${releaseMbid}`, {
                    params: {
                        inc: "recordings+artist-credits+labels",
                        fmt: "json",
                    },
                });
                return answered(response.data, {
                    releaseMbid,
                    source: "musicbrainz",
                });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /**
     * One album's whole catalogue in two requests: the release group with its
     * releases, then the earliest release's tracklist (recordings, ISRCs, tags) and
     * label. Cached 30 days. Matching files to `recordings` is the caller's job.
     */
    async getAlbumCatalogue(
        rgMbid: string
    ): Promise<
        Outcome<{
            releaseMbid: string;
            originalYear: number | null;
            label: string | null;
            genres: { name: string; count: number }[];
            recordings: Array<{
                recordingId: string;
                title: string;
                durationMs: number | null;
                isrcs: string[];
                genres: { name: string; count: number }[];
            }>;
        }>
    > {
        const cacheKey = `mb:album:catalogue:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const rgResponse = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "releases+tags", fmt: "json" } }
                );
                const rg = rgResponse.data;
                const releases: any[] = rg.releases || [];
                if (releases.length === 0) {
                    return absent({
                        rgMbid,
                        reason: "release group has no releases",
                    });
                }

                // Releases arrive chronologically; the earliest carries the
                // original year and the tracks as they were first published.
                const chosen = releases[0];
                const releaseResponse = await this.rateLimitedGet(
                    `/release/${chosen.id}`,
                    {
                        params: {
                            inc: "recordings+isrcs+labels+tags",
                            fmt: "json",
                        },
                    }
                );
                const release = releaseResponse.data;

                const recordings = (release.media || [])
                    .flatMap((medium: any) => medium.tracks || [])
                    .filter((t: any) => t.recording)
                    .map((t: any) => ({
                        recordingId: t.recording.id as string,
                        title: (t.title || t.recording.title) as string,
                        durationMs:
                            typeof t.recording.length === "number"
                                ? t.recording.length
                                : null,
                        isrcs: (t.recording.isrcs || []) as string[],
                        genres: (t.recording.tags || [])
                            .filter((g: any) => g.count > 0)
                            .map((g: any) => ({
                                name: g.name,
                                count: g.count,
                            })),
                    }));
                if (recordings.length === 0) {
                    return absent({
                        rgMbid,
                        releaseMbid: chosen.id,
                        reason: "release has no tracklist",
                    });
                }

                const year = Number.parseInt(
                    rg["first-release-date"] || chosen.date || "",
                    10
                );

                return answered(
                    {
                        releaseMbid: chosen.id,
                        originalYear: Number.isFinite(year) ? year : null,
                        label:
                            release["label-info"]?.[0]?.label?.name ?? null,
                        genres: (rg.tags || [])
                            .filter((g: any) => g.count > 0)
                            .map((g: any) => ({
                                name: g.name,
                                count: g.count,
                            })),
                        recordings,
                    },
                    { rgMbid, releaseMbid: chosen.id, source: "musicbrainz" }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    extractPrimaryArtist(artistCredits: any[]): string {
        if (!artistCredits || artistCredits.length === 0)
            return "Unknown Artist";
        return (
            artistCredits[0].name ||
            artistCredits[0].artist?.name ||
            "Unknown Artist"
        );
    }

    /**
     * MusicBrainz Lucene requires escaping: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
     */
    private escapeLucene(str: string): string {
        return str.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
    }

    /**
     * The title without edition markers, for matching against release-group
     * titles only; stored titles keep their markers.
     */
    normalizeForSearch(str: string): string {
        return (
            str
                .replace(/\s*\([^)]*\)\s*/g, " ")
                .replace(/\s*\[[^\]]*\]\s*/g, " ")
                .replace(
                    /\s*-\s*(\d{4}\s+)?(deluxe|remastered|remaster|edition|version|expanded|bonus|explicit|clean|single|radio edit|remix|acoustic|live|mono|stereo)(\s+\d{4})?\s*(edition|version|mix)?\s*/gi,
                    " "
                )
                .replace(/\s*-\s*\d{4}\s*$/gi, " ")
                .replace(/\s+/g, " ")
                .trim()
        );
    }

    /**
     * Strip punctuation for fuzzy matching. Letters, combining marks and
     * numbers of every script survive; `\w` alone is ASCII-only and would
     * turn any Japanese or Cyrillic title into "".
     */
    stripPunctuation(str: string): string {
        return str
            .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Search for a release group by title and artist, trying three strategies in
     * order. If none found anything and any of them errored, the answer is
     * `transient`, not `absent`.
     */
    async searchAlbum(
        albumTitle: string,
        artistName: string
    ): Promise<Outcome<{ id: string; title: string }>> {
        const cacheKey = `mb:search:album:${artistName}:${albumTitle}`;

        return this.cachedOutcome(cacheKey, async () => {
            let firstError: StrategyError | undefined;

            const recordError = async (err: any): Promise<Outcome<never> | undefined> => {
                const classified = await this.classifyError(err, false);
                if (classified.kind === "rateLimited") return classified;
                if (!firstError) {
                    firstError = {
                        code:
                            classified.kind === "transient"
                                ? classified.error.code
                                : "ERROR",
                        message:
                            classified.kind === "transient"
                                ? classified.error.message
                                : "unclassified",
                    };
                }
                return undefined;
            };

            // Strategy 1: exact match with escaped special characters
            {
                const query = `releasegroup:"${this.escapeLucene(
                    albumTitle
                )}" AND artist:"${this.escapeLucene(artistName)}"`;
                try {
                    const response = await this.rateLimitedGet("/release-group", {
                        params: { query, limit: 5, fmt: "json" },
                    });
                    const groups = response.data["release-groups"] || [];
                    if (groups.length > 0) {
                        return answered(
                            { id: groups[0].id, title: groups[0].title },
                            { query, strategy: "exact" }
                        );
                    }
                } catch (err: any) {
                    const bail = await recordError(err);
                    if (bail) return bail;
                }
            }

            // Strategy 2: normalized/cleaned title search
            const normalizedTitle = this.normalizeForSearch(albumTitle);
            const normalizedArtist = this.normalizeForSearch(artistName);
            if (
                normalizedTitle !== albumTitle ||
                normalizedArtist !== artistName
            ) {
                const query = `releasegroup:"${this.escapeLucene(
                    normalizedTitle
                )}" AND artist:"${this.escapeLucene(normalizedArtist)}"`;
                try {
                    const response = await this.rateLimitedGet("/release-group", {
                        params: { query, limit: 5, fmt: "json" },
                    });
                    const groups = response.data["release-groups"] || [];
                    if (groups.length > 0) {
                        return answered(
                            { id: groups[0].id, title: groups[0].title },
                            { query, strategy: "normalized" }
                        );
                    }
                } catch (err: any) {
                    const bail = await recordError(err);
                    if (bail) return bail;
                }
            }

            // Strategy 3: fuzzy search on first words, verified against
            // the artist name (last resort)
            {
                const simpleTitle = normalizedTitle
                    .split(" ")
                    .slice(0, 3)
                    .join(" ");
                const simpleArtist = normalizedArtist.split(" ")[0];
                const query = `${this.escapeLucene(
                    simpleTitle
                )} AND artist:${this.escapeLucene(simpleArtist)}`;
                try {
                    const response = await this.rateLimitedGet("/release-group", {
                        params: { query, limit: 10, fmt: "json" },
                    });
                    for (const rg of response.data["release-groups"] || []) {
                        const rgArtist =
                            rg["artist-credit"]?.[0]?.name ||
                            rg["artist-credit"]?.[0]?.artist?.name ||
                            "";
                        if (
                            rgArtist
                                .toLowerCase()
                                .includes(simpleArtist.toLowerCase())
                        ) {
                            return answered(
                                { id: rg.id, title: rg.title },
                                { query, strategy: "fuzzy" }
                            );
                        }
                    }
                } catch (err: any) {
                    const bail = await recordError(err);
                    if (bail) return bail;
                }
            }

            if (firstError) {
                return { kind: "transient", error: firstError };
            }
            return absent({
                albumTitle,
                artistName,
                strategiesTried: ["exact", "normalized", "fuzzy"],
                reason: "no strategy returned a matching release group",
            });
        });
    }

    /**
     * Search for a recording by track title + artist and return the album
     * it appears on. Strategies run in order; the first strategy that gets
     * candidates decides. Errors are never folded into "no results".
     */
    async searchRecording(
        trackTitle: string,
        artistName: string
    ): Promise<
        Outcome<{
            albumName: string;
            albumMbid: string;
            artistMbid: string;
            trackMbid: string;
        }>
    > {
        const cacheKey = `mb:search:recording:${artistName}:${trackTitle}`;

        return this.cachedOutcome(cacheKey, async () => {
            let firstError: StrategyError | undefined;

            const recordError = async (err: any): Promise<Outcome<never> | undefined> => {
                const classified = await this.classifyError(err, false);
                if (classified.kind === "rateLimited") return classified;
                if (!firstError) {
                    firstError = {
                        code:
                            classified.kind === "transient"
                                ? classified.error.code
                                : "ERROR",
                        message:
                            classified.kind === "transient"
                                ? classified.error.message
                                : "unclassified",
                    };
                }
                return undefined;
            };

            // Strategy 1: normalized quoted search, studio recordings only
            const normalizedTitle = this.normalizeForSearch(trackTitle);
            const normalizedArtist = this.normalizeForSearch(artistName);
            const query1 = `recording:"${this.escapeLucene(
                normalizedTitle
            )}" AND artist:"${this.escapeLucene(normalizedArtist)}"`;
            let handled = false;
            try {
                const response = await this.rateLimitedGet("/recording", {
                    params: {
                        query: query1,
                        limit: 50, // bootleg recordings often rank first
                        fmt: "json",
                        inc: "releases+release-groups+artists",
                    },
                });
                const allRecordings: any[] = response.data.recordings || [];

                logger.debug(
                    `[MusicBrainz] Query: "${trackTitle}" by "${artistName}"`
                );
                logger.debug(
                    `[MusicBrainz] Found ${allRecordings.length} total recordings`
                );

                // Keep studio recordings; drop live/demo/acoustic/remix and
                // date-disambiguated versions.
                const recordings = allRecordings.filter((rec: any) => {
                    const disambig = (rec.disambiguation || "").toLowerCase();
                    if (disambig.includes("live")) return false;
                    if (disambig.match(/\d{4}[-‐]\d{2}[-‐]\d{2}/)) return false;
                    if (disambig.includes("demo")) return false;
                    if (disambig.includes("acoustic")) return false;
                    if (disambig.includes("remix")) return false;
                    return true;
                });

                logger.debug(
                    `[MusicBrainz] After filtering live/demo: ${recordings.length} studio recordings`
                );

                if (recordings.length > 0) {
                    handled = true;
                    // First pass: studio albums only (threshold > 50);
                    // if nothing passes, retry accepting Singles/EPs.
                    for (const rec of recordings) {
                        const result = this.extractAlbumFromRecording(rec, false);
                        if (result) {
                            return answered(result, {
                                query: query1,
                                strategy: "normalized-studio",
                            });
                        }
                    }
                    for (const rec of recordings) {
                        const result = this.extractAlbumFromRecording(rec, true);
                        if (result) {
                            return answered(result, {
                                query: query1,
                                strategy: "normalized-accept-singles",
                            });
                        }
                    }
                }
            } catch (err: any) {
                const bail = await recordError(err);
                if (bail) return bail;
            }

            // Strategies 2/3: fuzzy, then punctuation-stripped. Results
            // must carry our (first word of the) artist name to count.
            const fallbacks: Array<{
                label: string;
                query: string;
                artistProbe: string;
            }> = [
                {
                    label: "fuzzy",
                    query: `${this.escapeLucene(
                        normalizedTitle
                    )} AND artist:${this.escapeLucene(normalizedArtist)}`,
                    artistProbe: normalizedArtist.split(" ")[0],
                },
            ];
            const strippedTitle = this.stripPunctuation(trackTitle);
            const strippedArtist = this.stripPunctuation(artistName);
            if (strippedTitle !== normalizedTitle) {
                fallbacks.push({
                    label: "punctuation-stripped",
                    query: `${strippedTitle} AND artist:${strippedArtist}`,
                    artistProbe: strippedArtist.split(" ")[0],
                });
            }

            for (const { label, query, artistProbe } of fallbacks) {
                try {
                    const response = await this.rateLimitedGet("/recording", {
                        params: {
                            query,
                            limit: 10,
                            fmt: "json",
                            inc: "releases+release-groups+artists",
                        },
                    });
                    for (const rec of response.data.recordings || []) {
                        const recArtist =
                            rec["artist-credit"]?.[0]?.name ||
                            rec["artist-credit"]?.[0]?.artist?.name ||
                            "";
                        if (
                            recArtist.toLowerCase().includes(artistProbe.toLowerCase())
                        ) {
                            const result = this.extractAlbumFromRecording(rec);
                            if (result) {
                                return answered(result, {
                                    query,
                                    strategy: label,
                                });
                            }
                        }
                    }
                } catch (err: any) {
                    const bail = await recordError(err);
                    if (bail) return bail;
                }
            }

            if (firstError) {
                return { kind: "transient", error: firstError };
            }
            return absent({
                trackTitle,
                artistName,
                strategy1HadCandidates: handled,
                reason: "no recording yielded an acceptable album",
            });
        });
    }

    /**
     * Pick the release group to trust for a recording: score every release
     * (studio albums high; compilations, live, bootlegs, soundtracks
     * penalised) and take the first above the threshold. `allowSingles`
     * lowers the threshold to accept Singles/EPs as a last resort.
     */
    private extractAlbumFromRecording(
        recording: any,
        allowSingles: boolean = false
    ): {
        albumName: string;
        albumMbid: string;
        artistMbid: string;
        trackMbid: string;
    } | null {
        const artistMbid = recording["artist-credit"]?.[0]?.artist?.id || "";
        const trackMbid = recording.id || "";
        const releases = recording.releases || [];
        if (releases.length === 0) return null;

        const scoredReleases = releases.map((release: any) => {
            const rg = release["release-group"];
            if (!rg?.id) return { release, score: -1000 };

            let score = 0;
            const primaryType = rg["primary-type"] || "";
            const secondaryTypes: string[] = rg["secondary-types"] || [];
            const title = (rg.title || "").toLowerCase();

            if (primaryType === "Album") score += 100;
            else if (primaryType === "EP") score += 50;
            else if (primaryType === "Single") score += 25;
            else score -= 50;

            if (secondaryTypes.includes("Compilation")) score -= 200;
            if (secondaryTypes.includes("Live")) score -= 150;
            if (secondaryTypes.includes("Remix")) score -= 100;
            if (secondaryTypes.includes("DJ-mix")) score -= 200;
            if (secondaryTypes.includes("Mixtape/Street")) score -= 100;
            if (secondaryTypes.includes("Soundtrack")) score -= 150;

            if (title.match(/\d{4}[-‐]\d{2}[-‐]\d{2}/)) score -= 300;
            if (title.includes("live at") || title.includes("live from"))
                score -= 150;
            if (title.includes("best of") || title.includes("greatest hits"))
                score -= 200;
            if (title.includes("compilation") || title.includes("collection"))
                score -= 200;
            if (title.includes("soundtrack")) score -= 100;
            if (title.includes("various artists")) score -= 300;
            if (title.includes("sounds of the")) score -= 200;
            if (title.includes("deep sounds")) score -= 200;

            if (release.status === "Official") score += 20;

            return { release, score };
        });

        scoredReleases.sort((a: any, b: any) => b.score - a.score);

        // Normal mode requires > 50 (a studio album); singles mode accepts
        // anything above 0 (a Single), still rejecting penalised junk.
        const threshold = allowSingles ? 0 : 50;
        const bestResult = scoredReleases.find((r: any) => r.score > threshold);

        if (!bestResult) {
            logger.debug(
                `[MusicBrainz] Skipping recording - no ${
                    allowSingles ? "singles" : "albums"
                } found in ${releases.length} releases (threshold: ${threshold})`
            );
            return null;
        }

        const bestRelease = bestResult.release;
        const releaseGroup = bestRelease["release-group"];
        if (!releaseGroup?.id) return null;

        logger.debug(
            `[MusicBrainz] Selected "${releaseGroup.title}" (score: ${bestResult.score}) from ${releases.length} releases`
        );

        return {
            albumName:
                releaseGroup.title || bestRelease.title || "Unknown Album",
            albumMbid: releaseGroup.id,
            artistMbid,
            trackMbid,
        };
    }

    /**
     * Track list for a release group, from its first official release.
     */
    async getAlbumTracks(
        rgMbid: string
    ): Promise<Outcome<Array<{ title: string; position?: number; duration?: number }>>> {
        const cacheKey = `mb:albumtracks:${rgMbid}`;

        return this.cachedOutcome(cacheKey, async () => {
            try {
                const rgResponse = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "releases", fmt: "json" } }
                );

                const releases: any[] = rgResponse.data?.releases || [];
                if (releases.length === 0) {
                    return absent({ rgMbid, reason: "release group has no releases" });
                }

                const release =
                    releases.find((r: any) => r.status === "Official") ||
                    releases[0];

                const releaseResponse = await this.rateLimitedGet(
                    `/release/${release.id}`,
                    { params: { inc: "recordings", fmt: "json" } }
                );

                const media = releaseResponse.data?.media || [];
                const tracks: Array<{
                    title: string;
                    position?: number;
                    duration?: number;
                }> = [];

                for (const medium of media) {
                    for (const track of medium.tracks || []) {
                        tracks.push({
                            title: track.title || track.recording?.title,
                            position: track.position,
                            duration: track.length || track.recording?.length,
                        });
                    }
                }

                if (tracks.length === 0) {
                    return absent({
                        rgMbid,
                        releaseId: release.id,
                        reason: "release carries no track entries",
                    });
                }

                logger.debug(
                    `[MusicBrainz] Found ${tracks.length} tracks for release group ${rgMbid}`
                );
                return answered(tracks, {
                    rgMbid,
                    releaseId: release.id,
                    count: tracks.length,
                });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /**
     * Look up a recording by ISRC. A 404 (unknown code) is `absent`; a
     * 200 with no recordings is `absent`; any other failure is typed.
     */
    async lookupByIsrc(
        isrc: string
    ): Promise<
        Outcome<{
            recordingId: string;
            title: string;
            artistName: string;
            artistMbid: string;
        }>
    > {
        const cacheKey = `mb:isrc:${isrc}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(`/isrc/${isrc}`, {
                    params: { fmt: "json" },
                });
                const recordings: any[] = response.data.recordings || [];
                if (recordings.length === 0) {
                    return absent({ isrc, hits: 0 });
                }

                const rec = recordings[0];
                const artistCredit = rec["artist-credit"]?.[0];
                return answered(
                    {
                        recordingId: rec.id,
                        title: rec.title,
                        artistName:
                            artistCredit?.name || artistCredit?.artist?.name || "",
                        artistMbid: artistCredit?.artist?.id || "",
                    },
                    { isrc, hits: recordings.length, picked: rec.id }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /**
     * Genres (curated) and tags (crowd-sourced) for a recording. A
     * recording with neither is `absent` — the source genuinely has
     * nothing — rather than an empty object cached as an answer.
     */
    async getRecordingGenres(
        recordingId: string
    ): Promise<
        Outcome<{
            genres: Array<{ name: string; count: number }>;
            tags: Array<{ name: string; count: number }>;
        }>
    > {
        const cacheKey = `mb:recording:genres:${recordingId}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/recording/${recordingId}`,
                    { params: { fmt: "json", inc: "genres+tags" } }
                );
                const data = response.data;
                const genres = (data.genres || []).map((g: any) => ({
                    name: g.name,
                    count: g.count,
                }));
                const tags = (data.tags || []).map((t: any) => ({
                    name: t.name,
                    count: t.count,
                }));
                if (genres.length === 0 && tags.length === 0) {
                    return absent({ recordingId, reason: "no genres or tags" });
                }
                return answered(
                    { genres, tags },
                    { recordingId, genres: genres.length, tags: tags.length }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /** The first ISRC for a recording; `absent` when it has none. */
    async getRecordingIsrc(recordingId: string): Promise<Outcome<string>> {
        const cacheKey = `mb:recording:isrc:${recordingId}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/recording/${recordingId}`,
                    { params: { fmt: "json", inc: "isrcs" } }
                );
                const isrc = (response.data.isrcs || [])[0];
                if (!isrc) return absent({ recordingId, reason: "no ISRC" });
                return answered(isrc, { recordingId });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }
}

export const musicBrainzService = new MusicBrainzService();