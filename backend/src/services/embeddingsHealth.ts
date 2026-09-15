import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Can the vibe engine actually store an embedding?
 *
 * This exists because it couldn't, for three weeks, and nothing said so. A
 * database rebuilt outside `prisma migrate deploy` kept every column of
 * track_embeddings and lost its primary key, foreign key and indexes. The
 * analyzer's upsert then failed with
 *
 *   42P10: there is no unique or exclusion constraint matching the
 *          ON CONFLICT specification
 *
 * on every single track, and stored nothing. Every existing check passed:
 * Postgres answered, Redis answered, the enrichment worker reported itself
 * running, and the table accepted plain reads and writes. Nothing asked the
 * only question that mattered -- "can an embedding be written?" -- so it took
 * three weeks and a human noticing the vibe map was frozen.
 *
 * So this probe asks exactly that, by attempting the analyzer's own statement.
 *
 * HOW IT STAYS SAFE: the probe runs inside a transaction that is always rolled
 * back, and it targets a track id that cannot exist. It never writes a row, it
 * never touches a real embedding, and the only thing it can leave behind is a
 * log line.
 */

export interface EmbeddingWriteCheck {
    /** True when an embedding upsert can complete. */
    ok: boolean;
    /** Short machine-readable reason when ok is false. */
    reason?: string;
    /** Detail for logs when ok is false. */
    detail?: string;
    checkedAt: string;
}

/** Marker thrown to force the probe's transaction to roll back. */
class ProbeRollback extends Error {}

const CACHE_MS = 60_000;
const PROBE_TRACK_ID = "__kima_embedding_write_probe__";

let cache: { at: number; value: EmbeddingWriteCheck } | null = null;

function classify(error: unknown): Omit<EmbeddingWriteCheck, "checkedAt"> {
    const message = error instanceof Error ? error.message : String(error);

    // Postgres raises this at plan time when the ON CONFLICT target has no
    // unique or exclusion constraint -- the exact field failure.
    if (
        message.includes("no unique or exclusion constraint") ||
        message.includes("42P10")
    ) {
        return {
            ok: false,
            reason: "missing_unique_constraint",
            detail:
                "track_embeddings has no primary key or unique constraint on track_id, " +
                "so the analyzer's ON CONFLICT (track_id) upsert cannot run and no " +
                "embedding can be stored. The migration " +
                "20260915000000_track_embeddings_constraint_repair exists to repair this " +
                "and runs on startup; if it did not apply, restore the constraint manually.",
        };
    }

    // A foreign key rejection means the constraint inference worked and the
    // database is enforcing integrity -- that is a pass for this probe.
    if (
        message.includes("violates foreign key constraint") ||
        message.includes("23503")
    ) {
        return { ok: true };
    }

    if (message.includes("does not exist") || message.includes("42P01")) {
        return {
            ok: false,
            reason: "table_missing",
            detail: "track_embeddings does not exist",
        };
    }

    return { ok: false, reason: "probe_failed", detail: message.slice(0, 400) };
}

async function probe(): Promise<EmbeddingWriteCheck> {
    const checkedAt = new Date().toISOString();

    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
                INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                VALUES (${PROBE_TRACK_ID}, array_fill(0.0::real, ARRAY[512])::vector, 'write-probe', now())
                ON CONFLICT (track_id) DO UPDATE SET
                    embedding = EXCLUDED.embedding,
                    model_version = EXCLUDED.model_version,
                    analyzed_at = EXCLUDED.analyzed_at
            `;
            // Reached only if the statement was accepted (which, with the
            // foreign key in place, requires the id above to exist -- it never
            // does). Either way nothing is committed.
            throw new ProbeRollback();
        });
    } catch (error) {
        if (error instanceof ProbeRollback) {
            return { ok: true, checkedAt };
        }
        return { ...classify(error), checkedAt };
    }

    return { ok: true, checkedAt };
}

/**
 * Check the embedding write path, cached briefly so health polls do not each
 * pay for a round trip. Pass force to bypass the cache.
 */
export async function checkEmbeddingWritePath(
    force = false,
): Promise<EmbeddingWriteCheck> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) {
        return cache.value;
    }

    const value = await probe();
    cache = { at: Date.now(), value };

    if (!value.ok) {
        logger.error(
            `Embedding write path is BROKEN (${value.reason}): ${value.detail}`,
        );
    }

    return value;
}

/**
 * Run the probe once at startup and make a broken write path loud in the log.
 * Called after the server is listening, so a failure never holds up boot.
 */
export async function reportEmbeddingWritePathAtStartup(): Promise<void> {
    try {
        const result = await checkEmbeddingWritePath(true);
        if (result.ok) {
            logger.info("Embedding write path verified: analyzer upsert is accepted");
        } else {
            logger.error(
                "Embedding write path FAILED at startup -- no audio embedding can be " +
                    "stored and the vibe map will not update. " +
                    `${result.reason}: ${result.detail ?? ""}`,
            );
        }
    } catch (error) {
        logger.warn("Embedding write path check could not run:", error);
    }
}
