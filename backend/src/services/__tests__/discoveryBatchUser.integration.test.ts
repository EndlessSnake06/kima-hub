/**
 * Migration 20261008170000: discovery batches left behind by users deleted from the admin screen are
 * removed, and from then on a user's batches go with the user, from either delete path.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";

const P = "dbu";
const SQL = fs.readFileSync(
    path.join(__dirname, "../../../prisma/migrations/20261008170000_discovery_batch_user/migration.sql"),
    "utf8",
);

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryBatch" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
}

function batch(id: string, userId: string) {
    return prisma.$executeRawUnsafe(
        `INSERT INTO "DiscoveryBatch" (id, "userId", "weekStart", "targetSongCount") VALUES ($1, $2, now(), 10)`,
        id, userId,
    );
}

beforeEach(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("removes a deleted user's batches with the user", async () => {
    await prisma.user.create({ data: { id: `${P}u1`, username: `${P}-one`, passwordHash: "x" } });
    await batch(`${P}b1`, `${P}u1`);
    await prisma.user.delete({ where: { id: `${P}u1` } });
    expect(await prisma.discoveryBatch.count({ where: { id: `${P}b1` } })).toBe(0);
});

it("migration removes batches of users who no longer exist and keeps everyone else's", async () => {
    await prisma.user.create({ data: { id: `${P}u2`, username: `${P}-two`, passwordHash: "x" } });
    await prisma.$executeRawUnsafe(`ALTER TABLE "DiscoveryBatch" DROP CONSTRAINT "DiscoveryBatch_userId_fkey"`);
    await batch(`${P}live`, `${P}u2`);
    await batch(`${P}orphan`, `${P}gone`);
    for (const statement of SQL.split(";").map((s) => s.trim()).filter((s) => s && !s.split("\n").every((l) => l.startsWith("--")))) {
        await prisma.$executeRawUnsafe(statement);
    }
    const left = await prisma.discoveryBatch.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
    expect(left.map((b) => b.id)).toEqual([`${P}live`]);
    await expect(batch(`${P}again`, `${P}gone`)).rejects.toThrow();
});
