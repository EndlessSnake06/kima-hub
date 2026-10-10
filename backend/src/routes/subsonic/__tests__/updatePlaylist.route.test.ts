/**
 * Subsonic updatePlaylist adds and removes songs on a real playlist. The
 * rows are read back from the database, since the rank column is the order.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { addTracks } from "../../../services/playlistService";
import { playlistRouter } from "../playlists";

const PREFIX = "subsonic-update-playlist-test";

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function fixture(trackCount: number) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await prisma.user.create({
        data: { username: `${PREFIX}-${tag}`, passwordHash: "x", role: "user" },
    });
    const artist = await prisma.artist.create({
        data: { name: `${PREFIX}-${tag}-artist`, identityKey: `${PREFIX}-${tag}` },
    });
    const album = await prisma.album.create({
        data: {
            artistId: artist.id,
            rgMbid: `${PREFIX}-${tag}-mbid`,
            title: `${PREFIX}-${tag}-album`,
            primaryType: "Album",
        },
    });
    const tracks = [];
    for (let i = 0; i < trackCount; i += 1) {
        tracks.push(
            await prisma.track.create({
                data: {
                    albumId: album.id,
                    title: `${PREFIX}-${tag}-track-${i}`,
                    trackNo: i + 1,
                    duration: 100,
                    filePath: `/tmp/${PREFIX}-${tag}-${i}.flac`,
                    fileModified: new Date(),
                    fileSize: 1000,
                },
            }),
        );
    }
    const playlist = await prisma.playlist.create({
        data: { userId: user.id, name: `${PREFIX}-${tag}-pl` },
    });
    return { user, tracks, playlist };
}

function makeApp(userId: string) {
    const app = express();
    app.use((req, _res, next) => {
        (req as any).user = { id: userId };
        next();
    });
    app.use("/rest", playlistRouter);
    return app;
}

function updateUrl(playlistId: string, params: { remove?: number[]; add?: string[] }) {
    const query = new URLSearchParams({ f: "json", playlistId });
    for (const index of params.remove ?? []) query.append("songIndexToRemove", String(index));
    for (const id of params.add ?? []) query.append("songIdToAdd", id);
    return `/rest/updatePlaylist.view?${query.toString()}`;
}

async function itemsInOrder(playlistId: string) {
    return prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
}

describe("subsonic updatePlaylist on a real playlist", () => {
    beforeAll(cleanup);
    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it("removes a song by index and appends new ones in request order", async () => {
        const { user, tracks, playlist } = await fixture(5);
        const [a, b, c, d, e] = tracks;
        await addTracks(playlist.id, [a.id, b.id, c.id]);

        const res = await request(makeApp(user.id)).get(
            updateUrl(playlist.id, { remove: [1], add: [d.id, e.id] }),
        );

        expect(res.status).toBe(200);
        expect(res.body["subsonic-response"].status).toBe("ok");
        const items = await itemsInOrder(playlist.id);
        expect(items.map((item) => item.trackId)).toEqual([a.id, c.id, d.id, e.id]);
        expect(new Set(items.map((item) => item.rank)).size).toBe(items.length);
    });

    it("keeps every song and gives each its own rank when several adds arrive at once", async () => {
        const { user, tracks, playlist } = await fixture(13);
        await addTracks(playlist.id, [tracks[0].id]);
        const batches = [
            tracks.slice(1, 4),
            tracks.slice(4, 7),
            tracks.slice(7, 10),
            tracks.slice(10, 13),
        ];
        const app = makeApp(user.id);

        const responses = await Promise.all(
            batches.map((batch) =>
                request(app).get(updateUrl(playlist.id, { add: batch.map((t) => t.id) })),
            ),
        );

        for (const res of responses) {
            expect(res.status).toBe(200);
            expect(res.body["subsonic-response"].status).toBe("ok");
        }
        const items = await itemsInOrder(playlist.id);
        expect(items.map((item) => item.trackId).sort()).toEqual(
            tracks.map((t) => t.id).sort(),
        );
        expect(new Set(items.map((item) => item.rank)).size).toBe(items.length);
    });
});
