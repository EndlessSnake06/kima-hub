import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { findAlbumArtwork } from "./artwork";
import {
    normalizeArtistName,
    canonicalizeVariousArtists,
    parseArtistFromPath,
    extractArtistFromRelativePath,
    extractAlbumFromRelativePath,
    sanitizeTagString,
} from "../utils/artistNormalization";
import { parseCredit, resolveArtist } from "./artistIdentity";
import { resolveAlbum } from "./albumIdentity";
import { acoustidService } from "./acoustidService";
import { failureCause } from "../utils/outcome";
import { fpcalcService } from "./fpcalc";
import { featureDetection } from "./featureDetection";
import { backfillAllArtistCounts } from "./artistCountsService";
import { checkLocalArtistImage } from "./imageStorage";

/**
 * AcoustID-first identification.
 *
 * Order of resolution for a file's album identity:
 *   1. the file's own `musicbrainz_releasegroupid` tag (unchanged path),
 *   2. the file's embedded AcoustID fingerprint tag -> AcoustID lookup,
 *   3. fpcalc on the file -> AcoustID lookup,
 *   4. nothing — resolveAlbum's `temp-<ts>-<random>` placeholder stands
 *      (enrichment's MusicBrainz title search stays the fallback; the
 *      placeholder scheme must NOT be retired — OwnedAlbum/DiscoveryAlbum
 *      key on the rgMbid string value, see albumIdentity.ts scope note).
 *
 * Every outcome is counted so the sweep report can show which path resolved
 * each track. AcoustID is best-effort: any failure falls through silently.
 */
type IdentificationPath =
    | "mbid-tag"
    | "acoustid-tag"
    | "fpcalc"
    | "placeholder";

const identificationCounters: Record<IdentificationPath, number> = {
    "mbid-tag": 0,
    "acoustid-tag": 0,
    fpcalc: 0,
    placeholder: 0,
};

export function getIdentificationCounters() {
    return { ...identificationCounters };
}

/**
 * Run fpcalc on a file; returns fingerprint + duration, throws on failure.
 *
 * Delegates to the shared fpcalcService runner. fpcalc 1.5.x has NO
 * `-format=json` output flag (`-format` selects the *input* format); the
 * output flag is `-json` on every version since 1.4 — verified live on both
 * 1.6.1 (this dev box) and the 1.5.1 sources.
 */
async function fingerprintFile(
    absolutePath: string,
): Promise<{ fingerprint: string; duration: number } | null> {
    return fpcalcService.fingerprintFile(absolutePath);
}

/**
 * Resolve the album identity for one scanned file, trying the AcoustID
 * paths only when the file carries no usable MusicBrainz tag. Returns the
 * rgMbid to hand to resolveAlbum plus which path resolved it.
 */
async function resolveAlbumIdentity(
    absolutePath: string,
    tagRgMbid: string | null | undefined,
    tagAcoustidId: string | null | undefined,
    duration: number,
): Promise<{ rgMbid: string | null; via: IdentificationPath }> {
    // 1. File's own MusicBrainz tag — authoritative, no network.
    if (tagRgMbid?.trim()) {
        identificationCounters["mbid-tag"]++;
        return { rgMbid: tagRgMbid.trim(), via: "mbid-tag" };
    }

    // 2. File's embedded AcoustID recording id (AcoustID:MBID:<uuid> or bare
    //    uuid) — resolve it without fingerprinting.
    const acoustidTag = tagAcoustidId?.trim();
    if (acoustidTag) {
        const mbid = acoustidTag.replace(/^AcoustID:MBID:/i, "");
        // The tag gives a recording id, not a release-group id; use the
        // fingerprint path only when we can actually look something up.
        // Without a fingerprint there is nothing to query, so fall through
        // to fpcalc rather than trusting a raw id we cannot resolve here.
        logger.debug(
            `[Scanner] AcoustID tag present (${mbid.slice(0, 12)}…), fingerprinting to resolve`,
        );
    }

    // 3. fpcalc -> AcoustID lookup (covers both the tagged case, which needs
    //    the fingerprint to resolve, and untagged files). Same gate as the
    //    enrichment path: the fpcalc feature flag (binary present, not
    //    disabled) decides whether this path runs. The service resolves the
    //    client key itself — operator key from SystemSettings, baked default
    //    as fallback — so no key plumbing happens here. The shared runner now
    //    THROWS on a real fpcalc failure; the scan only falls through to the
    //    placeholder path (the stage records own per-track failures).
    const features = await featureDetection.getFeatures();
    if (features.fpcalc) {
        let fp: { fingerprint: string; duration: number } | null = null;
        try {
            fp = await fingerprintFile(absolutePath);
        } catch (err) {
            logger.debug(
                `[Scanner] fpcalc failed for ${path.basename(absolutePath)}: ${(err as Error).message}`,
            );
        }
        if (fp) {
            const match = await acoustidService.lookup(fp.duration, fp.fingerprint);
            if (match.kind === "answered") {
                identificationCounters[acoustidTag ? "acoustid-tag" : "fpcalc"]++;
                logger.info(
                    `[Scanner] Identified ${path.basename(absolutePath)} via ${
                        acoustidTag ? "AcoustID tag + fingerprint" : "fingerprint"
                    }: ${match.value.releaseGroupMbid} (${match.value.title} — ${match.value.album})`,
                );
                return { rgMbid: match.value.releaseGroupMbid, via: acoustidTag ? "acoustid-tag" : "fpcalc" };
            }
            // "No match" and "call failed" both fall through to the
            // placeholder stands, but the log keeps the difference.
            logger.debug(
                `[Scanner] no fingerprint identification for ${path.basename(absolutePath)}: ${
                    match.kind === "absent"
                        ? "AcoustID has no match"
                        : failureCause(match)
                }`,
            );
        }
    }

    // 4. Placeholder stands; enrichment's MusicBrainz path is the fallback.
    identificationCounters.placeholder++;
    return { rgMbid: null, via: "placeholder" };
}

// Supported audio formats
const AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".wv",
]);

interface ScanProgress {
    filesScanned: number;
    filesTotal: number;
    currentFile: string;
    errors: Array<{ file: string; error: string }>;
}

interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    /** Tracks newly flagged missing this scan (file gone from disk). Never deletions. */
    tracksMissing: number;
    tracksCorrupt: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export class MusicScannerService {
    private scanQueue = new PQueue({ concurrency: 10 });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string
    ) {
        this.progressCallback = progressCallback;
        if (coverCachePath) {
            this.coverArtExtractor = new CoverArtExtractor(coverCachePath);
        }
    }

    /**
     * Scan the music directory and update the database
     */
    async scanLibrary(musicPath: string): Promise<ScanResult> {
        const startTime = Date.now();
        const result: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksMissing: 0,
            tracksCorrupt: 0,
            errors: [],
            duration: 0,
        };

        logger.debug(`Starting library scan: ${musicPath}`);

        // Step 1: Find all audio files
        const audioFiles = await this.findAudioFiles(musicPath);
        logger.debug(`Found ${audioFiles.length} audio files`);

        // Step 2: Get existing tracks from database
        const existingTracks = await prisma.track.findMany({
            select: {
                id: true,
                filePath: true,
                fileModified: true,
                missingSince: true,
            },
        });

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t])
        );

        // Step 3: Process each audio file
        let filesScanned = 0;
        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };

        for (const audioFile of audioFiles) {
            await this.scanQueue.add(async () => {
                try {
                    const relativePath = path.relative(musicPath, audioFile);
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const stats = await fs.promises.stat(audioFile);
                    const fileModified = stats.mtime;

                    // Skip 0-byte files (incomplete downloads, stubs)
                    if (stats.size === 0) {
                        filesScanned++;
                        progress.filesScanned = filesScanned;
                        return;
                    }

                    const existingTrack = tracksByPath.get(relativePath);

                    // Check if file needs updating
                    if (existingTrack) {
                        if (
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            // File hasn't changed, skip
                            filesScanned++;
                            progress.filesScanned = filesScanned;
                            return;
                        }
                        // File changed, will update
                        result.tracksUpdated++;
                    } else {
                        // New file
                        result.tracksAdded++;
                    }

                    // Extract metadata and update database
                    await this.processAudioFile(
                        audioFile,
                        relativePath,
                        musicPath
                    );
                } catch (err: any) {
                    const error = {
                        file: audioFile,
                        error: err.message || String(err),
                    };
                    result.errors.push(error);
                    progress.errors.push(error);
                    logger.error(`Error processing ${audioFile}:`, err);

                    const relativePath = path.relative(musicPath, audioFile);
                    const existingTrack = tracksByPath.get(relativePath);
                    if (existingTrack) {
                        await prisma.track.update({
                            where: { id: existingTrack.id },
                            data: { corrupt: true },
                        });
                        result.tracksCorrupt++;
                        logger.debug(`Marked track as corrupt: ${relativePath}`);
                    }
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    this.progressCallback?.(progress);
                }
            });
        }

        await this.scanQueue.onIdle();

        // Step 4: True state for files whose fate the walk settled. A track
        // whose file is missing is never deleted
        // 2026-09-25): deleting the row cascaded away every Play, LikedTrack,
        // TrackStage and embedding recorded against it, and the next scan
        // re-created the row with none of that history. The flag is set with
        // the time the file was found missing and cleared by the scan that
        // finds the file again.
        const scannedPaths = new Set(
            audioFiles.map((f) => path.relative(musicPath, f))
        );

        // Found again: a row flagged missing on an earlier scan whose file is
        // in this walk. Cleared here rather than in the per-file upsert
        // because a restored mount can bring the file back with its OLD mtime
        // -- the Step 3 "file hasn't changed" skip would then never re-process
        // it, and the flag would stick to a track that is demonstrably back.
        const returned = existingTracks.filter(
            (t) => t.missingSince !== null && scannedPaths.has(t.filePath)
        );
        if (returned.length > 0) {
            await prisma.track.updateMany({
                where: { id: { in: returned.map((t) => t.id) } },
                data: { missingSince: null },
            });
            logger.debug(
                `Cleared the missing flag on ${returned.length} track(s) whose files are back`
            );
        }

        const pathCandidates = existingTracks.filter(
            (t) => !scannedPaths.has(t.filePath)
        );

        if (pathCandidates.length > 0) {
            // Safety: verify files are truly missing (guard against path normalization issues)
            const beforeCount = pathCandidates.length;
            const existChecks = await Promise.all(
                pathCandidates.map(async (t) => {
                    const fullPath = path.join(musicPath, t.filePath);
                    try {
                        await fs.promises.access(fullPath);
                        return { track: t, exists: true };
                    } catch {
                        return { track: t, exists: false };
                    }
                })
            );
            const vanished = existChecks
                .filter((c) => !c.exists)
                .map((c) => c.track);
            const pathMismatches = beforeCount - vanished.length;
            if (pathMismatches > 0) {
                logger.debug(
                    `${pathMismatches} track(s) had path mismatches but files exist on disk (skipped missing flag)`
                );
            }

            if (vanished.length > 0) {
                // Only rows not already flagged change: the timestamp is when
                // THIS scan found the file gone, not a later one re-stamping
                // an old fact.
                const marked = await prisma.track.updateMany({
                    where: {
                        id: { in: vanished.map((t) => t.id) },
                        missingSince: null,
                    },
                    data: { missingSince: new Date() },
                });
                result.tracksMissing = marked.count;
                logger.debug(
                    `Flagged ${marked.count} track(s) missing (files not found on disk)`
                );
            }
        }

        // Step 5: Clean up orphaned albums (albums with no tracks)
        const orphanedAlbums = await prisma.album.findMany({
            where: {
                tracks: { none: {} },
            },
            select: { id: true, title: true, artistId: true },
        });

        if (orphanedAlbums.length > 0) {
            logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
            await prisma.album.deleteMany({
                where: {
                    id: { in: orphanedAlbums.map((a) => a.id) },
                },
            });
        }

        // Step 6: Clean up orphaned artists (artists with no albums)
        const orphanedArtists = await prisma.artist.findMany({
            where: {
                albums: { none: {} },
            },
            select: { id: true, name: true },
        });

        if (orphanedArtists.length > 0) {
            logger.debug(
                `Removing ${
                    orphanedArtists.length
                } orphaned artists: ${orphanedArtists
                    .map((a) => a.name)
                    .join(", ")}`
            );
            await prisma.artist.deleteMany({
                where: {
                    id: { in: orphanedArtists.map((a) => a.id) },
                },
            });
        }

        result.duration = Date.now() - startTime;
        logger.debug(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} corrupt:${result.tracksCorrupt} (${result.duration}ms)`
        );

        // Update artist counts in background (non-blocking)
        // This ensures denormalized counts are accurate after scan
        backfillAllArtistCounts().catch((err) => {
            logger.error("[Scan] Artist counts update failed:", err);
        });

        return result;
    }

    /**
     * Check if a file path is within the discovery folder
     * Discovery albums are stored in paths like "discovery/Artist/Album/track.flac"
     * or "Discover/Artist/Album/track.flac" (case-insensitive)
     */
    private isDiscoveryPath(relativePath: string): boolean {
        const normalizedPath = relativePath.toLowerCase().replace(/\\/g, "/");
        // Check if path starts with "discovery/" or "discover/"
        return (
            normalizedPath.startsWith("discovery/") ||
            normalizedPath.startsWith("discover/")
        );
    }

    /**
     * Normalize string for matching - handles encoding differences between
     * file metadata and database records
     */
    private normalizeForMatching(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Remove diacritics (café → cafe)
            .replace(/[''´`]/g, "'") // Normalize apostrophes
            .replace(/[""„]/g, '"') // Normalize quotes
            .replace(/[–—−]/g, "-") // Normalize dashes
            .replace(/\s+/g, " ") // Collapse whitespace
            .replace(/[^\w\s'"-]/g, ""); // Remove other special chars
    }

    /**
     * Check if an album is part of a discovery download by matching artist name + album title.
     * Uses multi-pass matching: exact match first, then partial match as fallback.
     */
    private async isDiscoveryDownload(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        if (!artistName || !albumTitle) return false;

        const normalizedArtist = this.normalizeForMatching(artistName);
        const normalizedAlbum = this.normalizeForMatching(albumTitle);

        // Also try without featured credits (handles "Artist A feat. Artist B")
        const primaryArtist = parseCredit(artistName).primary || artistName;
        const normalizedPrimaryArtist =
            this.normalizeForMatching(primaryArtist);

        logger.debug(
            `[Scanner] Checking discovery: "${artistName}" -> "${normalizedArtist}"`
        );
        if (primaryArtist !== artistName) {
            logger.debug(
                `[Scanner]   Primary artist: "${primaryArtist}" -> "${normalizedPrimaryArtist}"`
            );
        }
        logger.debug(
            `[Scanner]   Album: "${albumTitle}" -> "${normalizedAlbum}"`
        );

        try {
            // Get all discovery jobs (pending, processing, or recently completed)
            const discoveryJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                },
            });

            logger.debug(
                `[Scanner]   Found ${discoveryJobs.length} discovery jobs to check`
            );

            // Pass 1: Exact match after normalization
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || ""
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                if (
                    (jobArtist === normalizedArtist ||
                        jobArtist === normalizedPrimaryArtist) &&
                    jobAlbum === normalizedAlbum
                ) {
                    logger.debug(`[Scanner] EXACT MATCH: job ${job.id}`);
                    return true;
                }
            }

            // Pass 2: Partial match fallback (handles "Album" vs "Album (Deluxe)")
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || ""
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                // Try matching both full artist name and extracted primary artist
                const artistMatch =
                    jobArtist === normalizedArtist ||
                    jobArtist === normalizedPrimaryArtist ||
                    normalizedArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedArtist) ||
                    normalizedPrimaryArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedPrimaryArtist);
                const albumMatch =
                    jobAlbum === normalizedAlbum ||
                    normalizedAlbum.includes(jobAlbum) ||
                    jobAlbum.includes(normalizedAlbum);

                if (artistMatch && albumMatch) {
                    logger.debug(`[Scanner] PARTIAL MATCH: job ${job.id}`);
                    logger.debug(
                        `[Scanner]   Job: "${jobArtist}" - "${jobAlbum}"`
                    );
                    return true;
                }
            }

            // Pass 3: Album-only match (handles featured artists on discovery albums)
            // If the album title matches exactly, this track is likely a featured artist on a discovery album
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                if (
                    jobAlbum === normalizedAlbum &&
                    normalizedAlbum.length > 3
                ) {
                    logger.debug(
                        `[Scanner] ALBUM-ONLY MATCH (featured artist): job ${job.id}`
                    );
                    logger.debug(
                        `[Scanner]   Track artist "${normalizedArtist}" is likely featured on "${jobAlbum}"`
                    );
                    return true;
                }
            }

            // Pass 4: Check DiscoveryAlbum table (for already processed albums) by album title
            const discoveryAlbumByTitle = await prisma.discoveryAlbum.findFirst(
                {
                    where: {
                        albumTitle: { equals: albumTitle, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED"] },
                    },
                }
            );

            if (discoveryAlbumByTitle) {
                logger.debug(
                    `[Scanner] DiscoveryAlbum match (by title): ${discoveryAlbumByTitle.id}`
                );
                return true;
            }

            // Pass 5: Check if artist name matches any discovery album
            // This catches cases where Lidarr downloads a different album than requested
            // e.g., requested "Broods - Broods" but got "Broods - Evergreen"
            const discoveryAlbumByArtist =
                await prisma.discoveryAlbum.findFirst({
                    where: {
                        artistName: { equals: artistName, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED", "DELETED"] }, // Include DELETED to catch cleanup scenarios
                    },
                });

            if (discoveryAlbumByArtist) {
                // Double-check: only match if this artist has NO library albums yet
                // This prevents marking albums from artists that exist in both library and discovery
                const existingLibraryAlbum = await prisma.album.findFirst({
                    where: {
                        artist: {
                            name: { equals: artistName, mode: "insensitive" },
                        },
                        location: "LIBRARY",
                    },
                });

                if (!existingLibraryAlbum) {
                    logger.debug(
                        `[Scanner] DiscoveryAlbum match (by artist): ${discoveryAlbumByArtist.id}`
                    );
                    logger.debug(
                        `[Scanner]   Artist "${artistName}" is a discovery-only artist`
                    );
                    return true;
                }
            }

            logger.debug(`[Scanner] No discovery match found`);
            return false;
        } catch (error) {
            logger.error(`[Scanner] Error checking discovery status:`, error);
            return false;
        }
    }

    /**
     * Recursively find all audio files in a directory
     */
    private async findAudioFiles(dirPath: string): Promise<string[]> {
        const files: string[] = [];

        async function walk(dir: string) {
            const entries = await fs.promises.readdir(dir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (AUDIO_EXTENSIONS.has(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        }

        await walk(dirPath);
        return files;
    }

    /**
     * Process a single audio file and update database
     */

    /**
     * Make sure this album ends up with a cover, in the order that costs least.
     *
     * Art embedded in the audio file wins: it is already on disk, it is the
     * right art for this exact release, and reading it costs nothing. Only when
     * the file carries none do we go outside -- and then to every source rather
     * than to Deezer alone, which is what this did before the artwork sources
     * were unified. Measured on 39 real albums, Deezer alone finds 31 and
     * asking everyone finds 34.
     *
     * Re-extracts when the stored native file has gone missing from the cache,
     * which is the case that leaves an album pointing at a picture that is not
     * there any more.
     */
    private async ensureAlbumCover(
        album: { id: string; coverUrl: string | null; rgMbid: string | null },
        absolutePath: string,
        artistName: string,
        albumTitle: string
    ): Promise<void> {
        if (!this.coverArtExtractor) return;

        let needsExtraction = !album.coverUrl;

        if (album.coverUrl?.startsWith("native:")) {
            const nativePath = album.coverUrl.replace("native:", "");
            const extractorCachePath = path.join(
                (this.coverArtExtractor as any).coverCachePath,
                nativePath
            );
            if (!fs.existsSync(extractorCachePath)) {
                needsExtraction = true;
            }
        }

        if (!needsExtraction) return;

        const coverPath = await this.coverArtExtractor.extractCoverArt(
            absolutePath,
            album.id
        );

        if (coverPath) {
            await prisma.album.update({
                where: { id: album.id },
                data: { coverUrl: `native:${coverPath}` },
            });
            return;
        }

        try {
            const found = await findAlbumArtwork({
                rgMbid: album.rgMbid,
                artistName,
                albumTitle,
            });
            if (found) {
                await prisma.album.update({
                    where: { id: album.id },
                    data: { coverUrl: found.url },
                });
            }
        } catch (error) {
            // Cover art is optional; a scan must not fail over a picture.
        }
    }

    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string
    ): Promise<void> {
        // Extract metadata
        const metadata = await parseFile(absolutePath);
        const stats = await fs.promises.stat(absolutePath);

        // Parse basic info
        const title =
            sanitizeTagString(metadata.common.title) ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNumber = metadata.common.disk.no || null;
        // music-metadata's runtime usually returns `discsubtitle` as a single string,
        // but the type declarations leave the shape ambiguous and some tag formats
        // (e.g., Vorbis with multiple DISCSUBTITLE frames) can produce an array.
        // Guard explicitly so a future shape change doesn't silently write bad data.
        const rawDiscSubtitle = metadata.common.discsubtitle as unknown;
        const discSubtitleInput = Array.isArray(rawDiscSubtitle)
            ? (rawDiscSubtitle[0] as string | null | undefined)
            : (rawDiscSubtitle as string | null | undefined);
        const discSubtitle = sanitizeTagString(discSubtitleInput) || null;
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";
        const rawIsrc = metadata.common.isrc?.[0] || null;
        const isrc = rawIsrc?.split(/[;,]/)[0]?.trim() || null;

        // Artist and album info
        // IMPORTANT: Prefer albumartist over artist to keep albums grouped under the primary artist
        // This prevents featured artists from creating separate album entries
        // e.g., "Artist A feat. Artist B" track should still be under "Artist A"'s album
        let rawArtistName = sanitizeTagString(
            metadata.common.albumartist || metadata.common.artist
        );

        // Folder/filename fallback: If metadata is empty, try to parse from path structure
        if (!rawArtistName || rawArtistName.trim() === "") {
            const parsedArtist = extractArtistFromRelativePath(relativePath);

            if (parsedArtist) {
                logger.debug(
                    `[Scanner] No metadata artist found, using path: "${relativePath}" -> "${parsedArtist}"`
                );
                rawArtistName = parsedArtist;
            } else {
                rawArtistName = "Unknown Artist";
                logger.warn(
                    `[Scanner] Unknown Artist assigned for: ${relativePath} (no metadata, path parse failed)`
                );
            }
        }

        // Singles directory override: If metadata says "Various Artists" but the file
        // is in the Singles/ directory (Soulseek downloads), prefer the folder-derived
        // artist name. Soulseek files often have compilation metadata tags.
        if (
            canonicalizeVariousArtists(rawArtistName) === "Various Artists" &&
            relativePath.startsWith("Singles/")
        ) {
            const folderArtist = extractArtistFromRelativePath(relativePath);
            if (folderArtist && canonicalizeVariousArtists(folderArtist) !== "Various Artists") {
                logger.debug(
                    `[Scanner] Singles override: "${rawArtistName}" -> "${folderArtist}" for ${relativePath}`
                );
                rawArtistName = folderArtist;
            }
        }

        const albumTitle = sanitizeTagString(metadata.common.album)
            || extractAlbumFromRelativePath(relativePath)
            || "Unknown Album";
        const year = metadata.common.year || null;

        // Resolve the artist through the single identity path. This used to be
        // ~170 lines of guessing: split the tag on " & "/" and "/" with "/",",
        // look the fragment up, then a space-collapse pass, then a fuzzy pass at
        // 95%, and only THEN consult the MusicBrainz id that was sitting in the
        // tag the whole time. The split truncated real band names ("Dance With
        // the Dead" -> "Dance") and the space-collapse pass could never fire
        // because it filtered candidates on the un-collapsed name.
        const credit = parseCredit(
            rawArtistName,
            metadata.common.artists as string[] | undefined
        );
        const artistName = credit.primary || rawArtistName;

        let artist = await resolveArtist(prisma, {
            name: artistName,
            mbid: metadata.common.musicbrainz_artistid?.[0],
        });

        // Prefer better capitalisation when the tag has it and the stored row
        // does not (e.g. a row created from a lowercase folder name).
        if (
            artist.name !== artistName &&
            artist.name[0] === artist.name[0].toLowerCase() &&
            artistName[0] === artistName[0].toUpperCase()
        ) {
            artist = await prisma.artist.update({
                where: { id: artist.id },
                data: { name: artistName },
            });
        }

        // Check for local artist image if none set yet
        if (!artist.heroUrl) {
            const pathParts = relativePath.split(path.sep);
            for (let i = pathParts.length - 2; i >= 0; i--) {
                const candidateDir = pathParts.slice(0, i + 1).join(path.sep);
                const localImage = await checkLocalArtistImage(musicPath, candidateDir, artist.id);
                if (localImage) {
                    const updated = await prisma.artist.updateMany({
                        where: { id: artist.id, heroUrl: null },
                        data: { heroUrl: localImage },
                    });
                    if (updated.count > 0) {
                        artist = { ...artist, heroUrl: localImage };
                    }
                    break;
                }
            }
        }

        // Resolve the album through the single identity path. Lookup used to
        // match `title` raw and un-normalised, so "Abbey Road", "abbey road" and
        // "Abbey Road (2019 Remaster)" became three rows under one artist -- and
        // Album models a release GROUP, so those are one album.
        //
        // This CALLS resolveAlbum rather than repeating it. The inline copy that
        // lived here checked identityKey BEFORE rgMbid, so a track carrying an
        // authoritative release-group id could attach to a same-titled album from
        // a different release group -- the mirror of the defect the artist work
        // removed -- and it had no unique-violation retry.
        let isDiscoveryAlbum = false;

        // AcoustID-first identification: try the file's MB tag, then its
        // AcoustID tag / a fresh fingerprint, and only then let the
        // placeholder stand (enrichment's MB title-search stays the fallback).
        const identity = await resolveAlbumIdentity(
            absolutePath,
            metadata.common.musicbrainz_releasegroupid,
            (metadata.common as { acoustidId?: string }).acoustidId
                ?? (metadata.native
                      ? Object.values(metadata.native)
                            .flat()
                            .find((t) => t.id === "ACOUSTID_ID" || t.id === "Acoustid Id")
                            ?.value?.toString()
                      : undefined),
            duration,
        );

        const album = await resolveAlbum(prisma, {
            artistId: artist.id,
            title: albumTitle,
            rgMbid: identity.rgMbid,
            year,
            isCompilation: Boolean(metadata.common.compilation),
            // Runs only when a row is actually created: these checks cost several
            // queries and are pointless on a lookup hit.
            createData: async () => {
                // 1. legacy /music/discovery/ folder
                // 2. artist+album matches a discovery download job
                // 3. artist is discovery-only (has albums, none LIBRARY)
                const isDiscoveryByPath = this.isDiscoveryPath(relativePath);
                const isDiscoveryByJob = await this.isDiscoveryDownload(
                    artistName,
                    albumTitle
                );

                let isDiscoveryArtist = false;
                if (!isDiscoveryByPath && !isDiscoveryByJob) {
                    const artistAlbums = await prisma.album.findMany({
                        where: { artistId: artist.id },
                        select: { location: true },
                    });
                    if (artistAlbums.length > 0) {
                        isDiscoveryArtist = !artistAlbums.some(
                            (a) => a.location === "LIBRARY"
                        );
                        if (isDiscoveryArtist) {
                            logger.debug(
                                `[Scanner] Discovery-only artist detected: ${artistName}`
                            );
                        }
                    }
                }

                isDiscoveryAlbum =
                    isDiscoveryByPath || isDiscoveryByJob || isDiscoveryArtist;

                return {
                    primaryType: "Album",
                    location: isDiscoveryAlbum ? "DISCOVER" : "LIBRARY",
                };
            },
        });

        // Only track ownership for library albums; discovery albums are
        // provisional and must not appear as owned. Keyed on the album's OWN
        // rgMbid rather than a locally recomputed one, so a row that resolveAlbum
        // matched by identity is credited correctly.
        if (!isDiscoveryAlbum) {
            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: artist.id,
                        rgMbid: album.rgMbid,
                    },
                },
                create: {
                    rgMbid: album.rgMbid,
                    artistId: artist.id,
                    source: "native_scan",
                },
                update: {},
            });
        }

        // Cover art. Buried inline until the artwork sources were unified;
        // it is its own method now so it can be exercised without standing up
        // a whole scan.
        await this.ensureAlbumCover(album, absolutePath, artistName, albumTitle);

        // Upsert track
        const track = await prisma.track.upsert({
            where: { filePath: relativePath },
            create: {
                albumId: album.id,
                title,
                trackNo,
                discNumber,
                discSubtitle,
                duration,
                mime,
                filePath: relativePath,
                fileModified: stats.mtime,
                fileSize: stats.size,
                isrc,
                isrcSource: isrc ? "id3" : null,
            },
            update: {
                albumId: album.id,
                title,
                trackNo,
                discNumber,
                discSubtitle,
                duration,
                mime,
                fileModified: stats.mtime,
                fileSize: stats.size,
                corrupt: false,
                ...(isrc ? { isrc, isrcSource: "id3" as const } : {}),
            },
        });

        // Extract embedded lyrics
        try {
            let plainLyrics: string | null = null;
            let syncedLyrics: string | null = null;

            // Check metadata.common.lyrics (ILyricsTag[])
            const lyricsArr = metadata.common.lyrics;
            if (lyricsArr && lyricsArr.length > 0) {
                for (const tag of lyricsArr) {
                    // Synced lyrics: convert syncText[] to LRC format
                    if (tag.syncText && tag.syncText.length > 0 && !syncedLyrics) {
                        syncedLyrics = tag.syncText
                            .map((entry) => {
                                const totalMs = entry.timestamp ?? 0;
                                const mins = Math.floor(totalMs / 60000);
                                const secs = Math.floor((totalMs % 60000) / 1000);
                                const cs = Math.floor((totalMs % 1000) / 10);
                                return `[${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}] ${entry.text}`;
                            })
                            .join("\n");
                    }
                    // Plain lyrics
                    if (tag.text && !plainLyrics) {
                        plainLyrics = tag.text;
                    }
                }
            }

            // Check raw Vorbis LYRICS tag for FLAC (may contain LRC directly)
            if (!syncedLyrics) {
                const nativeTags = metadata.native;
                for (const format of Object.keys(nativeTags)) {
                    const tags = nativeTags[format];
                    for (const tag of tags) {
                        if (tag.id === "LYRICS" && typeof tag.value === "string") {
                            const val = tag.value.trim();
                            // Detect LRC format by timestamp pattern
                            if (/^\[\d{2}:\d{2}/.test(val)) {
                                syncedLyrics = val;
                            } else if (!plainLyrics && val.length > 0) {
                                plainLyrics = val;
                            }
                        }
                    }
                }
            }

            if (plainLyrics || syncedLyrics) {
                await prisma.trackLyrics.upsert({
                    where: { track_id: track.id },
                    create: {
                        track_id: track.id,
                        plain_lyrics: plainLyrics,
                        synced_lyrics: syncedLyrics,
                        source: "embedded",
                    },
                    update: {
                        plain_lyrics: plainLyrics,
                        synced_lyrics: syncedLyrics,
                        source: "embedded",
                    },
                });
            }
        } catch (error) {
            // Non-critical -- don't fail the scan for lyrics
            logger.debug(`[Scanner] Failed to extract lyrics for ${relativePath}:`, error);
        }
    }
}
