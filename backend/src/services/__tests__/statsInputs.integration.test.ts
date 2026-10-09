/**
 * Stats inputs a client controls: the time zone is checked against Postgres's own list (an unknown one
 * would make the query throw), and ignoring a track id that is no track skips it instead of failing.
 */
import { prisma } from "../../utils/db";
import { safeZone } from "../stats/listening";
import { ignoreTracks } from "../playHistoryRepair";

const P = "sti";

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "PlayAuditIgnore" WHERE "userId" LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: `${P}u`, username: `${P}-user`, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Stats Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Stats Album", primaryType: "Album" } });
    await prisma.track.create({
        data: { id: `${P}t1`, albumId: `${P}alb`, title: "One", trackNo: 1, duration: 200, filePath: "/tmp/sti1.flac", fileModified: new Date(), fileSize: 1 },
    });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("keeps a zone Postgres knows and answers UTC for anything else", async () => {
    expect(await safeZone("Europe/London")).toBe("Europe/London");
    expect(await safeZone("America/Chicago")).toBe("America/Chicago");
    expect(await safeZone("Not/AZone")).toBe("UTC");
    expect(await safeZone("'; DROP TABLE x; --")).toBe("UTC");
    expect(await safeZone(undefined)).toBe("UTC");
    const [row] = await prisma.$queryRaw<{ h: number }[]>`SELECT EXTRACT(HOUR FROM now() AT TIME ZONE ${await safeZone("Not/AZone")})::int AS h`;
    expect(typeof row.h).toBe("number");
});

it("ignores the real track and skips an id that is no track", async () => {
    await expect(ignoreTracks(`${P}u`, [`${P}t1`, `${P}missing`])).resolves.toEqual({ ignored: 1 });
    expect(await prisma.playAuditIgnore.count({ where: { userId: `${P}u` } })).toBe(1);
});
