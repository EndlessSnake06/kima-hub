import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { efFor, withEfSearch } from "../utils/knn";

const REQUEST_CHANNEL = "audio:text:embed";
const RESPONSE_PREFIX = "audio:text:embed:response:";
const TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;
const PUBLISH_TIMEOUT_MS = 5000;

type RedisConn = ReturnType<typeof redisClient.duplicate>;

const emitter = new EventEmitter();
// One short-lived listener per in-flight request, keyed by requestId and removed
// on response or timeout, so the live count tracks real concurrency. A busy
// instance can legitimately exceed Node's default cap; disable the warning rather
// than pick an arbitrary ceiling that would mask a genuine leak.
emitter.setMaxListeners(0);

// The shared redisClient is enableOfflineQueue:false + maxRetriesPerRequest:0
// (fail-fast for request/session work). Text-embed pub/sub must instead ride out a
// cold or reconnecting Redis rather than throwing "Stream isn't writeable" (#197).
// BOTH ends need the soft options: the first fix only hardened the subscriber, so
// publish() on the strict client still threw the same error under load. A
// subscriber-mode connection also cannot publish, so the publisher is separate.
function softDuplicate(): RedisConn {
    return redisClient.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
}

// Bound a Redis op so an unreachable server surfaces as an error instead of an
// unbounded hang (the offline queue buffers commands indefinitely while down).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`text-embed ${label} timed out`)), ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

let subscriber: RedisConn | null = null;
let subscriberPromise: Promise<RedisConn> | null = null;
let publisher: RedisConn | null = null;

function getPublisher(): RedisConn {
    if (publisher && publisher.status === "end") publisher = null;
    if (publisher) return publisher;

    const pub = softDuplicate();
    pub.on("error", (err: Error) => {
        logger.warn(`[TEXT-EMBED] publisher error: ${err.message}`);
    });
    pub.on("end", () => {
        if (publisher === pub) publisher = null;
    });
    publisher = pub;
    return pub;
}

async function ensureSubscriber(): Promise<RedisConn> {
    // Transient drops self-heal: ioredis reconnects (retryStrategy) and re-issues
    // the psubscribe (autoResubscribe), so the cached subscriber recovers on its
    // own. Only a terminal "end" -- reached here via the explicit disconnect()
    // below when setup fails -- must not be reused: the cached promise would
    // otherwise let every later request publish and then wait the full timeout for
    // a response that can never arrive.
    if (subscriber && subscriber.status === "end") {
        subscriber = null;
        subscriberPromise = null;
    }
    if (subscriberPromise) return subscriberPromise;

    subscriberPromise = (async () => {
        const sub = softDuplicate();
        sub.on("error", (err: Error) => {
            // Do NOT drop the cached connection here: ioredis auto-reconnects and
            // re-issues the psubscribe (autoResubscribe), so resetting on every
            // transient error would spawn duplicate subscribers. Terminal death is
            // handled by the "end" handler and the status check above.
            logger.warn(`[TEXT-EMBED] subscriber error: ${err.message}`);
        });
        sub.on("end", () => {
            if (subscriber === sub) subscriber = null;
            subscriberPromise = null;
        });
        sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
            const requestId = channel.slice(RESPONSE_PREFIX.length);
            emitter.emit(requestId, message);
        });
        try {
            // Offline queue buffers psubscribe until connected; bound it so a
            // genuinely unreachable Redis fails instead of hanging the caller (the
            // per-request timeout only starts after this resolves).
            await withTimeout(sub.psubscribe(`${RESPONSE_PREFIX}*`), CONNECT_TIMEOUT_MS, "subscribe");
        } catch (err) {
            sub.disconnect(); // close the half-open socket instead of leaking it
            throw err;
        }
        subscriber = sub;
        logger.info("[TEXT-EMBED] Shared subscriber connected");
        return sub;
    })().catch((err) => {
        // Never cache a rejected promise -- one transient failure must not
        // permanently break vibe text search (#197).
        subscriber = null;
        subscriberPromise = null;
        throw err;
    });

    return subscriberPromise;
}

/**
 * Request a text embedding from the Python CLAP analyzer via Redis pub/sub.
 * Uses long-lived shared subscriber + publisher connections (separate, because a
 * subscriber-mode connection cannot publish) configured to ride out a cold or
 * reconnecting Redis.
 */
export async function getTextEmbedding(text: string): Promise<number[]> {
    await ensureSubscriber();

    const requestId = randomUUID();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const embeddingPromise = new Promise<number[]>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            emitter.removeAllListeners(requestId);
            reject(new Error("Text embedding request timed out"));
        }, TIMEOUT_MS);

        emitter.once(requestId, (message: string) => {
            clearTimeout(timeoutHandle);
            try {
                const data = JSON.parse(message);
                // The analyzer signals failure with { success:false, embedding:null }
                // and does not set data.error, so guard on all of them -- otherwise a
                // null / non-array embedding flows into the pgvector cast and 500s.
                if (data.error || data.success === false || !Array.isArray(data.embedding)) {
                    reject(new Error(data.error || "Analyzer failed to produce embedding"));
                } else {
                    resolve(data.embedding);
                }
            } catch {
                reject(new Error("Invalid response from analyzer"));
            }
        });
    });

    try {
        await withTimeout(
            getPublisher().publish(REQUEST_CHANNEL, JSON.stringify({ requestId, text })),
            PUBLISH_TIMEOUT_MS,
            "publish",
        );
    } catch (err) {
        // The request never reached the analyzer; tear down the pending listener
        // and its timer so it cannot leak or reject unobserved.
        clearTimeout(timeoutHandle);
        emitter.removeAllListeners(requestId);
        throw err;
    }

    return embeddingPromise;
}

export interface TextSearchRow {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    /** pgvector cosine distance between the track and the query text. */
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

/**
 * Text search over the library's CLAP embeddings: the `limit` tracks nearest to
 * the query's text embedding, best first. Shared by /api/vibe/search and the
 * public copy so the two cannot drift.
 *
 * Ranks only; there is deliberately no similarity cut-off. A text-to-audio
 * cosine is comparable only within one query (CLIP-style models turn it into a
 * probability with a softmax at a learned temperature, never against a global
 * constant). Measured on the 8,913-track full library with the
 * padding-fixed text encoder:
 *  - the old fixed 0.40 floor passed 4,789 tracks for "country music with
 *    banjo" (no country in the library) and returned 41 of 745 synth-pop
 *    tracks for "synth pop" (0 before the text encoder's padding fix);
 *  - per-query rules fared no better: tracks 3+ standard deviations above the
 *    query's library mean numbered 0 for "solo piano" (1,258 piano tracks,
 *    top-20 precision 0.90) yet 57 for "jazz saxophone" (no jazz), and the
 *    best score for absent genres (0.52-0.66) overlaps the best score for
 *    present ones (0.48-0.70).
 * No score threshold separates "nothing matches" from "many things match", so
 * the honest contract is a ranked list.
 */
export async function searchTracksByText(
    query: string,
    limit: number,
): Promise<TextSearchRow[]> {
    return searchTracksByEmbedding(await getTextEmbedding(query), limit);
}

/** The ranking half of searchTracksByText, for an already-embedded query. */
export async function searchTracksByEmbedding(
    embedding: number[],
    limit: number,
): Promise<TextSearchRow[]> {
    // pgvector's text form. Bound as a raw number[], an all-integer vector
    // arrives as bigint[], which has no cast to vector.
    const vector = `[${embedding.join(",")}]`;
    // S1: the HNSW index walks hnsw.ef_search candidates (default 40), so any
    // limit past 40 would come back short. No WHERE-clause exclusions here.
    // The query must run on the transaction's own `tx` connection.
    return withEfSearch(efFor(limit, 0), (tx) =>
        tx.$queryRaw<TextSearchRow[]>`
            SELECT
                t.id,
                t.title,
                t.duration,
                t."trackNo",
                te.embedding <=> ${vector}::vector AS distance,
                a.id AS "albumId",
                a.title AS "albumTitle",
                a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId",
                ar.name AS "artistName"
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            ORDER BY te.embedding <=> ${vector}::vector
            LIMIT ${limit}
        `,
    );
}
