import { Router } from "express";
import axios from "axios";
import { logger } from "../utils/logger";
import { lastFmService } from "../services/lastfm";
import { musicBrainzService } from "../services/musicbrainz";
import { deezerService } from "../services/deezer";
import { redisClient } from "../utils/redis";
import { normalizeToArray } from "../utils/normalize";
import { requireAuthOrToken } from "../middleware/auth";
import {
    withAlbumArtwork,
    findAlbumArtwork,
    findArtistArtwork,
} from "../services/artwork";
import { safeError } from "../utils/errors";
import { upstreamHeader } from "../utils/upstreamHeaders";

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
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

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
            const mbResults = await musicBrainzService.searchArtist(
                artistName,
                1
            );
            if (mbResults.length > 0) {
                mbid = mbResults[0].id;
                artistName = mbResults[0].name;
            }
        }

        // If we have MBID but no name, get it from MusicBrainz.
        //
        // A well-formed id MusicBrainz does not recognise is not a server fault. It is the
        // common case here rather than a malformed request: the ids reach us from Last.fm's
        // similar-artist data, which is full of MBIDs for artists that have since been
        // merged or deleted, and the "Fans Also Like" tiles navigate straight back into this
        // handler. Letting the throw escape answered 500 for an ordinary click.
        if (mbid && !artistName) {
            try {
                const mbArtist = await musicBrainzService.getArtist(mbid);
                artistName = mbArtist.name;
            } catch (error: any) {
                const upstreamStatus = error.response?.status;
                if (!(upstreamStatus >= 400 && upstreamStatus < 500)) throw error;
                // Fall through: artistName stays empty and the 404 below answers.
                logger.debug(`MusicBrainz does not know artist ${mbid}`);
            }
        }

        if (!artistName) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // ── Parallelize independent external calls (Defect #1) ──
        // lastFmInfo, topTracks, findArtistArtwork, and getReleaseGroups
        // are all independent of each other (they all depend only on
        // artistName/mbid which are resolved above).  Run them in parallel
        // so a dead upstream cannot block the entire response.

        let albums: any[] = [];

        // Get artist info from Last.fm (wrapped in timeout)
        const lastFmInfo = await withTimeout(
            lastFmService.getArtistInfo(artistName, mbid || undefined),
            5000,
            "Last.fm getArtistInfo"
        );

        // Filter out generic "multiple artists" biographies from Last.fm
        // These occur when Last.fm groups artists with the same name
        let bio = lastFmInfo?.bio?.summary || null;
        if (bio) {
            const lowerBio = bio.toLowerCase();
            if (
                (lowerBio.includes("there are") &&
                    (lowerBio.includes("artist") ||
                        lowerBio.includes("band")) &&
                    lowerBio.includes("with the name")) ||
                lowerBio.includes("there is more than one artist") ||
                lowerBio.includes("multiple artists")
            ) {
                // This is a disambiguation page - don't show it
                logger.debug(
                    `  Filtered out disambiguation biography for ${artistName}`
                );
                bio = null;
            }
        }

        // Get top tracks from Last.fm (parallel with info/artwork/discography)
        const topTracksPromise = lastFmService
            .getArtistTopTracks(mbid || "", artistName, 10)
            .catch(() => {
                logger.debug(`Failed to get top tracks for ${artistName}`);
                return [];
            });

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
            try {
                const releaseGroups = await musicBrainzService.getReleaseGroups(
                    mbid
                );

                // Filter albums - only show studio albums and EPs
                const filteredReleaseGroups = releaseGroups.filter(
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

        // Get similar artists from Last.fm and fetch images
        // NORMALIZATION: lastFmInfo.similar.artist could be a single object or array
        const similarArtistsRaw = normalizeToArray(lastFmInfo?.similar?.artist);
        const similarArtists = await Promise.all(
            similarArtistsRaw.slice(0, 10).map(async (artist: any) => {
                // NORMALIZATION: artist.image could be a single object or array
                const images = normalizeToArray(artist.image);
                // Was `images.find(...)?.[" #text"]` -- the key had a stray
                // leading space, so this was always undefined and the Last.fm
                // fallback below never once fired.
                const similarImage = lastFmService.getBestImage(images);

                // The same three sources as above, so the same one call.
                // `similarImage` is whatever Last.fm already handed us in this
                // response; offered as the address of last resort so we do not
                // ask Last.fm twice for something we are already holding.
                const image =
                    (
                        await findArtistArtwork({
                            name: artist.name,
                            mbid: artist.mbid || undefined,
                            candidateUrl: similarImage,
                        })
                    )?.url ?? null;

                return {
                    id: artist.mbid || artist.name,
                    name: artist.name,
                    mbid: artist.mbid || null,
                    url: artist.url,
                    image,
                };
            })
        );

        // NORMALIZATION: lastFmInfo.tags.tag could be a single object or array
        const tags = normalizeToArray(lastFmInfo?.tags?.tag)
            .map((t: any) => t?.name)
            .filter(Boolean);

        const response = {
            mbid,
            name: artistName,
            image,
            bio, // Use filtered bio instead of raw Last.fm bio
            summary: bio, // Alias for consistency
            tags,
            genres: tags, // Alias for consistency
            listeners: parseInt(lastFmInfo?.stats?.listeners || "0"),
            playcount: parseInt(lastFmInfo?.stats?.playcount || "0"),
            url: lastFmInfo?.url || null,
            albums: albums.map((album: any) => ({ ...album, owned: false })), // Mark all as not owned
            topTracks: topTracks.map((track: any) => ({
                id: `lastfm-${mbid || artistName}-${track.name}`,
                title: track.name,
                playCount: parseInt(track.playcount || "0"),
                listeners: parseInt(track.listeners || "0"),
                duration: parseInt(track.duration || "0"),
                url: track.url,
                album: { title: track.album?.["#text"] || "Unknown Album" },
            })),
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

        // This identifier goes to MusicBrainz, which only ever issues UUIDs. Anything
        // else -- a stale link, a typo, a library id pasted into a discovery URL -- is a
        // request for an album that cannot exist, so answer that directly.
        //
        // Without this the id was forwarded upstream anyway, MusicBrainz rejected it with
        // a 400, the handler below only knew how to recover from a 404, and the rethrow
        // came out of the bottom of the route as "500 Internal server error" -- telling
        // the caller that the server broke when in fact the id was simply wrong. It also
        // spent a rate-limited upstream request to learn nothing.
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

        // Try as release-group first, then as release
        try {
            releaseGroup = await musicBrainzService.getReleaseGroup(mbid);
        } catch (error: any) {
            // Any "you asked for something that isn't there" answer means this is not a
            // release-group, so try it as a release. Only a 404 was handled before, which
            // left every other client-side rejection to escape as a 500.
            const upstreamStatus = error.response?.status;
            if (upstreamStatus >= 400 && upstreamStatus < 500) {
                logger.debug(
                    `${mbid} is not a release-group, trying as release...`
                );
                try {
                    release = await musicBrainzService.getRelease(mbid);
                } catch (releaseError: any) {
                    // A well-formed id that MusicBrainz knows nothing about as either a
                    // release-group or a release is simply an album that does not exist.
                    // Letting this escape reported it as a server fault.
                    const releaseStatus = releaseError.response?.status;
                    if (releaseStatus >= 400 && releaseStatus < 500) {
                        return res.status(404).json({ error: "Album not found" });
                    }
                    throw releaseError;
                }
                releaseGroupId = release["release-group"]?.id || mbid;

                // Now get the release group to get the type and first-release-date
                if (releaseGroupId) {
                    try {
                        releaseGroup = await musicBrainzService.getReleaseGroup(
                            releaseGroupId
                        );
                    } catch (err) {
                        logger.error(
                            `Failed to get release-group ${releaseGroupId}`
                        );
                    }
                }
            } else {
                throw error;
            }
        }

        if (!releaseGroup && !release) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Get the artist name and MBID from either release-group or release
        const artistCredit =
            releaseGroup?.["artist-credit"] || release?.["artist-credit"];
        const artistName = artistCredit?.[0]?.name || "Unknown Artist";
        const artistMbid = artistCredit?.[0]?.artist?.id;
        const albumTitle = releaseGroup?.title || release?.title;

        // Get album info from Last.fm
        let lastFmInfo = null;
        try {
            lastFmInfo = await lastFmService.getAlbumInfo(
                artistName,
                albumTitle
            );
        } catch (error) {
            logger.debug(`Failed to get Last.fm info for ${albumTitle}`);
        }

        // Get tracks - if we have release, use it directly; otherwise get first release from group
        let tracks: any[] = [];
        if (release) {
            tracks = release.media?.[0]?.tracks || [];
        } else if (releaseGroup?.releases && releaseGroup.releases.length > 0) {
            const firstRelease = releaseGroup.releases[0];
            try {
                const releaseDetails = await musicBrainzService.getRelease(
                    firstRelease.id
                );
                tracks = releaseDetails.media?.[0]?.tracks || [];
            } catch (error) {
                logger.error(
                    `Failed to get tracks for release ${firstRelease.id}`
                );
            }
        }

        // Album cover art.
        //
        // This used to build a coverartarchive.org address by hand, HEAD it,
        // fall back to Deezer, and -- when neither had anything -- send the
        // archive address anyway, under a comment reading "might 404, but
        // better than nothing". It is not better than nothing: the browser
        // takes the 404, the page shows a broken box, and the failure never
        // reaches this server. Ask the providers and accept null.
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
            bio: lastFmInfo?.wiki?.summary || null,
            // NORMALIZATION: lastFmInfo.tags.tag could be a single object or array
            tags: normalizeToArray(lastFmInfo?.tags?.tag)
                .map((t: any) => t?.name)
                .filter(Boolean),
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
