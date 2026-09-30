import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * hnsw.ef_search for a KNN query. The HNSW walk returns at most ef_search
 * candidates (default 40) and WHERE exclusions are applied after it, so use
 * twice the limit plus the excluded count, at least 100 and at most pgvector's 1000.
 */
export function efFor(limit: number, excluded: number): number {
    return Math.min(1000, Math.max(2 * limit + excluded, 100));
}

/**
 * Run `run` in a transaction with hnsw.ef_search set to `ef` for that
 * transaction only. The query must use the `tx` client: the setting does not
 * exist on other pooled connections.
 */
export async function withEfSearch<T>(
    ef: number,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('hnsw.ef_search', ${String(ef)}, true)`;
        return run(tx);
    });
}
