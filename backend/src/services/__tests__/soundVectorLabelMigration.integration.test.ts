/**
 * Migration 20261008130000: vectors under 1.10's label (a different CLAP checkpoint) are removed and their
 * tracks asked again; a track whose file is gone is closed as missing; vectors under 1.11's label stay.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";

const P = "svl";
const SQL = fs.readFileSync(
    path.join(__dirname, "../../../prisma/migrations/20261008130000_sound_vector_label/migration.sql"),
    "utf8",
);
const unit = `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

async function track(id: string, label: string, missing = false) {
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb`, title: id, trackNo: 1, duration: 200, filePath: `/tmp/${id}.flac`,
            fileModified: new Date(), fileSize: 1, vibeAnalysisStatus: "completed",
            ...(missing ? { missingSince: new Date() } : {}),
        },
    });
    await prisma.trackStage.create({ data: { id: `${id}__embedding`, trackId: id, stage: "embedding", status: "done", attempt: 1, retryable: false } });
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, $3, now())`,
        id, unit, label,
    );
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "Label Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Label Album", primaryType: "Album" } });
    await track(`${P}old`, "laion-clap-music-v1");
    await track(`${P}gone`, "laion-clap-music-v1", true);
    await track(`${P}new`, "laion-clap-htsat-unfused-v1");
    // Statements end at a semicolon closing a line (one sits inside a string literal).
    const statements = SQL.split(/;\s*$/m)
        .map((s) => s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

async function stage(id: string) {
    return prisma.trackStage.findUniqueOrThrow({ where: { id: `${id}__embedding` } });
}

describe("re-queueing vectors from 1.10's model", () => {
    it("removes the old-model vector and asks the track again", async () => {
        expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM track_embeddings WHERE track_id = $1`, `${P}old`)).toHaveLength(0);
        expect(await stage(`${P}old`)).toMatchObject({ status: "pending", retryable: true });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: `${P}old` } })).vibeAnalysisStatus).toBe("pending");
    });

    it("closes a missing file's record as missing instead of leaving it waiting", async () => {
        expect(await stage(`${P}gone`)).toMatchObject({ status: "failed", failureClass: "FILE_MISSING", retryable: false });
    });

    it("leaves vectors from 1.11's model alone", async () => {
        expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM track_embeddings WHERE track_id = $1`, `${P}new`)).toHaveLength(1);
        expect(await stage(`${P}new`)).toMatchObject({ status: "done" });
    });
});
