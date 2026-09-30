import { Router } from "express";
import axios from "axios";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { getSimilarArtists } from "../services/artistSimilarity";
import { musicBrainzService } from "../services/musicbrainz";
import { deezerService } from "../services/deezer";
import { redisClient } from "../utils/redis";
import { requireAuthOrToken } from "../middleware/auth";
import {
    withAlbumArtwork,
    findAlbumArtwork,
    findArtistArtwork,
} from "../services/artwork";
import { safeError } from "../utils/errors";
import { upstreamHeader } from "../utils/upstreamHeaders";
import { failureCause } from "../utils/outcome";

const router = Router();
router.use(requireAuthOrToken);

// Cache TTL for discovery content (shorter since it's not owned)
const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // 24 hours

/**
 * Wrap a promise so a single dead upstream cannot hang the entire
 * /artists/discover/:nameOrMbid handler past the client budget.
 * Uses Promise.race so a 5-second timeout lets the caller fall back
 * to partial data instead of waiting for the HTTP keep-alive to expire.
 */

// GET /artists/preview/:artistName/:trackTitle - Get Deezer preview URL for a track
router.get("/preview/:artistName/:trackTitle", async (req, res) => {
    try {
        const { artistName, trackTitle } = req.params;
        const decodedArtist = decodeURIComponent(artistName);
        const decodedTrack = decodeURIComponent(trackTitle);

        logger.debug(
            `Getting preview for "${decodedTrack}" by ${decodedArtist}`
        );

        const previewUrl = await deezerService.getTrackPreview(
            decodedArtist,
            decodedTrack
        );

        if (previewUrl) {
            res.json({ previewUrl });
        } else {
            res.status(404).json({ error: "Preview not found" });
        }
    } catch (error) {
        safeError(res, "Track preview fetch", error);
    }
});

// GET /artists/preview/:artistName/:trackTitle/stream - Proxy Deezer preview audio as same-origin media
router.get("/preview/:artistName/:trackTitle/stream", async (req, res) => {
    try {
        const { artistName, trackTitle } = req.params;
        const decodedArtist = decodeURIComponent(artistName);
        const decodedTrack = decodeURIComponent(trackTitle);

        logger.debug(
            `Streaming preview for "${decodedTrack}" by ${decodedArtist}`
        );

        const previewUrl = await deezerService.getFreshTrackPreview(
            decodedArtist,
            decodedTrack
        );

        if (!previewUrl) {
            return res.status(404).json({ error: "Preview not found" });
        }

        const upstream = await axios.get(previewUrl, {
            responseType: "stream",
            timeout: 10000,
        });

        const upstreamContentLength = upstreamHeader(upstream.headers["content-length"]);
        const upstreamAcceptRanges = upstreamHeader(upstream.headers["accept-ranges"]);

        res.setHeader(
            "Content-Type",
            upstreamHeader(upstream.headers["content-type"]) || "audio/mpeg"
        );
        if (upstreamContentLength) {
            res.setHeader("Content-Length", upstreamContentLength);
        }
        if (upstreamAcceptRanges) {
            res.setHeader("Accept-Ranges", upstreamAcceptRanges);
        }
        res.setHeader("Cache-Control", "no-store");

        upstream.data.on("error", (streamErr: unknown) => {
            logger.error("Preview stream pipe error:", streamErr);
            if (!res.headersSent) {
                res.status(502).end();
            } else {
                res.end();
            }
        });

        // Clean up upstream stream when client disconnects (preview cancelled, tab closed, etc)
        res.on("close", () => {
            if (!upstream.data.destroyed) {
                upstream.data.destroy();
            }
        });

        upstream.data.pipe(res);
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            return res.status(404).json({ error: "Preview not found" });
        }
        safeError(res, "Track preview stream", error);
    }
});

// GET /artists/discover/:nameOrMbid - Get artist details for discovery (not in library yet)
router.get("/discover/:nameOrMbid", async (req, res) => {
    const start = Date.now();
    try {
        const { nameOrMbid } = req.params;

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:artist:${nameOrMbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[Discovery] Cache hit for artist: ${nameOrMbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        // Check if it's an MBID (UUID format) or name
        const isMbid =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                nameOrMbid
            );

        let mbid: string | null = isMbid ? nameOrMbid : null;
        let artistName: string = isMbid ? "" : decodeURIComponent(nameOrMbid);

        // If we have a name but no MBID, search for it
        if (!mbid && artistName) {
            const found = await musicBrainzService.searchArtist(
                artistName,
                1
            );
            if (found.kind === "answered") {
                if (found.value.length > 0) {
                    mbid = found.value[0].id;
                    artistName = found.value[0].name;
                }
            } else if (found.kind === "absent") {
                logger.debug(
                    `[Discovery] no artist matches ${artistName} on MusicBrainz`
                );
            } else {
                // A failed search is not "no such artist": serve the page
                // without the MBID-backed data and say so in the log.
                logger.debug(
                    `[Discovery] MB artist search ${found.kind} for ${artistName}: ${failureCause(found)}`
                );
            }
        }

        // With an MBID but no name, ask MusicBrainz. Similar-artist tiles link MBIDs
        // of merged or deleted artists, so `absent` (and a failed call) answer 404.
        if (mbid && !artistName) {
            const mbArtist = await musicBrainzService.getArtist(mbid);
            if (mbArtist.kind === "answered") {
                artistName = mbArtist.value.name;
            } else if (mbArtist.kind === "absent") {
                logger.debug(`MusicBrainz does not know artist ${mbid}`);
            } else {
                logger.debug(
                    `MusicBrainz artist lookup ${mbArtist.kind} for ${mbid}: ${failureCause(mbArtist)}`
                );
            }
        }

        if (!artistName) {
            return res.status(404).json({ error: "Artist not found" });
        }

        let albums: any[] = [];

        // Bio: Wikidata first, Wikipedia abstract via the MB sitelink
        // second — both live inside wikidataService.getArtistInfo.
        const wdInfo = mbid
            ? await withTimeout(
                  (await import("../services/wikidata")).wikidataService.getArtistInfo(
                      artistName,
                      mbid
                  ),
                  8000,
                  "Wikidata getArtistInfo timed out"
              )
            : { summary: null, heroUrl: null };
        const bio = wdInfo?.summary || null;

        // Top tracks: no global play-count source exists anymore (the
        // Last.fm chart was 100% sentinel data with the dead shared key).
        // Discovery artists have no local listens, so serve none; the
        // artist page renders discography + similar artists instead.
        const topTracksPromise = Promise.resolve([] as any[]);

        // Artist artwork (parallel)
        const artworkPromise = findArtistArtwork({
            name: artistName,
            mbid: mbid || undefined,
        })
            .then((r) => r?.url ?? null)
            .catch(() => null);

        // Discography from MusicBrainz (parallel)
        const discographyPromise = (async (): Promise<any[]> => {
            if (!mbid) return [];
            const rgs = await musicBrainzService.getReleaseGroups(
                mbid
            );
            if (rgs.kind !== "answered") {
                logger.debug(
                    `[Discovery] discography for ${artistName}: ${
                        rgs.kind === "absent"
                            ? "MusicBrainz has no release-groups"
                            : failureCause(rgs)
                    }`
                );
                return [];
            }
            try {
                // Filter albums - only show studio albums and EPs
                const filteredReleaseGroups = rgs.value.filter(
                    (rg: any) => {
                        const isPrimaryType =
                            rg["primary-type"] === "Album" ||
                            rg["primary-type"] === "EP";
                        if (!isPrimaryType) return false;

                        const secondaryTypes = rg["secondary-types"] || [];
                        const hasExcludedType = secondaryTypes.some(
                            (type: string) =>
                                [
                                    "Live",
                                    "Compilation",
                                    "Soundtrack",
                                    "Remix",
                                    "DJ-mix",
                                    "Mixtape/Street",
                                ].includes(type)
                        );

                        return !hasExcludedType;
                    }
                );

                const candidates = filteredReleaseGroups.map((rg: any) => ({
                    id: rg.id,
                    rgMbid: rg.id,
                    mbid: rg.id,
                    title: rg.title,
                    type: rg["primary-type"],
                    year: rg["first-release-date"]
                        ? parseInt(rg["first-release-date"].substring(0, 4))
                        : null,
                    releaseDate: rg["first-release-date"] || null,
                    coverUrl: null as string | null,
                    owned: false,
                }));

                const enriched = await withAlbumArtwork(
                    candidates,
                    (a: any) => ({
                        rgMbid: a.rgMbid,
                        artistName,
                        albumTitle: a.title,
                    }),
                    (a: any, coverUrl: string | null) => ({ ...a, coverUrl }),
                );

                enriched.sort((a: any, b: any) => {
                    if (a.year && b.year) return b.year - a.year;
                    if (a.year) return -1;
                    if (b.year) return 1;
                    return 0;
                });
                return enriched;
            } catch (error) {
                logger.error(
                    `Failed to get discography for ${artistName}:`,
                    error
                );
            }
            return [];
        })();

        // Await all parallel independent calls
        const [topTracks, image, discAlbums] = await Promise.all([
            topTracksPromise,
            artworkPromise,
            discographyPromise,
        ]);

        if (discAlbums.length > 0) {
            albums = discAlbums;
        }

        // Similar artists: local centroid NN with the ListenBrainz artist
        // dataset as cold start (replaces artist.getSimilar). Then images
        // via the standard artwork cascade (fanart → Deezer); the old
        // Last.fm image tier is deleted, not kept as a fallback.
        const similarList = await getSimilarArtists(
            mbid || "",
            artistName,
            10
        );
        const similarArtists = await Promise.all(
            similarList.map(async (s) => {
                const image =
                    (
                        await findArtistArtwork({
                            name: s.name,
                            mbid: s.mbid || undefined,
                        })
                    )?.url ?? null;

                return {
                    id: s.mbid || s.name,
                    name: s.name,
                    mbid: s.mbid || null,
                    url: s.url,
                    image,
                };
            })
        );

        // Genres: MusicBrainz artist record (replaces Last.fm tags).
        let tags: string[] = [];
        if (mbid) {
            const mbArtist = await musicBrainzService.getArtist(mbid, [
                "genres",
            ]);
            if (mbArtist.kind === "answered") {
                tags = (mbArtist.value.genres || [])
                    .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
                    .slice(0, 5)
                    .map((g: any) => g.name)
                    .filter(Boolean);
            } else if (mbArtist.kind !== "absent") {
                logger.debug(
                    `MB genres ${mbArtist.kind} for ${artistName}: ${failureCause(mbArtist)}`
                );
            }
        }

        const response = {
            mbid,
            name: artistName,
            image,
            bio, // Wikidata/Wikipedia abstract
            summary: bio, // Alias for consistency
            tags,
            genres: tags, // Alias for consistency
            listeners: 0, // no listener-count source after Last.fm
            playcount: 0,
            url: mbid ? `https://musicbrainz.org/artist/${mbid}` : null,
            albums: albums.map((album: any) => ({ ...album, owned: false })), // Mark all as not owned
            topTracks,
            similarArtists,
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setex(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            logger.debug(`[Discovery] Cached artist: ${artistName}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error) {
        safeError(res, "Artist discovery", error);
    } finally {
        const elapsed = Date.now() - start;
        logger.info(`GET /artists/discover completed in ${elapsed}ms`);
    }
});

// GET /artists/album/:mbid - Get album details for discovery (not in library yet)
router.get("/album/:mbid", async (req, res) => {
    try {
        const { mbid } = req.params;

        // MusicBrainz ids are UUIDs; anything else cannot exist, so answer 404
        // without spending a rate-limited request.
        const MBID_PATTERN =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!MBID_PATTERN.test(mbid)) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:album:${mbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[Discovery] Cache hit for album: ${mbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        let releaseGroup: any = null;
        let release: any = null;
        let releaseGroupId: string = mbid;

        // Try as release-group first, then as release.
        const rgOutcome = await musicBrainzService.getReleaseGroup(mbid);
        if (rgOutcome.kind === "answered") {
            releaseGroup = rgOutcome.value;
        } else if (
            rgOutcome.kind === "absent" ||
            rgOutcome.kind === "permanent"
        ) {
            // Any "you asked for something that isn't there" answer means
            // this is not a release-group, so try it as a release.
            logger.debug(`${mbid} is not a release-group, trying as release...`);
            const relOutcome = await musicBrainzService.getRelease(mbid);
            if (relOutcome.kind === "answered") {
                release = relOutcome.value;
            } else if (relOutcome.kind === "absent") {
                // A well-formed id that MusicBrainz knows nothing about as
                // either a release-group or a release is simply an album
                // that does not exist.
                return res.status(404).json({ error: "Album not found" });
            } else {
                // A failed call is not "album not found": the page cannot
                // be built honestly without the data, so say what happened.
                logger.debug(
                    `MB release lookup ${relOutcome.kind} for ${mbid}: ${failureCause(relOutcome)}`
                );
                return res
                    .status(503)
                    .json({ error: "MusicBrainz is not answering" });
            }
            releaseGroupId = release["release-group"]?.id || mbid;

            // Now get the release group to get the type and first-release-date
            if (releaseGroupId) {
                const rg2 = await musicBrainzService.getReleaseGroup(
                    releaseGroupId
                );
                if (rg2.kind === "answered") {
                    releaseGroup = rg2.value;
                } else {
                    logger.debug(
                        `Failed to get release-group ${releaseGroupId}: ${
                            rg2.kind === "absent"
                                ? "no such release-group"
                                : failureCause(rg2)
                        }`
                    );
                }
            }
        } else {
            // Neither answer nor "not there" — the lookup itself failed;
            // that is a server-side problem, not a missing album.
            logger.debug(
                `MB release-group lookup ${rgOutcome.kind} for ${mbid}: ${failureCause(rgOutcome)}`
            );
            return res
                .status(503)
                .json({ error: "MusicBrainz is not answering" });
        }

        // Get the artist name and MBID from either release-group or release
        const artistCredit =
            releaseGroup?.["artist-credit"] || release?.["artist-credit"];
        const artistName = artistCredit?.[0]?.name || "Unknown Artist";
        const artistMbid = artistCredit?.[0]?.artist?.id;
        const albumTitle = releaseGroup?.title || release?.title;

        // Tracks come from the release if we have one, else the group's first release.
        let tracks: any[] = [];
        if (release) {
            tracks = release.media?.[0]?.tracks || [];
        } else if (releaseGroup?.releases && releaseGroup.releases.length > 0) {
            const firstRelease = releaseGroup.releases[0];
            const releaseDetails = await musicBrainzService.getRelease(
                firstRelease.id
            );
            if (releaseDetails.kind === "answered") {
                tracks = releaseDetails.value.media?.[0]?.tracks || [];
            } else {
                logger.error(
                    `Failed to get tracks for release ${firstRelease.id}: ${
                        releaseDetails.kind === "absent"
                            ? "no data on MusicBrainz"
                            : failureCause(releaseDetails)
                    }`
                );
            }
        }

        // Album cover art: ask the artwork cascade and accept null. A URL
        // that was never verified renders a broken box the browser eats
        // silently, and the failure never reaches this server.
        const coverUrl =
            (
                await findAlbumArtwork({
                    rgMbid: releaseGroupId || mbid,
                    artistName,
                    albumTitle,
                })
            )?.url ?? null;

        // Format response
        const releaseMbid = release?.id || null;

        const response = {
            id: releaseGroupId,
            rgMbid: releaseGroupId,
            mbid: releaseMbid || releaseGroupId,
            releaseMbid,
            title: albumTitle,
            artist: {
                name: artistName,
                id: artistMbid || artistName,
                mbid: artistMbid,
            },
            year: releaseGroup?.["first-release-date"]
                ? parseInt(releaseGroup["first-release-date"].substring(0, 4))
                : release?.date
                ? parseInt(release.date.substring(0, 4))
                : null,
            type: releaseGroup?.["primary-type"] || "Album",
            coverUrl,
            coverArt: coverUrl, // Alias for compatibility
            bio:
                (releaseGroup as any)?.annotation ||
                (release as any)?.annotation ||
                null,
            tags: ((releaseGroup as any)?.tags || [])
                .map((t: any) => t?.name)
                .filter(Boolean)
                .slice(0, 5),
            tracks: tracks.map((track: any, index: number) => ({
                id: `mb-${releaseGroupId}-${track.id || index}`,
                title: track.title,
                trackNo: track.position || index + 1,
                discNumber: null,
                discSubtitle: null,
                duration: track.length ? Math.floor(track.length / 1000) : 0,
                artist: { name: artistName },
            })),
            similarAlbums: [], // Similar album recommendations not yet implemented
            owned: false,
            source: "discovery",
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setex(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            logger.debug(`[Discovery] Cached album: ${albumTitle}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error) {
        safeError(res, "Album discovery", error);
    }
});

export default router;
