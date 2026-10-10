import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Can an embedding be written? Plans the analyzer's upsert with EXPLAIN, which
 * resolves its ON CONFLICT target without running it. A table missing its keys
 * (rebuilt outside `prisma migrate deploy`) fails with 42P10 on every track while
 * every other health check passes.
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

const CACHE_MS = 60_000;
const PROBE_TRACK_ID = "__kima_embedding_write_probe__";

let cache: { at: number; value: EmbeddingWriteCheck } | null = null;

/** Postgres's error code: Prisma carries it in `meta.code` and in its message (`Code: `42P10``). */
function sqlState(error: unknown): string | undefined {
    const code = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
    if (typeof code === "string") return code;
    const message = error instanceof Error ? error.message : String(error);
    return /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
}

function classify(error: unknown): Omit<EmbeddingWriteCheck, "checkedAt"> {
    const state = sqlState(error);
    if (state === "42P10") {
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
    if (state === "42P01") {
        return { ok: false, reason: "table_missing", detail: "track_embeddings does not exist" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "probe_failed", detail: message.slice(0, 400) };
}

async function probe(): Promise<EmbeddingWriteCheck> {
    const checkedAt = new Date().toISOString();

    try {
        await prisma.$queryRaw`
            EXPLAIN INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
            VALUES (${PROBE_TRACK_ID}, array_fill(0.0::real, ARRAY[512])::vector, 'write-probe', now())
            ON CONFLICT (track_id) DO UPDATE SET
                embedding = EXCLUDED.embedding,
                model_version = EXCLUDED.model_version,
                analyzed_at = EXCLUDED.analyzed_at
        `;
    } catch (error) {
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
