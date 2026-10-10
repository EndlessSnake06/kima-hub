/**
 * A Discover Weekly batch whose downloads have all finished moves to the scan
 * step in one transaction: every failed album is recorded as unavailable (an
 * album already recorded this week counts one more attempt), a job with no
 * album id is passed over, and the batch carries the final counts. Real database.
 */

import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const USER = "discover_completion_user";
const WEEK = new Date("2026-10-05T00:00:00.000Z");
const ALBUMS = {
    gwam: { mbid: "d0484284-1ee7-4157-951a-50f003cbcfb4", title: "Guess Who’s a Mess" },
    idk: { mbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", title: "I Don't Know What I'm Doing" },
};

let discoverWeeklyService: typeof import("../discoverWeekly").discoverWeeklyService;

beforeAll(async () => {
    ({ discoverWeeklyService } = await import("../discoverWeekly"));
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (batchId: string, status: string, album?: { mbid: string; title: string }) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, discoveryBatchId: batchId, type: "album", status,
            subject: `Brad Sucks - ${album?.title ?? "an album with no id"}`, targetMbid: album?.mbid ?? null,
            metadata: { artistName: "Brad Sucks", albumTitle: album?.title ?? "an album with no id", similarity: 0.8, tier: "medium" },
        },
    });

it("records each failed album once, skips a job with no album id, and moves the batch to the scan step", async () => {
    const batch = await prisma.discoveryBatch.create({
        data: { userId: USER, weekStart: WEEK, targetSongCount: 3, totalAlbums: 3, status: "downloading" },
    });
    await prisma.unavailableAlbum.create({
        data: {
            userId: USER, weekStartDate: WEEK, albumMbid: ALBUMS.idk.mbid, artistName: "Brad Sucks",
            albumTitle: ALBUMS.idk.title, similarity: 0.8, tier: "medium", attemptNumber: 1,
        },
    });
    await job(batch.id, "completed", ALBUMS.gwam);
    await job(batch.id, "failed", ALBUMS.idk);
    await job(batch.id, "failed");

    await discoverWeeklyService.checkBatchCompletion(batch.id);

    expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        status: "scanning", completedAlbums: 1, failedAlbums: 2,
    });
    const unavailable = await prisma.unavailableAlbum.findMany({ where: { userId: USER, weekStartDate: WEEK } });
    expect(unavailable.map((u) => [u.albumMbid, u.attemptNumber])).toEqual([[ALBUMS.idk.mbid, 2]]);
});
