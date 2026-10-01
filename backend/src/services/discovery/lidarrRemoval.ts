/**
 * Discover's deletes from Lidarr. Files go only when Lidarr's record is provably
 * Discover's own: the album it asked for, under an artist carrying its tag, and
 * nothing the user's library holds or the user liked.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lidarrService } from "../lidarr";
import { LIBRARY_LOCATION } from "../libraryFilters";
import type { LidarrArtist } from "../../types/lidarr";

async function libraryHolds(rgMbid: string): Promise<boolean> {
    const album = await prisma.album.findFirst({
        where: { rgMbid, location: LIBRARY_LOCATION },
        select: { id: true },
    });
    return album !== null;
}

async function fetchedByDiscover(rgMbids: string[]): Promise<Set<string>> {
    const [albums, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({ where: { rgMbid: { in: rgMbids } }, select: { rgMbid: true } }),
        prisma.downloadJob.findMany({
            where: { targetMbid: { in: rgMbids }, discoveryBatchId: { not: null } },
            select: { targetMbid: true },
        }),
    ]);
    return new Set([...albums.map((a) => a.rgMbid), ...jobs.map((j) => j.targetMbid as string)]);
}

/**
 * Delete a Discover album and its files. Anything that fails the identity check
 * is only unmonitored. Returns true when Lidarr no longer has the album.
 */
export async function removeDiscoveryAlbum(lidarrAlbumId: number, rgMbid: string): Promise<boolean> {
    try {
        if (!(await lidarrService.isEnabled())) return false;
        const album = await lidarrService.getAlbum(lidarrAlbumId);
        if (!album) return true;

        const [artist, tagId] = await Promise.all([
            lidarrService.getArtistById(album.artistId),
            lidarrService.getOrCreateDiscoveryTag(),
        ]);
        const ours =
            album.foreignAlbumId === rgMbid &&
            tagId !== null &&
            !!artist?.tags?.includes(tagId) &&
            !(await libraryHolds(rgMbid));

        if (!ours) {
            logger.warn(
                `[Discover] Keeping Lidarr files for "${album.title}" (${lidarrAlbumId}): not the album Discover fetched`
            );
            await lidarrService.unmonitorAlbum(lidarrAlbumId);
            return false;
        }

        await lidarrService.deleteAlbumById(lidarrAlbumId, true);
        return true;
    } catch (error: any) {
        logger.warn(`[Discover] Lidarr album ${lidarrAlbumId} not removed: ${error.message}`);
        return false;
    }
}

/**
 * "delete" only for a Discover-tagged artist whose every album with files was
 * fetched by Discover, with nothing in the library and nothing liked.
 */
export async function discoveryArtistVerdict(artist: LidarrArtist): Promise<"delete" | "keep"> {
    const tagId = await lidarrService.getOrCreateDiscoveryTag();
    const mbid = artist.foreignArtistId;
    if (tagId === null || !artist.tags?.includes(tagId) || !mbid) return "keep";

    const [liked, owned] = await Promise.all([
        prisma.discoveryAlbum.findFirst({
            where: { artistMbid: mbid, status: { in: ["LIKED", "MOVED"] } },
            select: { id: true },
        }),
        prisma.album.findFirst({
            where: { artist: { mbid }, location: LIBRARY_LOCATION },
            select: { id: true },
        }),
    ]);
    if (liked || owned) return "keep";

    const withFiles = (await lidarrService.getAlbumsByArtistId(artist.id))
        .filter((a) => (a.statistics?.trackFileCount ?? 0) > 0)
        .map((a) => a.foreignAlbumId);
    if (withFiles.length === 0) return "delete";
    const fetched = await fetchedByDiscover(withFiles);
    return withFiles.every((m) => fetched.has(m)) ? "delete" : "keep";
}

/**
 * Delete a Discover artist with its files when the verdict allows. Otherwise the
 * Discover tag comes off, so the artist stays in Lidarr as the user's.
 */
export async function removeDiscoveryArtist(artist: LidarrArtist): Promise<boolean> {
    try {
        if ((await discoveryArtistVerdict(artist)) === "keep") {
            if (artist.foreignArtistId) await lidarrService.removeDiscoveryTagByMbid(artist.foreignArtistId);
            logger.debug(`[Discover] Keeping ${artist.artistName} in Lidarr`);
            return false;
        }
        const result = await lidarrService.deleteArtistById(artist.id, true);
        return result.success;
    } catch (error: any) {
        logger.warn(`[Discover] Lidarr artist ${artist.artistName} not removed: ${error.message}`);
        return false;
    }
}
