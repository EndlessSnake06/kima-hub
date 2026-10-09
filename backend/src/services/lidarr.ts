import { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { editionlessKey, titlesAgree } from "./albumIdentity";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import { stripAlbumEdition } from "../utils/artistNormalization";
import { createLidarrClient } from "./lidarrClient";
import { sourcePauseController } from "./sourcePauseController";
import { lidarrHealthMonitor } from "./lidarrHealth";
import { UserFacingError } from "../utils/errors";
import type {
    LidarrAlbum,
    LidarrArtist,
    LidarrTrack,
    LidarrTag,
    LidarrRootFolder,
    LidarrAddArtistRequest,
    LidarrQueueItem,
    LidarrQueueResponse,
    LidarrHistoryRecord,
} from "../types/lidarr";

/** Why an acquisition failed, which decides the fallback. */
export enum AcquisitionErrorType {
    ALBUM_NOT_FOUND = "ALBUM_NOT_FOUND",
    NO_RELEASES_AVAILABLE = "NO_RELEASES_AVAILABLE",
    ALREADY_OWNED = "ALREADY_OWNED",
    LIDARR_UNAVAILABLE = "LIDARR_UNAVAILABLE",
}

/**
 * Structured error class for acquisition failures
 * Includes error type and recoverability flag for fallback logic
 */
export class AcquisitionError extends Error {
    public readonly type: AcquisitionErrorType;
    public readonly isRecoverable: boolean;
    public readonly originalError?: Error;

    constructor(
        message: string,
        type: AcquisitionErrorType,
        isRecoverable: boolean = true,
        originalError?: Error
    ) {
        super(message);
        this.name = "AcquisitionError";
        this.type = type;
        this.isRecoverable = isRecoverable;
        this.originalError = originalError;
        
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AcquisitionError);
        }
    }
}

const DISCOVERY_TAG_LABEL = "lidify-discovery";

// Lidarr ends a search with "{n} reports downloaded"; n counts grabs, not results.
const NOTHING_GRABBED = /\b0 reports downloaded/;
// Lidarr's rejections for a release no better than the files it already has.
const EXISTING_FILES = /^Existing files\b/i;

/** A multi-album release: Lidarr's discography flag, or a title advertising N releases. */
export function looksLikeBundle(r: { discography?: boolean; releaseTitle?: string }): boolean {
    return r.discography === true || /\(\s*\d+\s+releases?\b/i.test(r.releaseTitle ?? "");
}

/**
 * Does the bundle's title claim the wanted album? Title mention, or a year
 * range ("2017-2024") that contains the album's release year — the same basis
 * Lidarr uses to link a discography release to albums (ParsingService
 * discography branch), so Kima and Lidarr agree on coverage.
 */
export function bundleCoversAlbum(releaseTitle: string | undefined, albumTitle: string, albumYear?: number): boolean {
    const rt = (releaseTitle ?? "").toLowerCase();
    if (rt.includes(albumTitle.toLowerCase())) return true;
    if (albumYear && albumYear > 0) {
        const m = rt.match(/(\d{4})\s*(?:-|–|—|to)\s*(\d{4})/);
        if (m && albumYear >= Number(m[1]) && albumYear <= Number(m[2])) return true;
    }
    return false;
}

function formatBytes(n?: number): string {
    if (!n && n !== 0) return "unknown size";
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
const RELEASE_SEARCH_TIMEOUT_MS = 90_000;

/** Connection failures, 5xx and Lidarr's SQLite lock clear on their own. */
function isTransient(error: any): boolean {
    if (error?.response) return error.response.status >= 500;
    return error?.isAxiosError === true || /database is locked/i.test(error?.message ?? "");
}

class LidarrService {
    private client: AxiosInstance | null = null;
    private enabled: boolean;
    private initialized: boolean = false;
    private qualityProfileId: number | null = null;
    private metadataProfileId: number | null = null;

    private readonly API_TIMEOUT_DEFAULT = 30000;

    private readonly COMMAND_POLL_TIMEOUT_DEFAULT = 30000;
    private readonly COMMAND_POLL_INTERVAL = 2000;

    private readonly METADATA_FETCH_MAX_ATTEMPTS = 10;
    private readonly METADATA_FETCH_DELAY = 2000;

    private artistCache: { data: LidarrArtist[]; fetchedAt: number } | null = null;
    private readonly ARTIST_CACHE_TTL = 30_000; // 30 seconds

    private artistAddInFlight = new Map<string, Promise<LidarrArtist | null>>();

    private readonly ARTIST_ADD_SETTLE_MS = 2000;

    constructor() {
        this.enabled = config.lidarr?.enabled || false;

        if (this.enabled && config.lidarr) {
            this.client = this.createClient(config.lidarr.url, config.lidarr.apiKey);
        }
    }

    /** An outage seen by any request triggers a health check at once. */
    private createClient(baseURL: string, apiKey: string): AxiosInstance {
        const client = createLidarrClient(baseURL, apiKey, this.API_TIMEOUT_DEFAULT);
        client.interceptors.response.use(undefined, (error) => {
            if (isTransient(error)) lidarrHealthMonitor.reportFailure();
            return Promise.reject(error);
        });
        return client;
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            const settings = await getSystemSettings();
            this.qualityProfileId = settings?.lidarrQualityProfileId ?? null;
            this.metadataProfileId = settings?.lidarrMetadataProfileId ?? null;

            if (settings && settings.lidarrEnabled) {
                const url = settings.lidarrUrl || config.lidarr?.url;
                const apiKey = settings.lidarrApiKey || config.lidarr?.apiKey;

                if (url && apiKey) {
                    logger.debug("Lidarr configured from database");
                    this.client = this.createClient(url, apiKey);
                    this.enabled = true;
                } else {
                    logger.warn("  Lidarr enabled but missing URL or API key");
                    this.enabled = false;
                }
            } else if (config.lidarr) {
                logger.debug("Lidarr configured from .env");
                this.enabled = true;
            } else {
                logger.debug("  Lidarr not enabled");
                this.enabled = false;
            }
        } catch (error) {
            logger.error("Failed to load Lidarr settings:", error);
        }

        this.initialized = true;
    }

    async isEnabled(): Promise<boolean> {
        await this.ensureInitialized();
        return this.enabled;
    }

    reinitialize(): void {
        this.initialized = false;
        this.client = null;
        this.enabled = false;
    }

    /**
     * Get the full artist list with caching (30s TTL).
     * Turns N artist-list fetches per import into 1-3.
     */
    private async getArtistList(): Promise<LidarrArtist[]> {
        if (this.artistCache && (Date.now() - this.artistCache.fetchedAt) < this.ARTIST_CACHE_TTL) {
            return this.artistCache.data;
        }
        if (!this.client) throw new Error("Lidarr client not initialized");
        const response = await this.client.get("/api/v1/artist");
        this.artistCache = { data: response.data, fetchedAt: Date.now() };
        return this.artistCache.data;
    }

    private invalidateArtistCache(): void {
        this.artistCache = null;
    }

    /**
     * Where and how Lidarr files a new artist: the asked music folder (or Lidarr's
     * first), with the profiles chosen in Kima or else that folder's defaults.
     */
    private async newArtistTarget(requestedPath: string): Promise<{
        rootFolderPath: string;
        qualityProfileId: number;
        metadataProfileId: number;
    }> {
        const folders: LidarrRootFolder[] = (await this.client!.get("/api/v1/rootfolder")).data ?? [];
        const folder = folders.find((f) => f.path === requestedPath) ?? folders[0];
        if (!folder) {
            throw new UserFacingError("Add a music folder in Lidarr before downloading", 409);
        }
        const qualityProfileId = this.qualityProfileId ?? (folder.defaultQualityProfileId || null);
        const metadataProfileId = this.metadataProfileId ?? (folder.defaultMetadataProfileId || null);
        if (qualityProfileId === null || metadataProfileId === null) {
            throw new UserFacingError(
                `Lidarr's music folder ${folder.path} has no default profiles. Set them in Lidarr, or choose them in Kima's Lidarr settings`,
                409
            );
        }
        return { rootFolderPath: folder.path, qualityProfileId, metadataProfileId };
    }

    /**
     * Adds the artist with this MusicBrainz id, monitoring nothing on its own:
     * each album Kima asks for is monitored when it is added. Returns null when
     * Lidarr does not know the id; Lidarr errors are thrown.
     */
    async addArtist(
        mbid: string,
        artistName: string,
        rootFolderPath: string,
        isDiscovery: boolean = false
    ): Promise<LidarrArtist | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }
        const existing = (await this.getArtistList()).find((a) => a.foreignArtistId === mbid);
        if (existing) return existing;
        const target = await this.newArtistTarget(rootFolderPath);

        const lookup = await this.client.get<LidarrArtist[]>("/api/v1/artist/lookup", {
            params: { term: `lidarr:${mbid}` },
        });
        const artistData = (lookup.data ?? []).find((a) => a.foreignArtistId === mbid);
        if (!artistData) {
            logger.error(` Lidarr does not know artist ${artistName} (${mbid})`);
            return null;
        }

        const discoveryTagId = isDiscovery ? await this.getOrCreateDiscoveryTag() : null;
        const artistPayload: LidarrAddArtistRequest = {
            foreignArtistId: artistData.foreignArtistId,
            artistName: artistData.artistName,
            ...target,
            monitored: true,
            monitorNewItems: "none",
            addOptions: { monitor: "existing", searchForMissingAlbums: false },
            ...(discoveryTagId ? { tags: [discoveryTagId] } : {}),
        };

        let added: LidarrArtist;
        try {
            added = (await this.client.post("/api/v1/artist", artistPayload)).data;
        } catch (postError: any) {
            const errorMsg = postError.response?.data?.[0]?.errorMessage || postError.message || "";
            if (errorMsg.includes("already exists") || errorMsg.includes("UNIQUE constraint failed")) {
                this.invalidateArtistCache();
                const raced = (await this.getArtistList()).find((a) => a.foreignArtistId === mbid);
                if (raced) return raced;
            }
            throw postError;
        }
        this.invalidateArtistCache();
        logger.debug(`Added artist to Lidarr: ${artistName}${isDiscovery ? " (tagged as discovery)" : ""}`);

        await new Promise((resolve) => setTimeout(resolve, this.ARTIST_ADD_SETTLE_MS));
        try {
            await this.client.post("/api/v1/command", { name: "RefreshArtist", artistId: added.id });
        } catch (refreshError: any) {
            logger.warn(`   Metadata refresh for ${artistName} failed: ${refreshError.message}`);
        }
        return added;
    }

    /**
     * Get all albums for an artist that exist in Lidarr's catalog
     * Used for same-artist fallback to avoid trying MusicBrainz albums that Lidarr can't find
     */
    async getArtistAlbums(artistMbid: string): Promise<LidarrAlbum[]> {
        if (!this.client) {
            logger.warn("Lidarr not enabled");
            return [];
        }

        try {
            const artistsList = await this.getArtistList();
            const artist = artistsList.find(
                (a: LidarrArtist) => a.foreignArtistId === artistMbid
            );

            if (!artist) {
                logger.debug(`   Artist not found in Lidarr: ${artistMbid}`);
                return [];
            }

            const albumsResponse = await this.client.get(
                `/api/v1/album?artistId=${artist.id}`
            );
            return albumsResponse.data || [];
        } catch (error: any) {
            logger.error(`   Failed to get artist albums: ${error.message}`);
            return [];
        }
    }

    /** Poll a Lidarr command until it completes, every 2 s for up to 30 s by default. */
    private async waitForCommand(
        commandId: number,
        timeoutMs: number = this.COMMAND_POLL_TIMEOUT_DEFAULT,
        pollIntervalMs: number = this.COMMAND_POLL_INTERVAL
    ): Promise<{ status: string; message: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const response = await this.client!.get(
                `/api/v1/command/${commandId}`
            );
            const { status, message, body } = response.data;

            if (status !== "started" && status !== "queued") {
                logger.debug(
                    `   Command ${commandId} completed with status: ${status}`
                );
                return {
                    status,
                    message: message || body?.records?.[0]?.message || "",
                };
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Command ${commandId} timed out after ${timeoutMs}ms`);
    }

    async addAlbum(
        rgMbid: string,
        artistName: string,
        albumTitle: string,
        rootFolderPath: string,
        artistMbid?: string,
        isDiscovery: boolean = false
    ): Promise<LidarrAlbum | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        if (await sourcePauseController.isPaused("lidarr")) {
            throw new AcquisitionError(
                "Lidarr is paused",
                AcquisitionErrorType.LIDARR_UNAVAILABLE,
                true
            );
        }

        try {
            logger.debug(
                `   Adding album: ${albumTitle} by ${artistName}${
                    isDiscovery ? " (discovery)" : ""
                }`
            );
            logger.debug(`   Album MBID: ${rgMbid}`);
            logger.debug(`   Artist MBID: ${artistMbid || "none"}`);

            const existingArtistList = await this.getArtistList();
            let artist = existingArtistList.find(
                (a: LidarrArtist) =>
                    artistMbid && a.foreignArtistId === artistMbid
            );

            let justAddedArtist = false;

            if (!artist && artistMbid) {
                logger.debug(`   Adding artist first: ${artistName}`);

                const inFlight = this.artistAddInFlight.get(artistMbid);
                if (inFlight) {
                    logger.debug(`   Artist ${artistMbid} add already in-flight, waiting...`);
                    const result = await inFlight;
                    artist = result ?? undefined;
                } else {
                    const addPromise = this.addArtist(
                        artistMbid,
                        artistName,
                        rootFolderPath,
                        isDiscovery
                    ).finally(() => this.artistAddInFlight.delete(artistMbid));
                    this.artistAddInFlight.set(artistMbid, addPromise);
                    const addedArtist = await addPromise;
                    artist = addedArtist ?? undefined;
                }

                if (!artist) {
                    logger.error(` Failed to add artist`);
                    return null;
                }

                justAddedArtist = true;
                logger.debug(
                    `   Artist added: ${artist.artistName} (ID: ${artist.id})`
                );
                logger.debug(
                    `   Waiting for Lidarr to populate album catalog...`
                );
            } else if (!artist) {
                logger.error(` Artist not found and no MBID provided`);
                return null;
            } else {
                logger.debug(
                    `   Artist already exists: ${artist.artistName} (ID: ${artist.id})`
                );
            }

            // Discover manages only artists it added, which carry its tag; a library
            // request takes the tag off, so Discover's cleanup leaves the artist alone.
            const discoveryTagId = await this.getOrCreateDiscoveryTag();
            const discoveryOwned = !!discoveryTagId && !!artist.tags?.includes(discoveryTagId);
            if (isDiscovery && !discoveryOwned) {
                logger.warn(
                    `   [Lidarr] ${artist.artistName} is in Lidarr outside Discover; not adding "${albumTitle}"`
                );
                return null;
            }
            if (!isDiscovery && discoveryOwned && !(await this.removeTagsFromArtist(artist.id, [discoveryTagId!]))) {
                logger.warn(`   [Lidarr] ${artist.artistName} keeps the Discover tag; its weekly cleanup may remove it`);
            }

            let artistAlbums: LidarrAlbum[] = [];

            const artistAlbumsResponse = await this.client.get(
                `/api/v1/album?artistId=${artist.id}`
            );
            artistAlbums = artistAlbumsResponse.data;

            if (artistAlbums.length === 0 && justAddedArtist) {
                logger.debug(`   Waiting for Lidarr to fetch album metadata...`);

                const maxAttempts = this.METADATA_FETCH_MAX_ATTEMPTS;
                const retryDelay = this.METADATA_FETCH_DELAY; // 3 seconds between retries

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );

                    const retryResponse = await this.client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;

                    if (artistAlbums.length > 0) {
                        logger.debug(`   Albums loaded after ${attempt * (this.METADATA_FETCH_DELAY / 1000)}s`);
                        break;
                    }

                    if (attempt < maxAttempts) {
                        logger.debug(
                            `   Attempt ${attempt}/${maxAttempts}: Still waiting...`
                        );
                    } else {
                        logger.warn(
                            ` Timeout reached after ${
                                (maxAttempts * this.METADATA_FETCH_DELAY) / 1000
                            }s - artist catalog may still be populating`
                        );
                    }
                }
            } else if (artistAlbums.length === 0 && !justAddedArtist) {
                logger.debug(
                    `   Artist exists but has 0 albums - refreshing metadata...`
                );
                try {
                    await this.client.post("/api/v1/command", {
                        name: "RefreshArtist",
                        artistId: artist.id,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    const retryResponse = await this.client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;
                } catch (refreshError) {
                    logger.warn(`   Metadata refresh failed`);
                }
            }

            logger.debug(
                `   Found ${artistAlbums.length} albums for ${artist.artistName}`
            );

            let albumData = artistAlbums.find(
                (a: LidarrAlbum) => a.foreignAlbumId === rgMbid
            );

            // Library requests fall back to a title match; for Discover another edition is a miss.
            if (!albumData && !isDiscovery) {
                logger.debug(
                    `   Album MBID not found, matching by title: ${albumTitle}`
                );

                albumData = artistAlbums.find((a: LidarrAlbum) =>
                    titlesAgree(a.title, albumTitle)
                );

                if (albumData) {
                    logger.debug(
                        `   Final match: "${albumData.title}" (MBID: ${albumData.foreignAlbumId})`
                    );
                } else {
                    logger.debug(` No album with a matching title`);
                }
            }

            if (!albumData) {
                logger.error(
                    `   ✗ Album "${albumTitle}" not found in artist's ${artistAlbums.length} albums`
                );
                if (artistAlbums.length > 0) {
                    logger.debug(
                        `   Looking for: "${albumTitle}" (MBID: ${rgMbid})`
                    );
                    logger.debug(
                        `   Available albums in Lidarr (showing up to 10):`
                    );
                    artistAlbums.slice(0, 10).forEach((a: LidarrAlbum) => {
                        logger.debug(
                            `     - "${a.title}" (${a.foreignAlbumId})`
                        );
                    });
                }
                throw new AcquisitionError(
                    `Album "${albumTitle}" not found in Lidarr catalog for ${artistName}`,
                    AcquisitionErrorType.ALBUM_NOT_FOUND,
                    true // isRecoverable - Soulseek can try
                );
            }

            logger.debug(
                `   Found album in catalog: ${albumData.title} (ID: ${albumData.id})`
            );

            if (isDiscovery && (albumData.statistics?.trackFileCount ?? 0) > 0) {
                logger.warn(
                    `   [Lidarr] "${albumData.title}" already has files in Lidarr; Discover only fetches new albums`
                );
                return null;
            }

            if (albumData.statistics?.percentOfTracks >= 100) {
                throw new AcquisitionError(
                    `Already in Lidarr: all ${albumData.statistics.trackFileCount} tracks`,
                    AcquisitionErrorType.ALREADY_OWNED,
                    false
                );
            }

            if (!artist.monitored) {
                logger.debug(`   Enabling artist monitoring...`);
                await this.client.put(`/api/v1/artist/${artist.id}`, {
                    ...artist,
                    monitored: true,
                });
                logger.debug(`   Artist monitoring enabled`);
            } else {
                logger.debug(`   Artist already monitored`);
            }

            // Kima asks for the album, not one edition: anyReleaseOk lets Lidarr grab any
            // edition and, on import, monitor whichever one the files match.
            const fullAlbum = (await this.client.get(`/api/v1/album/${albumData.id}`)).data;
            await this.client.put(`/api/v1/album/${fullAlbum.id}`, {
                ...fullAlbum,
                monitored: true,
                anyReleaseOk: true,
            });
            const updatedAlbum = (await this.client.get(`/api/v1/album/${fullAlbum.id}`)).data;
            if (!updatedAlbum.monitored || !updatedAlbum.anyReleaseOk) {
                logger.error(`   Lidarr did not keep monitoring for "${updatedAlbum.title}" (ID: ${updatedAlbum.id})`);
            }

            if ((updatedAlbum.releases?.length || 0) === 0) {
                logger.warn(` Album has 0 releases - refreshing artist metadata from MusicBrainz...`);
                await this.client.post("/api/v1/command", {
                    name: "RefreshArtist",
                    artistId: artist.id,
                });
                await new Promise((resolve) => setTimeout(resolve, 5000));
                const refreshed = (await this.client.get(`/api/v1/album/${updatedAlbum.id}`)).data;
                if ((refreshed.releases?.length || 0) === 0) {
                    logger.warn(`   Still no releases after refresh; the search may find nothing`);
                }
            }

            try {
                const result = await this.runAlbumSearch(updatedAlbum.id);
                if (!NOTHING_GRABBED.test(result.message ?? "")) {
                    logger.debug(`   Album download started: ${updatedAlbum.title}`);
                    return updatedAlbum;
                }

                // Discover stays album-scoped: a bundle would import the
                // artist's whole discography off a single discovery request.
                if (!isDiscovery && (await this.tryBundleGrab(artist.id, updatedAlbum))) {
                    logger.debug(`   Bundle grab started for "${updatedAlbum.title}"`);
                    return updatedAlbum;
                }

                const baseAlbumTitle = stripAlbumEdition(albumTitle);
                const baseMatch =
                    !isDiscovery && baseAlbumTitle !== albumTitle && baseAlbumTitle.length > 2
                        ? artistAlbums.find(
                              (a: LidarrAlbum) => a.id !== updatedAlbum.id && titlesAgree(a.title, baseAlbumTitle)
                          )
                        : undefined;
                if (!baseMatch) throw await this.nothingGrabbedError(updatedAlbum.id, albumTitle);

                logger.debug(`   Nothing for "${albumTitle}"; trying the base album "${baseMatch.title}"`);
                await this.client.put(`/api/v1/album/${baseMatch.id}`, {
                    ...baseMatch,
                    monitored: true,
                    anyReleaseOk: true,
                });
                const baseResult = await this.runAlbumSearch(baseMatch.id);
                if (NOTHING_GRABBED.test(baseResult.message ?? "")) {
                    if (!isDiscovery && (await this.tryBundleGrab(artist.id, baseMatch))) {
                        logger.debug(`   Bundle grab started for "${baseMatch.title}"`);
                        return baseMatch;
                    }
                    throw await this.nothingGrabbedError(baseMatch.id, baseMatch.title);
                }
                logger.debug(`   Base album download started: ${baseMatch.title}`);
                return baseMatch;
            } catch (error: any) {
                if (error instanceof AcquisitionError) throw error;
                if (error.message?.includes("timed out")) {
                    logger.warn(`   Search command timed out, album may still be searching`);
                    return updatedAlbum;
                }
                throw error;
            }
        } catch (error: any) {
            if (error instanceof AcquisitionError) throw error;
            logger.error("Lidarr add album error:", error.response?.data || error.message);
            if (isTransient(error)) {
                throw new AcquisitionError(
                    `Lidarr unavailable: ${error.message}`,
                    AcquisitionErrorType.LIDARR_UNAVAILABLE,
                    true,
                    error
                );
            }
            throw error;
        }
    }

    /** Start Lidarr's search for one album and wait for it to finish. */
    private async runAlbumSearch(albumId: number) {
        const command = await this.client!.post("/api/v1/command", {
            name: "AlbumSearch",
            albumIds: [albumId],
        });
        return this.waitForCommand(command.data.id);
    }

    /**
     * Grab a multi-album bundle Lidarr refused only because other albums in it are already owned, as Lidarr's
     * "download anyway" does (POST /api/v1/release, valid 30 minutes after the search that listed it). Any other
     * rejection (quality, seeders, blocklist) leaves the release alone. True when the grab started.
     */
    async tryBundleGrab(artistId: number, album: { title: string; releaseDate?: string; id: number }): Promise<boolean> {
        let releases: any[] = [];
        try {
            releases = (
                await this.client!.get("/api/v1/release", {
                    params: { artistId },
                    timeout: RELEASE_SEARCH_TIMEOUT_MS,
                })
            ).data ?? [];
        } catch (error: any) {
            logger.warn(`   Bundle scan for artist ${artistId} failed: ${error.message}`);
            return false;
        }

        const year = album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : undefined;
        const ceilingMB = (await getSystemSettings())?.lidarrBundleMaxSizeMB ?? 0;
        const candidates = releases.filter(
            (r) =>
                looksLikeBundle(r) &&
                (r.rejections ?? []).length > 0 &&
                (r.rejections ?? []).every((m: string) => EXISTING_FILES.test(m)) &&
                bundleCoversAlbum(r.releaseTitle, album.title, year)
        );
        if (candidates.length === 0) return false;

        const ceiling = ceilingMB > 0 ? ceilingMB * 1024 * 1024 : Infinity;
        const fitting = candidates.filter((r) => (r.size ?? 0) <= ceiling);
        fitting.sort(
            (a, b) =>
                (a.size ?? Infinity) - (b.size ?? Infinity) ||
                (b.statistics?.seeders ?? 0) - (a.statistics?.seeders ?? 0)
        );
        if (fitting.length === 0) {
            logger.debug(`   ${candidates.length} bundle(s) cover "${album.title}" but exceed the size ceiling`);
            return false;
        }
        const pick = fitting[0];

        try {
            await this.client!.post("/api/v1/release", {
                guid: pick.guid,
                indexerId: pick.indexerId,
            });
        } catch (error: any) {
            logger.warn(`   Bundle grab rejected (${error.response?.status}): ${pick.releaseTitle}`);
            return false;
        }
        logger.debug(`   Bundle grabbed: "${pick.releaseTitle}" (${formatBytes(pick.size)})`);
        return true;
    }

    private async nothingGrabbedError(albumId: number, albumTitle: string): Promise<AcquisitionError> {
        let releases: { rejections?: string[] }[] = [];
        try {
            releases = (
                await this.client!.get("/api/v1/release", {
                    params: { albumId },
                    timeout: RELEASE_SEARCH_TIMEOUT_MS,
                })
            ).data ?? [];
        } catch (error: any) {
            logger.warn(`   Release list for album ${albumId} unavailable: ${error.message}`);
        }

        const reasons = releases.flatMap((r) => r.rejections ?? []);
        const owned =
            releases.length > 0 &&
            releases.every((r) => (r.rejections ?? []).length > 0 && r.rejections!.every((m) => EXISTING_FILES.test(m)));
        if (owned) {
            // "Existing files" on the ALBUM's own release list is not proof the
            // album is complete (percentOfTracks is, checked in addAlbum): with
            // bundle releases the rejection often belongs to OTHER albums the
            // release is linked to. Report it as availability, recoverable.
            return new AcquisitionError(
                `All releases for "${albumTitle}" rejected as existing files`,
                AcquisitionErrorType.NO_RELEASES_AVAILABLE,
                true
            );
        }

        const counts = new Map<string, number>();
        for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
        const top = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, n]) => `${reason} (${n})`);
        const detail = releases.length === 0
            ? "indexers found no releases"
            : `${releases.length} found, none approved: ${top.join("; ")}`;
        return new AcquisitionError(
            `No releases available for "${albumTitle}" - ${detail}`,
            AcquisitionErrorType.NO_RELEASES_AVAILABLE,
            true
        );
    }

    async rescanLibrary(): Promise<void> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            await this.client.post("/api/v1/command", {
                name: "RescanFolders",
            });

            logger.debug("Triggered Lidarr library rescan");
        } catch (error) {
            logger.error("Lidarr rescan error:", error);
            throw error;
        }
    }

    async getArtists(): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            return await this.getArtistList();
        } catch (error) {
            logger.error("Lidarr get artists error:", error);
            return [];
        }
    }

    /**
     * Delete an artist from Lidarr by MusicBrainz ID
     * This removes the artist and optionally deletes files
     */
    async deleteArtist(
        mbid: string,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        if (!mbid || mbid.startsWith("temp-")) {
            return { success: false, message: "Invalid or temporary MBID" };
        }

        try {
            const artists = await this.getArtists();
            const lidarrArtist = artists.find(
                (a) => a.foreignArtistId === mbid
            );

            if (!lidarrArtist) {
                logger.debug(
                    `[LIDARR] Artist with MBID ${mbid} not found in Lidarr`
                );
                return {
                    success: true,
                    message:
                        "Artist not in Lidarr (already removed or never added)",
                };
            }

            logger.debug(
                `[LIDARR] Deleting artist: ${lidarrArtist.artistName} (ID: ${lidarrArtist.id})`
            );

            await this.client.delete(`/api/v1/artist/${lidarrArtist.id}`, {
                params: {
                    deleteFiles: deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT, // 30 second timeout
            });

            logger.debug(
                `[LIDARR] Successfully deleted artist: ${lidarrArtist.artistName}`
            );
            return {
                success: true,
                message: `Deleted ${lidarrArtist.artistName} from Lidarr`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete artist error:",
                error?.message || error
            );
            return {
                success: false,
                message: error?.message || "Failed to delete from Lidarr",
            };
        }
    }

    /** One album, or null when Lidarr no longer has it. Any other error throws. */
    async getAlbum(albumId: number): Promise<LidarrAlbum | null> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) throw new Error("Lidarr not enabled");
        try {
            return (await this.client.get(`/api/v1/album/${albumId}`)).data;
        } catch (error: any) {
            if (error.response?.status === 404) return null;
            throw error;
        }
    }

    /** One artist, or null when Lidarr no longer has it. Any other error throws. */
    async getArtistById(artistId: number): Promise<LidarrArtist | null> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) throw new Error("Lidarr not enabled");
        try {
            return (await this.client.get(`/api/v1/artist/${artistId}`)).data;
        } catch (error: any) {
            if (error.response?.status === 404) return null;
            throw error;
        }
    }

    /** Every album Lidarr lists for an artist. Errors throw. */
    async getAlbumsByArtistId(artistId: number): Promise<LidarrAlbum[]> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) throw new Error("Lidarr not enabled");
        return (await this.client.get("/api/v1/album", { params: { artistId } })).data ?? [];
    }

    /** Delete an album from Lidarr; a 404 counts as done. Callers go through discovery/lidarrRemoval. */
    async deleteAlbumById(albumId: number, deleteFiles: boolean): Promise<void> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) throw new Error("Lidarr not enabled");
        try {
            await this.client.delete(`/api/v1/album/${albumId}`, {
                params: { deleteFiles, addImportListExclusion: false },
                timeout: this.API_TIMEOUT_DEFAULT,
            });
        } catch (error: any) {
            if (error.response?.status !== 404) throw error;
        }
    }

    /**
     * Check if an album exists in Lidarr and has files (already downloaded)
     * Returns true if the album is already available in Lidarr
     */
    async isAlbumAvailable(albumMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get("/api/v1/album", {
                params: { foreignAlbumId: albumMbid },
            });

            const albums = response.data;
            if (!albums || albums.length === 0) {
                return false;
            }

            for (const album of albums) {
                if (album.foreignAlbumId === albumMbid) {
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            if (error.response?.status === 404) {
                return false;
            }
            logger.error("Lidarr album check error:", error.message);
            return false;
        }
    }

    /**
     * Check if an album exists in Lidarr by artist name and album title
     * Handles MBID mismatches between MusicBrainz and Lidarr
     */
    async isAlbumAvailableByTitle(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        const normalizedArtist = artistName.toLowerCase().trim();

        try {
            const artists = await this.getArtistList();

            const matchingArtist = artists.find(
                (a) =>
                    a.artistName?.toLowerCase().trim() === normalizedArtist
            );

            if (!matchingArtist) {
                return false;
            }

            const albumsResponse = await this.client.get("/api/v1/album", {
                params: { artistId: matchingArtist.id },
            });
            const albums = albumsResponse.data || [];

            for (const album of albums) {
                if (titlesAgree(album.title ?? "", albumTitle)) {
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            logger.error("Lidarr album check by title error:", error.message);
            return false;
        }
    }

    /**
     * Get missing tracks for an album by release-group MBID.
     * Returns tracks that exist in Lidarr metadata but do not have files yet.
     */
    async getMissingTracksByAlbumMbid(
        albumMbid: string
    ): Promise<Array<{ title: string; trackNumber: number | null }>> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client || !albumMbid) {
            return [];
        }

        try {
            const albumResponse = await this.client.get<LidarrAlbum[]>(
                "/api/v1/album",
                {
                    params: { foreignAlbumId: albumMbid },
                }
            );

            const lidarrAlbum = (albumResponse.data || []).find(
                (a: LidarrAlbum) => a.foreignAlbumId === albumMbid
            );

            if (!lidarrAlbum) {
                return [];
            }

            const tracksResponse = await this.client.get<LidarrTrack[]>(
                "/api/v1/track",
                {
                    params: { albumId: lidarrAlbum.id },
                }
            );

            const tracks: LidarrTrack[] = tracksResponse.data || [];
            const parseTrackNumber = (
                track: LidarrTrack
            ): number | null => {
                const rawCandidates = [
                    track.trackNumber,
                    track.absoluteTrackNumber,
                    track.position,
                ];

                for (const rawValue of rawCandidates) {
                    const parsedValue = Number(rawValue);
                    if (Number.isFinite(parsedValue) && parsedValue > 0) {
                        return parsedValue;
                    }
                }

                const title = track.title || "";
                const titleNumberMatch = title.match(/^\s*(\d{1,3})\b/);
                if (titleNumberMatch) {
                    const parsedFromTitle = Number(titleNumberMatch[1]);
                    if (
                        Number.isFinite(parsedFromTitle) &&
                        parsedFromTitle > 0
                    ) {
                        return parsedFromTitle;
                    }
                }

                return null;
            };

            const missingTracks = tracks
                .filter((track: LidarrTrack) =>
                    track.hasFile === undefined
                        ? !track.trackFileId
                        : !track.hasFile
                )
                .map((track: LidarrTrack) => ({
                    title: track.title,
                    trackNumber: parseTrackNumber(track),
                }))
                .filter((track: { title: string; trackNumber: number | null }) =>
                    !!track.title
                )
                .sort(
                    (
                        a: { title: string; trackNumber: number | null },
                        b: { title: string; trackNumber: number | null }
                    ) => {
                    if (a.trackNumber === null && b.trackNumber === null) {
                        return a.title.localeCompare(b.title);
                    }
                    if (a.trackNumber === null) return 1;
                    if (b.trackNumber === null) return -1;
                    return a.trackNumber - b.trackNumber;
                    }
                );

            return missingTracks;
        } catch (error: any) {
            logger.debug(
                `[LIDARR] Failed to fetch missing tracks for album MBID ${albumMbid}: ${error?.message || error}`
            );
            return [];
        }
    }

    /**
     * Check if an artist exists in Lidarr
     */
    async isArtistInLidarr(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const artists = await this.getArtistList();
            return artists.some((a) => a.foreignArtistId === artistMbid);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get all tags from Lidarr
     */
    async getTags(): Promise<LidarrTag[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/tag");
            return response.data || [];
        } catch (error: any) {
            logger.error("[LIDARR] Failed to get tags:", error.message);
            return [];
        }
    }

    /**
     * Create a new tag in Lidarr
     */
    async createTag(label: string): Promise<LidarrTag | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const response = await this.client.post("/api/v1/tag", { label });
            logger.debug(
                `[LIDARR] Created tag: ${label} (ID: ${response.data.id})`
            );
            return response.data;
        } catch (error: any) {
            logger.error("[LIDARR] Failed to create tag:", error.message);
            return null;
        }
    }

    /**
     * The discovery tag's id, created when Lidarr has none. Looked up each time: a
     * remembered id outlives the tag when someone deletes it in Lidarr.
     */
    async getOrCreateDiscoveryTag(): Promise<number | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const tags = await this.getTags();
            const existingTag = tags.find(
                (t) => t.label === DISCOVERY_TAG_LABEL
            );

            if (existingTag) {
                logger.debug(
                    `[LIDARR] Found existing discovery tag (ID: ${existingTag.id})`
                );
                return existingTag.id;
            }

            const newTag = await this.createTag(DISCOVERY_TAG_LABEL);
            if (newTag) {
                return newTag.id;
            }

            return null;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get/create discovery tag:",
                error.message
            );
            return null;
        }
    }

    /**
     * Remove tags from an artist
     */
    async removeTagsFromArtist(
        artistId: number,
        tagIds: number[]
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get(
                `/api/v1/artist/${artistId}`
            );
            const artist = response.data;

            const existingTags = artist.tags || [];
            const filteredTags = existingTags.filter(
                (t: number) => !tagIds.includes(t)
            );

            await this.client.put(`/api/v1/artist/${artistId}`, {
                ...artist,
                tags: filteredTags,
            });

            logger.debug(
                `[LIDARR] Removed tags ${tagIds} from artist ${artist.artistName}`
            );
            return true;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove tags from artist:",
                error.message
            );
            return false;
        }
    }

    /**
     * Get all artists that have a specific tag
     */
    async getArtistsByTag(tagId: number): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const artists = await this.getArtistList();

            return artists.filter((artist) => artist.tags?.includes(tagId));
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get artists by tag:",
                error.message
            );
            return [];
        }
    }

    /**
     * Get all discovery-tagged artists (convenience method)
     */
    async getDiscoveryArtists(): Promise<LidarrArtist[]> {
        const tagId = await this.getOrCreateDiscoveryTag();
        if (!tagId) {
            return [];
        }
        return this.getArtistsByTag(tagId);
    }

    /**
     * Remove discovery tag from an artist by MBID
     * Used when user likes an album (artist becomes "owned")
     */
    async removeDiscoveryTagByMbid(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const tagId = await this.getOrCreateDiscoveryTag();
            if (!tagId) {
                return false;
            }

            const artists = await this.getArtists();
            const artist = artists.find(
                (a) => a.foreignArtistId === artistMbid
            );

            if (!artist) {
                logger.debug(
                    `[LIDARR] Artist ${artistMbid} not found in Lidarr`
                );
                return true; // Not an error - artist might not be in Lidarr
            }

            if (!artist.tags?.includes(tagId)) {
                logger.debug(
                    `[LIDARR] Artist ${artist.artistName} doesn't have discovery tag`
                );
                return true; // Already doesn't have tag
            }

            return await this.removeTagsFromArtist(artist.id, [tagId]);
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove discovery tag:",
                error.message
            );
            return false;
        }
    }

    /**
     * Delete artist by Lidarr ID (used for cleanup)
     */
    async deleteArtistById(
        lidarrId: number,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return { success: false, message: "Lidarr not enabled" };
        }

        try {
            await this.client.delete(`/api/v1/artist/${lidarrId}`, {
                params: {
                    deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT,
            });

            return { success: true, message: "Artist deleted" };
        } catch (error: any) {
            if (error.response?.status === 404) {
                return { success: true, message: "Artist already removed" };
            }
            logger.error("[LIDARR] Delete artist by ID error:", error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Stop Lidarr's background searches (RSS, missing albums) grabbing an album.
     * Its own re-search after a failed download ignores monitoring.
     */
    async unmonitorAlbum(albumId: number): Promise<void> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) return;
        try {
            await this.client.put("/api/v1/album/monitor", { albumIds: [albumId], monitored: false });
        } catch (error: any) {
            logger.warn(`[LIDARR] Could not unmonitor album ${albumId}: ${error.message}`);
        }
    }

    /**
     * Delete a queue item; with blocklist Lidarr never grabs that release again,
     * and unless skipRedownload it searches for another. A 404 counts as success.
     * Callers go through lidarrFailures.removeFailedDownload.
     */
    async removeQueueItem(
        item: { id: number; title?: string },
        opts: { blocklist: boolean; skipRedownload: boolean; removeFromClient?: boolean }
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            const { removeFromClient = true, ...queueOpts } = opts;
            await this.client.delete(`/api/v1/queue/${item.id}`, {
                params: { removeFromClient, ...queueOpts },
            });
            logger.debug(`[LIDARR] Removed from queue: ${item.title ?? item.id}`);
            return true;
        } catch (error: any) {
            if (error.response?.status === 404) {
                return true;
            }
            logger.error(
                `[LIDARR] Failed to remove queue item ${item.id}:`,
                error.response?.data || error.message
            );
            return false;
        }
    }

    /** Every item in Lidarr's download queue; throws when Lidarr cannot be read. */
    async getQueueItems(): Promise<LidarrQueueItem[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        const response = await this.client.get("/api/v1/queue", {
            params: { page: 1, pageSize: 1000, includeUnknownArtistItems: true },
        });
        return (response.data as LidarrQueueResponse).records;
    }

    /**
     * Get upcoming and recent releases from Lidarr calendar
     * Returns albums releasing within the specified date range for monitored artists
     */
    async getCalendar(
        startDate: Date,
        endDate: Date
    ): Promise<CalendarRelease[]> {
        await this.ensureInitialized();

        if (!this.client) {
            logger.debug("[LIDARR] Not configured - cannot fetch calendar");
            return [];
        }

        try {
            const start = startDate.toISOString().split("T")[0];
            const end = endDate.toISOString().split("T")[0];

            const response = await this.client.get(`/api/v1/calendar`, {
                params: {
                    start,
                    end,
                    includeArtist: true,
                },
            });

            const albums = response.data as LidarrAlbum[];
            const releases: CalendarRelease[] = albums.map(
                (album) => ({
                    id: album.id,
                    title: album.title,
                    artistName: album.artist?.artistName || "Unknown Artist",
                    artistId: album.artist?.id,
                    artistMbid: album.artist?.foreignArtistId,
                    albumMbid: album.foreignAlbumId,
                    releaseDate: album.releaseDate,
                    monitored: album.monitored,
                    grabbed: album.grabbed || false,
                    hasFile: album.statistics?.percentOfTracks === 100,
                    coverUrl:
                        album.images?.find(
                            (img: any) => img.coverType === "cover"
                        )?.remoteUrl || null,
                })
            );

            logger.debug(
                `[LIDARR] Calendar: Found ${releases.length} releases between ${start} and ${end}`
            );
            return releases;
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to fetch calendar:`, error.message);
            return [];
        }
    }

    /**
     * Get all monitored artists from Lidarr
     */
    async getMonitoredArtists(): Promise<
        { id: number; name: string; mbid: string }[]
    > {
        await this.ensureInitialized();

        if (!this.client) {
            return [];
        }

        try {
            const response = await this.client.get(`/api/v1/artist`);
            const artists = response.data as LidarrArtist[];
            return artists
                .filter((artist) => artist.monitored)
                .map((artist) => ({
                    id: artist.id,
                    name: artist.artistName,
                    mbid: artist.foreignArtistId,
                }));
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to fetch monitored artists:`,
                error.message
            );
            return [];
        }
    }

    /**
     * Everything reconciliation needs in one snapshot fetch, as Maps for lookups by job data.
     * Null when Lidarr is off, paused, or any fetch fails: a partial snapshot would read as missing downloads.
     */
    async getReconciliationSnapshot(): Promise<ReconciliationSnapshot | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client || (await sourcePauseController.isPaused("lidarr"))) {
            return null;
        }
        const client = this.client;

        try {
            const [queueResponse, albumResponse, artists] = await Promise.all([
                client.get("/api/v1/queue", {
                    params: { page: 1, pageSize: 1000, includeUnknownArtistItems: true },
                }),
                client.get("/api/v1/album"),
                this.getArtistList(),
            ]);
            if (!Array.isArray(albumResponse.data)) {
                throw new Error("album list is not an array");
            }
            if (!Array.isArray(queueResponse.data?.records)) {
                throw new Error("queue response has no records");
            }

            const snapshot: ReconciliationSnapshot = {
                queue: new Map(),
                albumsByMbid: new Map(),
                albumsByTitle: new Map(),
                fetchedAt: new Date(),
            };

            for (const item of queueResponse.data.records) {
                if (item.downloadId) {
                    snapshot.queue.set(item.downloadId, {
                        id: item.id,
                        downloadId: item.downloadId,
                        status: item.status,
                        progress: item.sizeleft && item.size
                            ? Math.round(((item.size - item.sizeleft) / item.size) * 100)
                            : undefined,
                        title: item.title,
                    });
                }
            }

            // Lidarr's album list carries no artist, only its id.
            const artistNames = new Map(artists.map((artist) => [artist.id, artist.artistName]));
            for (const album of albumResponse.data as LidarrAlbum[]) {
                if (!(album.statistics?.percentOfTracks > 0)) continue;

                const albumInfo: AlbumSnapshotInfo = {
                    id: album.id,
                    title: album.title,
                    foreignAlbumId: album.foreignAlbumId,
                    artistName: artistNames.get(album.artistId) || "",
                    hasFiles: true,
                };

                if (album.foreignAlbumId) {
                    snapshot.albumsByMbid.set(album.foreignAlbumId, albumInfo);
                }
                if (albumInfo.artistName && album.title) {
                    const key = `${albumInfo.artistName.toLowerCase().trim()}|${album.title.toLowerCase().trim()}`;
                    snapshot.albumsByTitle.set(key, albumInfo);
                }
            }

            logger.debug(
                `[LIDARR] Snapshot fetched: ${snapshot.queue.size} queue items, ${snapshot.albumsByMbid.size} albums with files`
            );
            return snapshot;
        } catch (error: any) {
            logger.warn(`[LIDARR] Snapshot skipped this cycle: ${error.message}`);
            return null;
        }
    }

    /**
     * Check if an album is available using a pre-fetched snapshot.
     * Returns true if the album exists with files.
     */
    isAlbumAvailableInSnapshot(
        snapshot: ReconciliationSnapshot,
        mbid?: string,
        artistName?: string,
        albumTitle?: string
    ): boolean {
        if (mbid && snapshot.albumsByMbid.has(mbid)) {
            return true;
        }

        if (artistName && albumTitle) {
            const key = `${artistName.toLowerCase().trim()}|${albumTitle.toLowerCase().trim()}`;
            if (snapshot.albumsByTitle.has(key)) {
                return true;
            }

            const normalizedArtist = artistName.toLowerCase().trim();
            const wantKey = editionlessKey(albumTitle);
            if (wantKey) {
                for (const [titleKey] of snapshot.albumsByTitle) {
                    const [keyArtist, keyAlbum] = titleKey.split("|");
                    if (keyArtist === normalizedArtist && editionlessKey(keyAlbum) === wantKey) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Check if a download is active using a pre-fetched snapshot.
     */
    isDownloadActiveInSnapshot(
        snapshot: ReconciliationSnapshot,
        downloadId: string
    ): { active: boolean; progress?: number } {
        const item = snapshot.queue.get(downloadId);
        if (!item) {
            return { active: false };
        }
        const isActive = item.status !== "failed" && item.status !== "warning";
        return { active: isActive, progress: item.progress };
    }
}

/**
 * Snapshot of Lidarr state for efficient batch reconciliation
 */
export interface ReconciliationSnapshot {
    queue: Map<string, QueueSnapshotItem>;
    albumsByMbid: Map<string, AlbumSnapshotInfo>;
    albumsByTitle: Map<string, AlbumSnapshotInfo>;
    fetchedAt: Date;
}

interface QueueSnapshotItem {
    id: number;
    downloadId: string;
    status: string;
    progress?: number;
    title: string;
}

interface AlbumSnapshotInfo {
    id: number;
    title: string;
    foreignAlbumId: string;
    artistName: string;
    hasFiles: boolean;
}

export interface CalendarRelease {
    id: number;
    title: string;
    artistName: string;
    artistId?: number;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    monitored: boolean;
    grabbed: boolean;
    hasFile: boolean;
    coverUrl: string | null;
}

export const lidarrService = new LidarrService();

/** Lidarr's history of one event type since `since`, with album and artist attached. */
export async function getHistorySince(
    lidarrUrl: string,
    apiKey: string,
    since: Date,
    eventType: number
): Promise<LidarrHistoryRecord[]> {
    const { data } = await createLidarrClient(lidarrUrl, apiKey).get<LidarrHistoryRecord[]>("/api/v1/history/since", {
        params: { date: since.toISOString(), eventType, includeAlbum: true, includeArtist: true },
    });
    return data;
}

