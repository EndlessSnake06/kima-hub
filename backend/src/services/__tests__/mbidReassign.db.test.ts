/**
 * reassignAlbumRgMbid moves DiscoveryAlbum rows to the new rgMbid on the real
 * database, leaving a row on the old one when its unique slot is taken.
 */

import { prisma } from "../../utils/db";
import { reassignAlbumRgMbid } from "../mbidReassign";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const P = "t25db";
const id = (s: string) => `${P}_${s}`;
const OLD = `${P}-old-rgmbid`;
const NEW = `${P}-new-rgmbid`;
const WEEK1 = new Date("2026-09-21T05:00:00.000Z");
const WEEK2 = new Date("2026-09-28T05:00:00.000Z");

async function seed() {
    await prisma.user.create({
        data: {
            id: id("u1"),
            username: id("user1"),
            passwordHash: "x",
        },
    });
    await prisma.artist.create({
        data: { id: id("art"), name: "Reassign Artist", identityKey: id("art") },
    });
    await prisma.album.create({
        data: {
            id: id("alb"),
            title: "Reassign Album",
            artistId: id("art"),
            rgMbid: OLD,
            primaryType: "Album",
        },
    });
    const disc = (userId: string, week: Date, rgMbid: string, leaf: string) =>
        prisma.discoveryAlbum.create({
            data: {
                id: id(leaf),
                userId,
                rgMbid,
                artistName: "Reassign Artist",
                albumTitle: "Reassign Album",
                weekStartDate: week,
            },
        });
    // collides with the pre-existing NEW row on the same user+week
    await disc(id("u1"), WEEK1, OLD, "collide");
    await disc(id("u1"), WEEK1, NEW, "existing");
    // free to move
    await disc(id("u1"), WEEK2, OLD, "free");
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id("u1"));
}

beforeAll(seed);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("reassignAlbumRgMbid against Postgres", () => {
    it("moves the free discovery row, keeps the colliding one, commits the album", async () => {
        await reassignAlbumRgMbid(id("alb"), NEW);

        const album = await prisma.album.findUnique({
            where: { id: id("alb") },
            select: { rgMbid: true },
        });
        expect(album?.rgMbid).toBe(NEW);

        const moved = await prisma.discoveryAlbum.findUnique({ where: { id: id("free") } });
        expect(moved?.rgMbid).toBe(NEW);

        // The collision did not abort the transaction: the moved row proves
        // the write committed; the colliding row is still readable on OLD.
        const kept = await prisma.discoveryAlbum.findUnique({ where: { id: id("collide") } });
        expect(kept?.rgMbid).toBe(OLD);

        const owned = await prisma.ownedAlbum.findUnique({
            where: { artistId_rgMbid: { artistId: id("art"), rgMbid: NEW } },
        });
        expect(owned).not.toBeNull();
    });
});