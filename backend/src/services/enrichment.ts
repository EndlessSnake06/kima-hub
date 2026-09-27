/**
 * Metadata Enrichment Service
 *
 * Enriches artist/album/track metadata using multiple sources:
 * - MusicBrainz: MBIDs, release dates, track info
 * - Last.fm: Genres, tags, similar artists, bio
 * - Cover Art Archive: Album artwork
 * - Discogs: Additional metadata (optional)
 *
 * Features:
 * - Optional/opt-in (bandwidth intensive)
 * - Rate limiting to respect API limits
 * - Confidence scoring for matches
 * - Manual override support
 */

import { logger } from "../utils/logger";
import { hasRealMbid } from "./artistIdentity";
import { prisma } from "../utils/db";
import { musicBrainzService } from "./musicbrainz";
import { failureCause } from "../utils/outcome";
import { findAlbumArtwork, findArtistArtwork } from "./artwork";
import { downloadAndStoreImage, isNativePath } from "./imageStorage";
import {
    DuplicateMbidError,
    reassignAlbumRgMbid,
    reassignArtistMbid,
} from "./mbidReassign";
import { getSimilarArtists } from "./artistSimilarity";
import { wikidataService } from "./wikidata";

interface EnrichmentSettings {
    enabled: boolean;
    autoEnrichOnScan: boolean;
    sources: {
        musicbrainz: boolean;
        coverArtArchive: boolean;
    };
    rateLimit: {
        maxRequestsPerMinute: number;
        respectApiLimits: boolean;
    };
    overwriteExisting: boolean;
    matchingConfidence: "strict" | "moderate" | "loose";
}

interface ArtistEnrichmentData {
    mbid?: string;
    bio?: string;
    genres?: string[];
    tags?: string[];
    similarArtists?: string[];
    heroUrl?: string;
    formed?: number;
    confidence: number;
}

interface AlbumEnrichmentData {
    rgMbid?: string;
    releaseDate?: Date;
    albumType?: string;
    genres?: string[];
    tags?: string[];
    label?: string;
    coverUrl?: string;
    trackCount?: number;
    confidence: number;
}

class EnrichmentService {
    private defaultSettings: EnrichmentSettings = {
        enabled: false, // Opt-in by default
        autoEnrichOnScan: false,
        sources: {
            musicbrainz: true,
            coverArtArchive: true,
        },
        rateLimit: {
            maxRequestsPerMinute: 30,
            respectApiLimits: true,
        },
        overwriteExisting: false,
        matchingConfidence: "moderate",
    };

    /**
     * Get enrichment settings for a user
     */
    async getSettings(userId: string): Promise<EnrichmentSettings> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { enrichmentSettings: true },
        });

        if (user?.enrichmentSettings) {
            // enrichmentSettings is already a JSON object from Prisma
            let userSettings: any;
            if (typeof user.enrichmentSettings === "string") {
                userSettings = JSON.parse(user.enrichmentSettings);
            } else {
                userSettings = user.enrichmentSettings;
            }

            // IMPORTANT: Always merge with defaults to ensure all fields exist
            return {
                ...this.defaultSettings,
                ...userSettings,
                sources: {
                    ...this.defaultSettings.sources,
                    ...(userSettings.sources || {}),
                },
                rateLimit: {
                    ...this.defaultSettings.rateLimit,
                    ...(userSettings.rateLimit || {}),
                },
            };
        }

        return this.defaultSettings;
    }

    /**
     * Update enrichment settings for a user
     */
    async updateSettings(
        userId: string,
        settings: Partial<EnrichmentSettings>
    ): Promise<EnrichmentSettings> {
        const current = await this.getSettings(userId);
        const updated = { ...current, ...settings };

        await prisma.user.update({
            where: { id: userId },
            data: {
                enrichmentSettings: JSON.stringify(updated) as any,
            },
        });

        return updated;
    }

    /**
     * Enrich a single artist with metadata from multiple sources
     */
    async enrichArtist(
        artistId: string,
        settings?: EnrichmentSettings
    ): Promise<ArtistEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { id: true, name: true, mbid: true },
        });

        if (!artist) {
            // Return null, don't throw. The method already returns null for "nothing to
            // enrich" and the route has a 404 branch waiting for it -- but a throw sailed
            // past that branch into the catch-all and answered 500, so asking to enrich a
            // row deleted by a concurrent scan looked like a server fault.
            logger.debug(`Artist ${artistId} not found; nothing to enrich`);
            return null;
        }

        logger.debug(`Enriching artist: ${artist.name}`);

        const enrichmentData: ArtistEnrichmentData = {
            confidence: 0,
        };

        // Step 1: Get/verify MBID from MusicBrainz
        if (
            config.sources.musicbrainz &&
            !hasRealMbid(artist.mbid)
        ) {
            const found = await musicBrainzService.searchArtist(
                artist.name,
                1
            );
            if (found.kind === "answered" && found.value[0]) {
                enrichmentData.mbid = found.value[0].id;
                enrichmentData.confidence += 0.4;
                logger.debug(`  Found MBID: ${enrichmentData.mbid}`);
            } else if (
                found.kind === "answered" ||
                found.kind === "absent"
            ) {
                logger.debug(`  No MusicBrainz match for ${artist.name}`);
            } else {
                logger.error(`  MusicBrainz lookup ${found.kind}: ${failureCause(found)}`);
            }
        }

        // Step 2: bio from Wikidata, similar artists from the local
        // centroid / ListenBrainz path (replaces the retired Last.fm lookup;
        // runs unconditionally — there is no per-source toggle for it).
        try {
            const artistMbid = enrichmentData.mbid || artist.mbid;
            if (hasRealMbid(artistMbid)) {
                const wd = await wikidataService.getArtistInfo(
                    artist.name,
                    artistMbid
                );
                if (wd?.summary) {
                    enrichmentData.bio = wd.summary;
                    enrichmentData.confidence += 0.3;
                }
                const similar = await getSimilarArtists(
                    artistMbid,
                    artist.name,
                    10
                );
                enrichmentData.similarArtists = similar.map(
                    (a) => a.name
                );
                logger.debug(`  Found ${similar.length} similar artists`);
            }
        } catch (error) {
            logger.error(` Similarity/bio lookup failed:`, error);
        }

        // Step 3: Get artist image from multiple sources (Deezer → Fanart → MusicBrainz)
        try {
            const artistMbid = enrichmentData.mbid || artist.mbid;
            const imageResult = await findArtistArtwork({
                name: artist.name,
                mbid: hasRealMbid(artistMbid) ? artistMbid : undefined,
            });

            if (imageResult) {
                enrichmentData.heroUrl = imageResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found artist image from ${imageResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Artist image lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Enrich a single album with metadata from multiple sources
     */
    async enrichAlbum(
        albumId: string,
        settings?: EnrichmentSettings
    ): Promise<AlbumEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                artist: {
                    select: { name: true, mbid: true },
                },
            },
        });

        if (!album) {
            // Same as enrichArtist above: null reaches the route's existing 404 branch,
            // a throw did not.
            logger.debug(`Album ${albumId} not found; nothing to enrich`);
            return null;
        }

        logger.debug(
            `[Enrichment] Processing album: ${album.artist.name} - ${album.title}`
        );

        const enrichmentData: AlbumEnrichmentData = {
            confidence: 0,
        };

        // Step 1: identify the release group, then take the whole
        // catalogue from it in one two-request chain.
        // Identification has two paths — the artist's discography (needs
        // a real artist MBID) and a title-checked search — and the
        // catalogue answers the remaining questions (genres, label,
        // original year) from whichever id won, cached per album so two
        // albums' worth of requests never repeat.
        if (config.sources.musicbrainz) {
            if (
                album.artist.mbid &&
                hasRealMbid(album.artist.mbid)
            ) {
                const discography =
                    await musicBrainzService.getReleaseGroups(
                        album.artist.mbid,
                        ["album", "ep"],
                        50
                    );

                if (discography.kind === "answered") {
                    // Match by title, in order of how sure we can be.
                    //
                    // Exact first, then punctuation-insensitive, then with
                    // edition markers taken off. That last step is what makes
                    // a deluxe, a remaster or an anniversary edition findable:
                    // MusicBrainz files those as RELEASES inside a plainly
                    // named release GROUP, so "Delta Machine (Deluxe Edition)"
                    // has to be compared as "Delta Machine" or it can never
                    // match anything. On a real library that was about a third
                    // of the albums left without an id.
                    //
                    // The album keeps its own title either way — this decides
                    // what the album IS, not what it is called.
                    const wanted = album.title;
                    const match =
                        discography.value.find(
                            (rg: any) =>
                                rg.title.toLowerCase() === wanted.toLowerCase()
                        ) ||
                        discography.value.find((rg: any) =>
                            titlesAgree(rg.title, wanted)
                        );

                    if (match) {
                        enrichmentData.rgMbid = match.id;
                        enrichmentData.albumType = match["primary-type"];
                        enrichmentData.releaseDate = match["first-release-date"]
                            ? new Date(match["first-release-date"])
                            : undefined;
                        enrichmentData.confidence += 0.5;
                        logger.debug(`  Found MBID: ${enrichmentData.rgMbid}`);
                    }
                } else if (discography.kind === "absent") {
                    logger.debug(
                        `  MusicBrainz has no release-groups for ${album.artist.name}`
                    );
                } else {
                    logger.error(
                        `  Discography lookup ${discography.kind}: ${failureCause(discography)}`
                    );
                }
            }

            // Fallback: search MusicBrainz by name.
            //
            // The branch above needs the ARTIST to already carry a real MBID,
            // and has no else. A library that was never tagged — which is the
            // normal case for anything not run through Picard or beets —
            // starts with a placeholder id on every artist, so that branch
            // never fires and the album is never identified at all. This is
            // the path for those, and it is the search that already exists
            // rather than a new one.
            //
            // What the search returns is NOT trusted on its own: it hands back
            // its best hit with no check that the title is even close, so
            // accepting it blindly would stamp confident, wrong ids onto
            // albums — worse than leaving them unidentified. The result has
            // to survive the same comparison the discography match uses.
            if (!enrichmentData.rgMbid) {
                const hit = await musicBrainzService.searchAlbum(
                    album.title,
                    album.artist.name
                );

                if (
                    hit.kind === "answered" &&
                    titlesAgree(hit.value.title, album.title)
                ) {
                    enrichmentData.rgMbid = hit.value.id;
                    enrichmentData.confidence += 0.3;
                    logger.debug(
                        `  Found MBID by search: ${enrichmentData.rgMbid} ("${hit.value.title}")`
                    );
                } else if (hit.kind === "answered") {
                    logger.debug(
                        `  Rejected search hit "${hit.value.title}" for "${album.title}" — titles do not agree`
                    );
                } else if (hit.kind === "absent") {
                    logger.debug(`  No MusicBrainz hit for "${album.title}"`);
                } else {
                    logger.debug(
                        `  MusicBrainz album search ${hit.kind}: ${failureCause(hit)}`
                    );
                }
            }

            if (enrichmentData.rgMbid) {
                const chain = await musicBrainzService.getAlbumCatalogue(
                    enrichmentData.rgMbid
                );
                if (chain.kind === "answered") {
                    if (chain.value.genres.length > 0) {
                        enrichmentData.genres = [...chain.value.genres]
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 5)
                            .map((g) => g.name);
                    }
                    if (chain.value.label) {
                        enrichmentData.label = chain.value.label;
                        logger.debug(`  Found label: ${enrichmentData.label}`);
                    }
                    if (
                        chain.value.originalYear != null &&
                        !enrichmentData.releaseDate
                    ) {
                        enrichmentData.releaseDate = new Date(
                            `${chain.value.originalYear}-01-01`
                        );
                    }
                } else if (chain.kind !== "absent") {
                    logger.debug(
                        `  Album catalogue ${chain.kind}: ${failureCause(chain)}`
                    );
                }
            }
        }

        // Step 2: genres, label, and original year all arrive with the
        // Step 1 catalogue chain; moods come from audio analysis only
        // so nothing else writes tag-like fields.

        // Step 3: Get cover art from multiple sources (Deezer → MusicBrainz → Fanart)
        try {
            const coverResult = await findAlbumArtwork({
                rgMbid: enrichmentData.rgMbid,
                artistName: album.artist.name,
                albumTitle: album.title,
            });

            if (coverResult) {
                enrichmentData.coverUrl = coverResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found cover art from ${coverResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Album cover lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Apply enrichment data to an artist in the database
     */
    async applyArtistEnrichment(
        artistId: string,
        data: ArtistEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        // Reassign canonical MBID via shared helper (catches P2002 -> log+skip)
        if (data.mbid && data.mbid.trim() !== "") {
            try {
                await reassignArtistMbid(artistId, data.mbid.trim());
            } catch (err) {
                if (err instanceof DuplicateMbidError) {
                    logger.debug(
                        `MBID ${data.mbid} already in use, skipping artist mbid reassign`
                    );
                } else {
                    throw err;
                }
            }
        }

        if (data.bio) updateData.summary = data.bio;
        if (data.heroUrl) {
            if (!isNativePath(data.heroUrl)) {
                const current = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { heroUrl: true },
                });
                if (current?.heroUrl && isNativePath(current.heroUrl)) {
                    // Keep existing local image, skip external URL
                } else {
                    const localPath = await downloadAndStoreImage(
                        data.heroUrl,
                        artistId,
                        "artist"
                    );
                    updateData.heroUrl = localPath || data.heroUrl;
                }
            } else {
                updateData.heroUrl = data.heroUrl;
            }
        }
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.artist.update({
                where: { id: artistId },
                data: updateData,
            });
            logger.debug(
                `   Saved ${data.genres?.length || 0} genres for artist`
            );
        }
    }

    /**
     * Apply enrichment data to an album in the database
     */
    async applyAlbumEnrichment(
        albumId: string,
        data: AlbumEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        // Reassign canonical rgMbid via shared helper (handles Album update + OwnedAlbum migration)
        if (data.rgMbid && data.rgMbid.trim() !== "") {
            try {
                await reassignAlbumRgMbid(albumId, data.rgMbid.trim());
            } catch (err) {
                if (err instanceof DuplicateMbidError) {
                    logger.debug(
                        `rgMbid ${data.rgMbid} already in use, skipping album rgMbid reassign`
                    );
                } else {
                    throw err;
                }
            }
        }

        if (data.coverUrl) {
            // Download cover locally if it's an external URL
            if (!isNativePath(data.coverUrl)) {
                const localPath = await downloadAndStoreImage(
                    data.coverUrl,
                    albumId,
                    "album"
                );
                updateData.coverUrl = localPath || data.coverUrl;
            } else {
                updateData.coverUrl = data.coverUrl;
            }
        }
        if (data.releaseDate) {
            // Store original release date in dedicated field
            updateData.originalYear = data.releaseDate.getFullYear();
            // Also update year for backward compatibility (but originalYear takes precedence)
            updateData.year = data.releaseDate.getFullYear();
        }
        if (data.label) updateData.label = data.label;
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.album.update({
                where: { id: albumId },
                data: updateData,
            });
            logger.debug(
                `   Saved album data: ${
                    data.genres?.length || 0
                } genres, label: ${data.label || "none"}`
            );
        }
    }

}

/**
 * Do these two album titles name the same record?
 *
 * Exact, then punctuation-insensitive, then with edition markers removed --
 * the same ladder in both places that need it. MusicBrainz files a deluxe or a
 * remaster as a RELEASE inside a plainly named release GROUP, so a title
 * carrying that marker has to be compared without it or it matches nothing.
 *
 * Used to CHECK a candidate, never to rename anything. Locally "Playing the
 * Angel (Deluxe)" stays distinct from "Playing the Angel".
 */
export function titlesAgree(a: string, b: string): boolean {
    const bare = (t: string) => foldTitle(musicBrainzService.normalizeForSearch(t));
    if (!a || !b) return false;
    // Identical text is the same title even when nothing survives the fold
    // (an album called "!!!"); the empty-fold guard below is for DIFFERENT text.
    const exact = (t: string) => t.normalize("NFKC").toLowerCase().trim();
    if (exact(a) !== "" && exact(a) === exact(b)) return true;
    const same = (x: string, y: string) => x !== "" && x === y;
    return same(foldTitle(a), foldTitle(b)) || same(bare(a), bare(b));
}

/**
 * Reduce a title to the characters that carry its meaning, in any script.
 *
 * The first version kept only [a-z0-9], so every Japanese, Korean or Cyrillic
 * title folded to "" and any two of them "agreed" -- a search hit for one
 * record was accepted as another. Letters, numbers and combining marks of every
 * script are kept now (marks, because in Devanagari or Thai they are part of the
 * word, and in Japanese a dakuten changes the word). The one thing dropped from
 * marks is a Latin accent, so "Café" and "Cafe" still agree the way tag
 * spellings usually differ. An empty fold never agrees with anything: see the
 * caller.
 */
function foldTitle(t: string): string {
    return t
        .normalize("NFKD")
        .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

export const enrichmentService = new EnrichmentService();
