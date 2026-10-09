/**
 * The embedding write probe on the migrated schema: it fails, with the right reason, when
 * track_embeddings is missing, lost its key, or lost a column the upsert writes.
 */

import { prisma } from "../../utils/db";
import { checkEmbeddingWritePath } from "../embeddingsHealth";

jest.setTimeout(30_000);

async function embeddingRowCount(): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM track_embeddings
    `;
    return rows[0].count;
}

describe("embedding write path on a migrated database", () => {
    it("accepts the analyzer's upsert", async () => {
        const result = await checkEmbeddingWritePath(true);

        expect(result).toEqual(
            expect.objectContaining({ ok: true }),
        );
    });

    it("leaves no row behind", async () => {
        const before = await embeddingRowCount();

        await checkEmbeddingWritePath(true);

        expect(await embeddingRowCount()).toBe(before);
    });

    it("fails on a table without the key the upsert needs", async () => {
        await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings RENAME TO track_embeddings_keep`);
        try {
            await prisma.$executeRawUnsafe(
                `CREATE TABLE track_embeddings (track_id text, embedding vector(512), model_version text, analyzed_at timestamp)`,
            );
            const result = await checkEmbeddingWritePath(true);
            expect(result).toEqual(expect.objectContaining({ ok: false, reason: "missing_unique_constraint" }));
        } finally {
            await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS track_embeddings`);
            await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings_keep RENAME TO track_embeddings`);
        }
    });

    it("tells a missing table from a missing column", async () => {
        await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings RENAME TO track_embeddings_keep`);
        try {
            expect(await checkEmbeddingWritePath(true)).toEqual(
                expect.objectContaining({ ok: false, reason: "table_missing" }),
            );
            await prisma.$executeRawUnsafe(
                `CREATE TABLE track_embeddings (track_id text PRIMARY KEY, embedding vector(512), analyzed_at timestamp)`,
            );
            const result = await checkEmbeddingWritePath(true);
            expect(result).toEqual(expect.objectContaining({ ok: false, reason: "probe_failed" }));
            expect(result.detail).toContain("model_version");
        } finally {
            await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS track_embeddings`);
            await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings_keep RENAME TO track_embeddings`);
        }
    });

    it("keeps the uniqueness the upsert depends on", async () => {
        // Stated directly, so the reason a future breakage matters is in the
        // failure output rather than only in a migration comment.
        const constraints = await prisma.$queryRaw<{ conname: string }[]>`
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = 'track_embeddings' AND c.contype IN ('p', 'u')
        `;

        expect(constraints.map((c) => c.conname)).toContain(
            "track_embeddings_pkey",
        );
    });
});
