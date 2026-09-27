import { Artist } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { wikidataService } from "../services/wikidata";
import { getSimilarArtists } from "../services/artistSimilarity";
import { musicBrainzService } from "../services/musicbrainz";
import { normalizeArtistName } from "../utils/artistNormalization";
import { hasRealMbid } from "../services/artistIdentity";
import { findAlbumArtwork, findArtistArtwork } from "../services/artwork";
import { redisClient } from "../utils/redis";
import { downloadAndStoreImage, isNativePath, nativeFileExists } from "../services/imageStorage";
import { failureCause } from "../utils/outcome";

/**
 * Enriches an artist with metadata from Wikidata
 * - Fetches artist bio/summary and hero image from Wikidata
 * - Similar artists from the local centroid / ListenBrainz engine
 */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    const logPrefix = `[ENRICH ${artist.name}]`;
    logger.debug(`${logPrefix} Starting enrichment (MBID: ${artist.mbid})`);

    // Mark as enriching
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });

    // Track which source provided data
    let imageSource = "none";
    let summarySource = "none";

    try {
        // If artist has a temp MBID, try to get the real one from MusicBrainz
        if (!hasRealMbid(artist.mbid)) {
            logger.debug(
                `${logPrefix} Temp MBID detected, searching MusicBrainz...`
            );
            const found = await musicBrainzService.searchArtist(
                artist.name,
                1
            );
            if (found.kind === "answered" && found.value[0]?.id) {
                const realMbid = found.value[0].id;
                logger.debug(
                    `${logPrefix} MusicBrainz: Found real MBID: ${realMbid}`
                );

                // Update artist with real MBID
                try {
                    await prisma.artist.update({
                        where: { id: artist.id },
                        data: { mbid: realMbid },
                    });
                    artist.mbid = realMbid;
                } catch (mbidError: any) {
                    if (mbidError.code === "P2002") {
                        logger.debug(
                            `${logPrefix} MBID ${realMbid} already used by another artist, keeping temp`
                        );
                    } else {
                        throw mbidError;
                    }
                }
            } else if (
                found.kind === "absent" ||
                found.kind === "answered"
            ) {
                // Nothing usable in the answer — an honest "no match"
                // (or a degenerate empty answer): mark unresolvable.
                logger.debug(
                    `${logPrefix} MusicBrainz: No match found, marking as unresolvable`
                );
                await prisma.artist.update({
                    where: { id: artist.id },
                    data: { enrichmentStatus: "unresolvable", lastEnriched: new Date() },
                });
                return;
            } else {
                // A failed search keeps the question open: the artist
                // stays on its temp MBID and the next cycle asks again —
                // do not mark unresolvable on a source outage.
                logger.debug(
                    `${logPrefix} MusicBrainz search ${found.kind}: ${failureCause(found)}`
                );
            }
        }

        // Try Wikidata first (only if we have a real MBID)
        // Preserve existing heroUrl (e.g., from local file found during scan)
        let summary = null;
        // Only preserve existing heroUrl if the file actually exists on disk
        let heroUrl = (artist.heroUrl && (!isNativePath(artist.heroUrl) || nativeFileExists(artist.heroUrl)))
            ? artist.heroUrl
            : null;
        let genres: string[] = [];

        if (hasRealMbid(artist.mbid)) {
            logger.debug(
                `${logPrefix} Wikidata: Fetching for MBID ${artist.mbid}...`
            );
            try {
                const wikidataInfo = await wikidataService.getArtistInfo(
                    artist.name,
                    artist.mbid
                );
                if (wikidataInfo) {
                    summary = wikidataInfo.summary;
                    if (!heroUrl && wikidataInfo.heroUrl) {
                        heroUrl = wikidataInfo.heroUrl;
                        imageSource = "wikidata";
                    }
                    if (summary) summarySource = "wikidata";
                    logger.debug(
                        `${logPrefix} Wikidata: SUCCESS (image: ${
                            heroUrl ? "yes" : "no"
                        }, summary: ${summary ? "yes" : "no"})`
                    );
                } else {
                    logger.debug(`${logPrefix} Wikidata: No data returned`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Wikidata: FAILED - ${error?.message || error}`
                );
            }
        } else {
            logger.debug(`${logPrefix} Wikidata: Skipped (temp MBID)`);
        }

        // (Last.fm fallback block removed 2026-09-19 — shared key dead.
        // Wikidata above plus MusicBrainz genres below cover the same data.)

        // Image lookup runs whether or not Last.fm had anything. This was
        // Fanart-then-Deezer spelled out here; the ordering, the Last.fm
        // fallback it was missing, and the caching all live in one place now.
        if (!heroUrl) {
            const found = await findArtistArtwork({
                name: artist.name,
                mbid: hasRealMbid(artist.mbid) ? artist.mbid : undefined,
            });
            if (found) {
                heroUrl = found.url;
                imageSource = found.source;
                logger.debug(
                    `${logPrefix} Image: found via ${found.source} - ${heroUrl.substring(0, 60)}...`
                );
            } else {
                logger.debug(`${logPrefix} Image: no source had one`);
            }
        }

        // Genre fallback: MusicBrainz curated genres
        if (genres.length === 0 && hasRealMbid(artist.mbid)) {
            const mbArtist = await musicBrainzService.getArtist(artist.mbid, ["genres"]);
            if (mbArtist.kind === "answered") {
                if (Array.isArray(mbArtist.value.genres)) {
                    genres = mbArtist.value.genres
                        .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
                        .slice(0, 5)
                        .map((g: any) => g.name)
                        .filter(Boolean);
                    if (genres.length > 0) {
                        logger.debug(`${logPrefix} MusicBrainz: ${genres.length} genres: ${genres.join(', ')}`);
                    }
                }
            } else if (mbArtist.kind !== "absent") {
                logger.debug(`${logPrefix} MusicBrainz genres: ${failureCause(mbArtist)}`);
            }
        }

        // Get similar artists (local centroid / ListenBrainz)
        let similarArtists: Array<{
            name: string;
            mbid?: string;
            match: number;
        }> = [];
        let similarFetchFailed = false;
        try {
            // Filter out temp MBIDs
            const validMbid = hasRealMbid(artist.mbid) ? artist.mbid : "";
            similarArtists = await getSimilarArtists(
                validMbid,
                artist.name
            );
            logger.debug(
                `${logPrefix} Similar artists: Found ${similarArtists.length}`
            );
        } catch (error: any) {
            similarFetchFailed = true;
            logger.warn(
                `${logPrefix} Similar artists: FAILED - ${
                    error?.message || error
                }`
            );
        }

        // Log enrichment summary
        logger.debug(
            `${logPrefix} SUMMARY: image=${imageSource}, summary=${summarySource}, heroUrl=${
                heroUrl ? "set" : "null"
            }`
        );

        // Download image locally if we have an external URL
        let localHeroUrl: string | null = null;
        if (heroUrl && !isNativePath(heroUrl)) {
            logger.debug(`${logPrefix} Downloading image locally...`);
            localHeroUrl = await downloadAndStoreImage(heroUrl, artist.id, "artist");
            if (localHeroUrl) {
                logger.debug(`${logPrefix} Image saved locally: ${localHeroUrl}`);
            } else {
                // Download failed -- fall back to external URL; re-read below will prefer any native path
                localHeroUrl = heroUrl;
                logger.debug(`${logPrefix} Failed to download image, using: ${localHeroUrl}`);
            }
        } else if (heroUrl) {
            localHeroUrl = heroUrl; // Already a native path
        }

        // Prepare similar artists JSON for storage (from the similarity source)
        const similarArtistsJson: any =
            similarArtists.length > 0
                ? similarArtists.map((s) => ({
                      name: s.name,
                      mbid: s.mbid || null,
                      match: s.match,
                  }))
                : null;

        // Re-read current heroUrl to avoid clobbering scanner-written local images
        // But only if the file actually exists on disk
        const currentArtist = await prisma.artist.findUnique({
            where: { id: artist.id },
            select: { heroUrl: true },
        });
        const finalHeroUrl = (currentArtist?.heroUrl && isNativePath(currentArtist.heroUrl) && nativeFileExists(currentArtist.heroUrl))
            ? currentArtist.heroUrl
            : localHeroUrl;

        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                summary,
                heroUrl: finalHeroUrl,
                similarArtistsJson,
                genres: genres.length > 0 ? genres : undefined,
                lastEnriched: new Date(),
                enrichmentStatus: similarFetchFailed ? "failed" : "completed",
            },
        });

        // Store similar artists
        if (similarArtists.length > 0) {
            // Delete existing similar artist relationships
            await prisma.similarArtist.deleteMany({
                where: { fromArtistId: artist.id },
            });

            // Create new relationships
            for (const similar of similarArtists) {
                // Find existing similar artist (don't create new ones)
                let similarArtistRecord = null;

                if (similar.mbid) {
                    // Try to find by MBID first
                    similarArtistRecord = await prisma.artist.findUnique({
                        where: { mbid: similar.mbid },
                    });
                }

                if (!similarArtistRecord) {
                    // Try to find by normalized name (case-insensitive)
                    const normalizedSimilarName = normalizeArtistName(
                        similar.name
                    );
                    similarArtistRecord = await prisma.artist.findFirst({
                        where: { normalizedName: normalizedSimilarName },
                    });
                }

                // Only create similarity relationship if the similar artist already exists in our database
                // This prevents endless crawling of similar artists
                if (similarArtistRecord) {
                    await prisma.similarArtist.upsert({
                        where: {
                            fromArtistId_toArtistId: {
                                fromArtistId: artist.id,
                                toArtistId: similarArtistRecord.id,
                            },
                        },
                        create: {
                            fromArtistId: artist.id,
                            toArtistId: similarArtistRecord.id,
                            weight: similar.match,
                        },
                        update: {
                            weight: similar.match,
                        },
                    });
                }
            }

            logger.debug(
                `${logPrefix} Stored ${similarArtists.length} similar artist relationships`
            );
        }

        // Fetch covers for all albums belonging to this artist that don't have covers yet
        await enrichAlbumCovers(artist.id, artist.name);

        // Cache artist image path in Redis for faster access
        if (localHeroUrl) {
            try {
                await redisClient.setex(
                    `hero:${artist.id}`,
                    7 * 24 * 60 * 60,
                    localHeroUrl
                );
            } catch (err) {
                // Redis errors are non-critical
            }
        }
    } catch (error: any) {
        logger.error(
            `${logPrefix} ENRICHMENT FAILED:`,
            error?.message || error
        );

        // Mark as failed
        await prisma.artist.update({
            where: { id: artist.id },
            data: { enrichmentStatus: "failed" },
        });

        throw error;
    }
}

/**
 * Enrich album covers for an artist
 * Fetches covers from Cover Art Archive for albums without covers
 */
async function enrichAlbumCovers(
    artistId: string,
    artistName: string,
): Promise<void> {
    try {
        // Find albums for this artist that don't have cover art
        // Find albums with no cover, or with a native cover file missing from disk
        const allAlbums = await prisma.album.findMany({
            where: {
                artistId,
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                coverUrl: true,
            },
        });
        const albumsWithoutCovers = allAlbums.filter(
            (a) => !a.coverUrl || a.coverUrl === "" || (isNativePath(a.coverUrl) && !nativeFileExists(a.coverUrl))
        );

        if (albumsWithoutCovers.length === 0) {
            logger.debug(`    All albums already have covers`);
            return;
        }

        logger.debug(
            `    Fetching covers for ${albumsWithoutCovers.length} albums...`
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3; // Limit concurrent requests

        // Process in batches to avoid overwhelming Cover Art Archive
        for (let i = 0; i < albumsWithoutCovers.length; i += BATCH_SIZE) {
            const batch = albumsWithoutCovers.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    // A placeholder id only rules out the id-keyed sources.
                    // Deezer searches by artist and title, and this used to
                    // skip the album entirely rather than let it try.
                    if (!album.rgMbid && !album.title) return;

                    try {
                        const coverUrl = (
                            await findAlbumArtwork({
                                rgMbid: album.rgMbid,
                                artistName,
                                albumTitle: album.title,
                            })
                        )?.url ?? null;

                        if (coverUrl) {
                            // Save to database
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl },
                            });

                            // Cache in Redis
                            try {
                                await redisClient.setex(
                                    `album-cover:${album.id}`,
                                    30 * 24 * 60 * 60, // 30 days
                                    coverUrl
                                );
                            } catch (err) {
                                // Redis errors are non-critical
                            }

                            fetchedCount++;
                        }
                    } catch (err) {
                        // Cover art fetch failed, continue with next album
                        logger.debug(`      No cover found for: ${album.title}`);
                    }
                })
            );
        }

        logger.debug(
            `    Fetched ${fetchedCount}/${albumsWithoutCovers.length} album covers`
        );
    } catch (error) {
        logger.error(`    Failed to enrich album covers:`, error);
        // Don't throw - album cover failures shouldn't fail the entire enrichment
    }
}
