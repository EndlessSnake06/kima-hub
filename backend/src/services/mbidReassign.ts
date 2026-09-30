/**
 * MBID reassignment shared by the editor routes and enrichment. Unique
 * violations become DuplicateMbidError (409); an unchanged value or a missing
 * row is a no-op.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Thrown when a unique MBID collision is detected.
 * Carries the entity type and the colliding value for structured error handling.
 */
export class DuplicateMbidError extends Error {
    public readonly entityType: string;
    public readonly mbidValue: string;

    constructor(entityType: string, mbidValue: string) {
        super(`MBID ${mbidValue} is already in use by another ${entityType}`);
        this.entityType = entityType;
        this.mbidValue = mbidValue;
        Object.setPrototypeOf(this, DuplicateMbidError.prototype);
    }
}

/**
 * Change an album's rgMbid in one transaction and move the rows keyed on the
 * old string (OwnedAlbum, DiscoveryAlbum) to the new one.
 */
export async function reassignAlbumRgMbid(
    albumId: string,
    newRgMbid: string
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        // Step 1: read current rgMbid
        const album = await tx.album.findUnique({
            where: { id: albumId },
            select: { rgMbid: true, artistId: true },
        });

        if (!album) {
            logger.warn(`Album ${albumId} not found — skipping rgMbid reassign`);
            return;
        }

        if (album.rgMbid === newRgMbid) {
            // No change needed
            return;
        }

        const oldRgMbid = album.rgMbid;
        const artistId = album.artistId;

        // Step 2: update Album.rgMbid. Album.rgMbid is @unique, so a duplicate
        // collides HERE first — translate P2002 to DuplicateMbidError (same as Step 3).
        try {
            await tx.album.update({
                where: { id: albumId },
                data: { rgMbid: newRgMbid },
            });
        } catch (err: any) {
            if (err.code === "P2002") {
                throw new DuplicateMbidError("album", newRgMbid);
            }
            throw err;
        }

        // Step 3: migrate OwnedAlbum row
        try {
            // Delete the old OwnedAlbum row
            await tx.ownedAlbum.delete({
                where: {
                    artistId_rgMbid: {
                        artistId,
                        rgMbid: oldRgMbid,
                    },
                },
            });
        } catch (err: any) {
            // Row may not exist (e.g., enrichment-created album without OwnedAlbum)
            if (err.code !== "P2025") {
                throw err;
            }
        }

        // Upsert the new OwnedAlbum row
        try {
            await tx.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId,
                        rgMbid: newRgMbid,
                    },
                },
                create: {
                    artistId,
                    rgMbid: newRgMbid,
                    source: "enrichment",
                },
                update: {},
            });
        } catch (err: any) {
            if (err.code === "P2002") {
                throw new DuplicateMbidError("album", newRgMbid);
            }
            throw err;
        }

        // Move DiscoveryAlbum rows to the new rgMbid. Rows whose (userId,
        // weekStartDate, newRgMbid) slot is taken are left and logged, since a unique
        // violation would abort the transaction; a racing insert still can, and
        // identification retries later.
        const staleRows = await tx.discoveryAlbum.findMany({
            where: { rgMbid: oldRgMbid },
            select: { id: true, userId: true, weekStartDate: true },
        });
        if (staleRows.length > 0) {
            const takenSlots = await tx.discoveryAlbum.findMany({
                where: {
                    rgMbid: newRgMbid,
                    OR: staleRows.map((r) => ({
                        userId: r.userId,
                        weekStartDate: r.weekStartDate,
                    })),
                },
                select: { userId: true, weekStartDate: true },
            });
            const taken = new Set(
                takenSlots.map(
                    (t) => `${t.userId}|${t.weekStartDate.toISOString()}`
                )
            );
            const movableIds = staleRows
                .filter(
                    (r) => !taken.has(`${r.userId}|${r.weekStartDate.toISOString()}`)
                )
                .map((r) => r.id);
            for (const row of staleRows) {
                if (taken.has(`${row.userId}|${row.weekStartDate.toISOString()}`)) {
                    logger.warn(
                        `[rgMbid-reassign] DiscoveryAlbum ${row.id} kept on stale ${oldRgMbid}: ` +
                            `user ${row.userId} already has a discovery row for ${newRgMbid} in the same week`
                    );
                }
            }
            if (movableIds.length > 0) {
                await tx.discoveryAlbum.updateMany({
                    where: { id: { in: movableIds } },
                    data: { rgMbid: newRgMbid },
                });
            }
        }
    });
}

/**
 * Reassign an artist's mbid.
 *
 * If P2002 is raised (duplicate mbid), translate to DuplicateMbidError.
 */
export async function reassignArtistMbid(
    artistId: string,
    newMbid: string
): Promise<void> {
    await prisma.artist.update({
        where: { id: artistId },
        data: { mbid: newMbid },
    }).catch((err: any) => {
        if (err.code === "P2002") {
            throw new DuplicateMbidError("artist", newMbid);
        }
        throw err;
    });
}
