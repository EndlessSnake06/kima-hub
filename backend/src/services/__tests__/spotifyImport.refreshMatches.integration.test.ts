/**
 * Refreshing an import's matches finds songs by artists whose names carry
 * punctuation: the candidates are looked up by the same normal form the
 * library stores ("Simon & Garfunkel" is kept as "simon and garfunkel").
 * Real database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { spotifyImportService } from "../spotifyImport";
import { normalizeArtistName } from "../artistIdentity";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "sprefresh";
const JOB = `${P}job`;

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Playlist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

async function artistWithTrack(key: string, name: string, title: string) {
    await prisma.artist.create({
        data: { id: `${P}${key}`, name, normalizedName: normalizeArtistName(name), identityKey: `${P}-${key}` },
    });
    await prisma.album.create({
        data: { id: `${P}${key}alb`, artistId: `${P}${key}`, rgMbid: `${P}-rg-${key}`, primaryType: "Album", title: `${name} Album` },
    });
    await prisma.track.create({
        data: {
            id: `${P}${key}t`, albumId: `${P}${key}alb`, title, trackNo: 1, duration: 300,
            filePath: `/tmp/${P}-${key}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
}

const pending = (artist: string, title: string, album: string) => ({
    artist, title, album, albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null,
});

beforeAll(async () => {
    await waitForRedisReady();
    await redisClient.del(`import:job:${JOB}`);
    await cleanup();
    await artistWithTrack("sg", "Simon & Garfunkel", "The Boxer");
    await artistWithTrack("acdc", "AC/DC", "Thunderstruck");
    await prisma.user.create({ data: { id: `${P}usr`, username: `${P}-user`, passwordHash: "x" } });
    await prisma.playlist.create({ data: { id: `${P}pl`, userId: `${P}usr`, name: "Imported" } });
    await prisma.spotifyImportJob.create({
        data: {
            id: JOB, userId: `${P}usr`, spotifyPlaylistId: "37i9dQZF1DWXRqgorJj26U", playlistName: "Rock Classics",
            status: "completed", albumsTotal: 2, tracksTotal: 2, createdPlaylistId: `${P}pl`,
            pendingTracks: [
                pending("Simon & Garfunkel", "The Boxer", "Bridge over Troubled Water"),
                pending("AC/DC", "Thunderstruck", "The Razors Edge"),
            ],
        },
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

it("adds songs by artists whose names carry an ampersand or a slash", async () => {
    const result = await spotifyImportService.refreshJobMatches(JOB);
    expect(result.added).toBe(2);
    const items = await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` }, include: { track: true } });
    expect(items.map((i) => i.track.title).sort()).toEqual(["The Boxer", "Thunderstruck"]);
});
