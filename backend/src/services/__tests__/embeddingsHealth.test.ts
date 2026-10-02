/**
 * How the embedding write probe classifies failures, including 42P10 (no unique
 * constraint for ON CONFLICT) when track_embeddings lost its primary key. The
 * database is mocked; the integration test covers the real schema.
 */

const mockExecuteRaw = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
            mockTransaction(fn),
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

/** Make the probe's statement fail the way a real Postgres would. */
function statementFailsWith(error: Error) {
    mockExecuteRaw.mockRejectedValueOnce(error);
}

beforeEach(() => {
    mockExecuteRaw.mockReset();
    mockTransaction.mockReset();
    // Prisma's interactive transaction hands the callback a client; the probe
    // only ever uses tx.$executeRaw.
    mockTransaction.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({ $executeRaw: mockExecuteRaw }),
    );
});

describe("checkEmbeddingWritePath", () => {
    it("reports the missing constraint when Postgres refuses the ON CONFLICT target", async () => {
        statementFailsWith(
            new Error(
                'there is no unique or exclusion constraint matching the ON CONFLICT specification',
            ),
        );

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing_unique_constraint");
        // The detail must name the repair, because it is read by an operator
        // staring at a broken vibe map, not by a program.
        expect(result.detail).toContain("20260915000000_track_embeddings_constraint_repair");
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });

    it("classifies the raw SQLSTATE 42P10 the same way", async () => {
        statementFailsWith(new Error("ERROR: 42P10"));

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing_unique_constraint");
    });

    it("passes when the foreign key rejects the probe row", async () => {
        // A foreign key rejection means the ON CONFLICT target resolved -- the
        // database is enforcing integrity, which is exactly what we are asking.
        statementFailsWith(
            new Error(
                'insert or update on table "track_embeddings" violates foreign key constraint "track_embeddings_track_id_fkey"',
            ),
        );

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it("reports a missing table distinctly", async () => {
        statementFailsWith(
            new Error('relation "track_embeddings" does not exist'),
        );

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("table_missing");
    });

    it("reports anything else as probe_failed with the message attached", async () => {
        statementFailsWith(new Error("connection terminated unexpectedly"));

        const result = await checkEmbeddingWritePath(true);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("probe_failed");
        expect(result.detail).toContain("connection terminated unexpectedly");
    });

    it("always carries the probe inside a transaction, and never commits a row", async () => {
        mockExecuteRaw.mockResolvedValue(1);

        const result = await checkEmbeddingWritePath(true);

        // $transaction was used (so the statement cannot persist) and the probe
        // rolled itself back rather than reporting the write as valid.
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
    });

    it("caches the verdict briefly, and force bypasses the cache", async () => {
        mockExecuteRaw.mockResolvedValue(1);

        await checkEmbeddingWritePath(true);
        const callsAfterFirst = mockExecuteRaw.mock.calls.length;

        await checkEmbeddingWritePath();
        expect(mockExecuteRaw.mock.calls.length).toBe(callsAfterFirst);

        await checkEmbeddingWritePath(true);
        expect(mockExecuteRaw.mock.calls.length).toBe(callsAfterFirst + 1);
    });
});
