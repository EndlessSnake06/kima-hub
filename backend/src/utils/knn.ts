import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * Sizing for pgvector's HNSW candidate list (hnsw.ef_search, default 40, hard
 * range 1..1000). With the 40-candidate default an
 * `ORDER BY embedding <=> q LIMIT k` query can never return more than ~40 rows
 * no matter how large the requested k, and WHERE-clause exclusions (alchemy's
 * input tracks, the song path's visited set) are applied AFTER the index walk,
 * so each excluded id also eats one of the same 40 candidates.
 *
 * pgvector's own guidance is a candidate list of at least twice the LIMIT; the
 * excluded count is added on top of that, and 100 is the floor so that small
 * requests still see past clustered noise. 1000 is the hard maximum enforced
 * by pgvector itself (src/hnsw.c) -- larger values error loudly.
 */
export function efFor(limit: number, excluded: number): number {
    return Math.min(1000, Math.max(2 * limit + excluded, 100));
}

/**
 * Run `run` against one connection with hnsw.ef_search raised to `ef` for the
 * duration of that transaction only (set_config's is_local=true reverts the
 * value at COMMIT, so the pool default of 40 is untouched for everyone else).
 *
 * The vector query MUST run on the `tx` client passed to the callback: a
 * pool-level `prisma.$queryRaw` lands on a different pooled connection where
 * the setting never applied -- and a SET LOCAL issued outside a transaction
 * is discarded outright, which is why this helper exists rather than a bare
 * `SET LOCAL` next to the query.
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
