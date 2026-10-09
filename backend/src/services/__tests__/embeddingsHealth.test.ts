/**
 * How the embedding write probe classifies failures, including 42P10 (no unique
 * constraint for ON CONFLICT) when track_embeddings lost its primary key. The
 * database is mocked; the integration test covers the real schema.
 */

const mockQueryRaw = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

import { checkEmbeddingWritePath } from "../embeddingsHealth";

/** Make the probe's statement fail the way Prisma reports a raw-query failure from Postgres. */
function statementFailsWith(code: string, message: string) {
    mockQueryRaw.mockRejectedValueOnce(
        Object.assign(new Error(`Raw query failed. Code: \`${code}\`. Message: \`${message}\``), {
            code: "P2010",
            meta: { code, message },
        }),
    );
}

beforeEach(() => {
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([{ "QUERY PLAN": "Insert on track_embeddings" }]);
});

describe("checkEmbeddingWritePath", () => {
    it("reports the missing constraint when Postgres refuses the ON CONFLICT target", async () => {
        statementFailsWith("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification");

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing_unique_constraint");
        // The detail must name the repair, because it is read by an operator
        // staring at a broken vibe map, not by a program.
        expect(result.detail).toContain("20260915000000_track_embeddings_constraint_repair");
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it("passes when the upsert can be planned", async () => {
        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it("reports a missing table distinctly", async () => {
        statementFailsWith("42P01", 'relation "track_embeddings" does not exist');

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("table_missing");
    });

    it("reports anything else as probe_failed with the message attached", async () => {
        statementFailsWith("42703", 'column "model_version" of relation "track_embeddings" does not exist');

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("probe_failed");
        expect(result.detail).toContain("model_version");
    });

    it("only plans the upsert, never runs it", async () => {
        await checkEmbeddingWritePath(true);

        const sql = (mockQueryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
        expect(sql.trim().startsWith("EXPLAIN INSERT INTO track_embeddings")).toBe(true);
        expect(sql).not.toMatch(/EXPLAIN\s*\(?\s*ANALYZE\b/i);
    });

    it("caches the verdict briefly, and force bypasses the cache", async () => {
        await checkEmbeddingWritePath(true);
        const callsAfterFirst = mockQueryRaw.mock.calls.length;

        await checkEmbeddingWritePath();
        expect(mockQueryRaw.mock.calls.length).toBe(callsAfterFirst);

        await checkEmbeddingWritePath(true);
        expect(mockQueryRaw.mock.calls.length).toBe(callsAfterFirst + 1);
    });
});
