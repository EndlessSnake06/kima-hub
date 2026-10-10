import { prisma } from "../../../utils/db";

/**
 * One user, artist, album and track, every name keyed off `prefix` plus a
 * unique tag, so `deleteFixtures(prefix)` removes exactly those rows and the
 * cascades take their plays, playlists and album children with them.
 */
export async function createTrackChain(
    prefix: string,
    label: string,
    opts: { duration?: number; location?: "LIBRARY" | "DISCOVER" } = {},
) {
    const tag = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await prisma.user.create({
        data: { username: `${prefix}-${tag}`, passwordHash: "x", role: "user" },
    });
    const artist = await prisma.artist.create({
        data: { name: `${prefix}-${tag}-artist`, identityKey: `${prefix}-${tag}` },
    });
    const album = await prisma.album.create({
        data: {
            artistId: artist.id,
            rgMbid: `${prefix}-${tag}-mbid`,
            title: `${prefix}-${tag}-album`,
            primaryType: "Album",
            ...(opts.location ? { location: opts.location } : {}),
        },
    });
    const track = await prisma.track.create({
        data: {
            albumId: album.id,
            title: `${prefix}-${tag}-track`,
            trackNo: 1,
            duration: opts.duration ?? 100,
            filePath: `/tmp/${prefix}-${tag}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        },
    });
    return { tag, user, artist, album, track };
}

/** Delete the users and artists a prefix's fixtures created. */
export async function deleteFixtures(prefix: string) {
    await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: prefix } } });
}
