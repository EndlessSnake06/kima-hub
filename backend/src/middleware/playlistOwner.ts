/** Playlist ownership guards: 404 when missing, 403 when not the caller's. */

import { NextFunction, Request, Response } from "express";
import { prisma } from "../utils/db";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            playlist?: {
                id: string;
                userId: string;
                isPublic: boolean;
                name: string;
            };
        }
    }
}

async function loadPlaylist(id: string) {
    return prisma.playlist.findUnique({
        where: { id },
        select: { id: true, userId: true, isPublic: true, name: true },
    });
}

type PlaylistRow = NonNullable<Express.Request["playlist"]>;

function playlistGuard(canAccess: (playlist: PlaylistRow, userId: string) => boolean) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const playlist = await loadPlaylist(req.params.id);
        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (!canAccess(playlist, userId)) {
            return res.status(403).json({ error: "Access denied" });
        }

        req.playlist = playlist;
        next();
    };
}

/**
 * Require that the caller owns the playlist named by `:id`.
 * Attaches it to `req.playlist` so the handler does not re-query.
 */
export const requirePlaylistOwner = playlistGuard(
    (playlist, userId) => playlist.userId === userId
);

/** Require read access: the owner, or anyone if the playlist is public. */
export const requirePlaylistReader = playlistGuard(
    (playlist, userId) => playlist.isPublic || playlist.userId === userId
);
