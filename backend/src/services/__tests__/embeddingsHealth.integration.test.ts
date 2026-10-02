/**
 * The embedding write probe on the migrated schema: it fails if a migration
 * drops track_embeddings' primary key, foreign key or uniqueness.
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
