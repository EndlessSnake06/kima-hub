/**
 * Unified Enrichment Worker
 *
 * Handles ALL enrichment in one place:
 * - Artist metadata (MusicBrainz, Wikidata, ListenBrainz)
 * - Track mood tags (MusicBrainz genres)
 * - Audio analysis (triggers Essentia via Redis queue)
 *
 * Two modes:
 * 1. FULL: Re-enriches everything regardless of status (Settings > Enrich)
 * 2. INCREMENTAL: Only new material and incomplete items (Sync)
 */

import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import Redis from "ioredis";
import { config } from "../config";
import os from "os";
import path from "path";
import type { Worker as BullWorker } from "bullmq";
import {
    artistQueue,
    trackQueue,
    vibeQueue,
    podcastQueue,
    closeEnrichmentQueues,
    QUEUE_NAMES,
} from "./enrichmentQueues";
import { startArtistEnrichmentWorker } from "./artistEnrichmentWorker";
import { startTrackEnrichmentWorker } from "./trackEnrichmentWorker";
import { startPodcastEnrichmentWorker } from "./podcastEnrichmentWorker";
import {
    startAudioCompletionSubscriber,
    stopAudioCompletionSubscriber,
    haltVibeQueuing,
    resumeVibeQueuing,
} from "./audioCompletionSubscriber";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import fs from "fs";
import { featureDetection } from "../services/featureDetection";
import { musicBrainzService } from "../services/musicbrainz";
import { trackIdentityService } from "../services/trackIdentity";
import {
    identifyTrackByAcoustid,
    persistAcoustidFingerprint,
    readIdentityTags,
} from "../services/acoustidIdentification";
import { fpcalcService } from "../services/fpcalc";
import { resolveTrackFilePath } from "../routes/library/trackPath";
import { precomputeProjection } from "../services/umapProjection";
import {
    MIN_LOCAL_TRACKS,
    rebuildArtistCentroid,
} from "../services/artistSimilarity";
import {
    classifyFailure,
} from "../services/enrichmentErrorCodeClassifier";
import { titlesAgree } from "../services/enrichment";
import { hasRealMbid } from "../services/artistIdentity";
import type { Outcome } from "../utils/outcome";

/** The three kinds that failed to answer anything, as opposed to `Absent`. */
type FailureOutcome = Extract<
    Outcome<unknown>,
    { kind: "rateLimited" | "transient" | "permanent" }
>;
import { sourcePauseController } from "../services/sourcePauseController";
import { distributedLock } from "../utils/distributedLock";

// ── Per-track stage queue ────────────────────────

/**
 * The four questions this worker owes each track. `recording` ("which
 * recording is this?") answers the identity, `analysis` answers "has this file
 * been decoded and measured?", and `embedding` answers "has this track been
 * embedded?". `fingerprint` answers "what does this file sound like to
 * AcoustID?" — it is LOCAL (fpcalc) and has no prerequisite: the sweep covers
 * every track, because the dedupe column wants
 * the fingerprint whether or not any lookup matched. Each stage waits only for
 * what its PREREQUISITE_STAGE entry declares (recording waits for the
 * fingerprint question to be SETTLED; embedding waits for analysis's OUTPUT)
 * — never for the whole library, and never by polling a sibling at runtime.
 */
export type StageName = "recording" | "analysis" | "embedding" | "fingerprint";

export const STAGE_ORDER: readonly StageName[] = [
    "recording",
    "analysis",
    "embedding",
    "fingerprint",
] as const;

/**
 * How a stage waits on its prerequisite, per edge:
 *   - "output"  — the dependent stage READS the prerequisite's answer, so
 *     only a `done` answer unblocks it. A closed failure wrote no output;
 *     "the question is settled" is not "the output exists".
 *   - "settled" — the dependent stage only needs the question ANSWERED,
 *     either way: `done` (use the stored answer) or closed as a permanent
 *     failure (`failed`, `retryable = false`; skip the step and record the
 *     skip). A retryable failure or an open question is NOT settled.
 */
export type StageWaitKind = "output" | "settled";

export interface StagePrerequisite {
    stage: StageName;
    wait: StageWaitKind;
}

/**
 * Which stage must have answered before this one may be offered, and what
 * kind of waiting that is. The map states each stage's real data
 * dependencies — what the stage actually reads — which is NOT the order the
 * stages are listed in. This is the ONE place the engine models "wait for
 * another stage": a stage never polls or defers at runtime because a
 * sibling has not answered.
 */
export const PREREQUISITE_STAGE: Record<StageName, StagePrerequisite | null> = {
    // Reads file tags, then the name search, then AcoustID — and the
    // AcoustID step consumes the fingerprint stage's STORED answer. It
    // cannot be asked while the fingerprint question is open, and a
    // fingerprint stage closed as a permanent failure will never produce
    // one: either way the ANSWER (not an output) is what recording needs,
    // so on a closed failure the AcoustID step is skipped and the skip is
    // written into this stage's evidence.
    recording: { stage: "fingerprint", wait: "settled" },
    // Reads only the audio file (the Essentia analyzer decodes it itself).
    analysis: null,
    // Reads the Essentia valence/arousal that analysis wrote and blends them
    // into the CLAP embedding, so an unanalysed track cannot be embedded —
    // an analysis record closed as a failure wrote no valence/arousal, so
    // only a done answer unblocks this stage.
    embedding: { stage: "analysis", wait: "output" },
    // Reads only the audio file (fpcalc on the local binary).
    fingerprint: null,
};

/**
 * One producer per queue: each stage maps to exactly one queue, and only the
 * stage runner writes to it. Two producers on one queue is what let the same
 * work be created in two places with two different job keys. `fingerprint`
 * is the one stage with no queue at all: its producer executes the work
 * inline (fpcalc is a local subprocess owned by this process), so there is
 * no queue to name.
 */
export const STAGE_QUEUES: Record<StageName, string> = {
    recording: QUEUE_NAMES.TRACKS,
    // The analyzer consumes a plain Redis list, not a BullMQ queue.
    analysis: "audio:analysis:queue",
    embedding: QUEUE_NAMES.VIBE,
    fingerprint: "inline",
};

/** One unit of work: a track, the stage it owes, and how to key the attempt. */
export interface StageWork {
    trackId: string;
    stage: StageName;
    status: string;
    attempt: number;
    source: string | null;
    filePath: string | null;
    duration: number;
    title: string;
    /** Stable identity of the question: `track-<id>-<stage>`. */
    jobKey: string;
    /** Identity of THIS offer: `track-<id>-<stage>-<attempt>-r<redelivery>`. */
    jobId: string;
}

/** A record is due when the answer is missing, a retry's backoff elapsed, or
 * a claim's lease ran out (a `working` record whose `nextRetryAt` came round
 * is an attempt that died without answering). */
const DUE_STATUSES = ["pending", "failed"] as const;

/** How long a claim holds a record before the attempt is presumed dead. */
const STAGE_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Lease re-offers do not consume attempts; three of them close the
 * record instead of looping a poison file through the engine forever. */
const STAGE_REDELIVERY_CAP = 3;

/**
 * The next work owed, straight off `TrackStage`.
 *
 * One query per stage, each returning rows where the answer is missing or a
 * retry is due, gated on the stage's declared prerequisite (PREREQUISITE_STAGE,
 * if any) having answered for the same track — `done` for an "output" edge,
 * `done` or a closed failure for a "settled" one. It
 * deliberately does not filter on `Track.analysisStatus` / `Track.scanStatus`:
 * those columns are how the old code decided what to offer, which is what let
 * one failed track hold the whole library behind it. The record owns the
 * answer; a terminal answer (`failed`, not retryable) is simply not offered
 * again, and a `nextRetryAt` that has not elapsed is not due yet.
 */
export async function getNextWork(
    limit: number,
    stageFilter?: StageName,
): Promise<StageWork[]> {
    const now = new Date();
    const work: StageWork[] = [];

    for (const stage of STAGE_ORDER) {
        if (work.length >= limit) break;
        // A phase that owns one stage asks only for that stage, so a hot
        // earlier stage cannot starve it of its share of the limit.
        if (stageFilter && stage !== stageFilter) continue;

        // A paused source is not handed out work: while the pause holds,
        // every attempt would burn its timeout against a source that is
        // refusing us — the "1,047 attempt-3 failures" pattern this
        // replaces. The record waits; the cycle moves on. The fingerprint
        // stage's source is 'fpcalc' — the LOCAL binary — so a paused
        // 'acoustid' (the network lookup) never stops the fingerprint
        // sweep, and 'fpcalc' itself has no pause key to hit unless fpcalc
        // itself was rate-limited (it cannot be; nothing pauses it).
        const source =
            stage === "analysis"
                ? "analyzer"
                : stage === "embedding"
                  ? "clap"
                  : stage === "fingerprint"
                    ? "fpcalc"
                    : "musicbrainz";
        if (await sourcePauseController.isPaused(source, now)) {
            logger.debug(
                `[Enrichment] '${stage}' skipped: source '${source}' is paused`,
            );
            continue;
        }

    const prerequisite = PREREQUISITE_STAGE[stage];
        // A track with no record for this stage has never been asked — that is
        // "answer missing", so it is due. When there is a record, only a
        // pending or retryable-failed one is.
        const rows = await prisma.$queryRawUnsafe<
            Array<{
                trackId: string;
                status: string;
                attempt: number;
                source: string | null;
                filePath: string;
                duration: number;
                title: string;
            }>
        >(
            `SELECT t.id AS "trackId",
                    COALESCE(ts.status, 'pending')      AS status,
                    COALESCE(ts.attempt, 0)             AS attempt,
                    COALESCE(ts.source, $4)             AS source,
                    t."filePath",
                    t.duration,
                    t.title
               FROM "Track" t
               LEFT JOIN "TrackStage" ts
                        ON ts."trackId" = t.id AND ts.stage = $1
                WHERE (ts.id IS NULL
                       OR ((ts.status = ANY($2)
                            OR ts.status = 'working')
                           AND ts.retryable = true
                           AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= $3)))
                -- A track whose file the scan flagged missing has nothing to
                -- fingerprint, analyse or embed. Skipped, never failed: when
                -- the file returns the scan clears the flag and the question
                -- is simply due again.
                AND t."missingSince" IS NULL
                  -- Gating reads the prerequisite stage's RECORD, not a column:
                  -- a stage is offered only once its declared prerequisite
                  -- (PREREQUISITE_STAGE, usually none) has answered for the
                  -- same track — in the way the edge declares: an "output"
                  -- edge unblocks on 'done' only (the dependent stage reads
                  -- the answer's content), a "settled" edge unblocks on
                  -- 'done' OR on a closed failure ('failed' and not
                  -- retryable — the question will never answer differently
                  -- on its own). An unanalysed track is never embedded; a
                  -- track whose fingerprint question is open is never
                  -- recording-polled; every other stage is offered
                  -- regardless of its siblings.
                  AND ($5::text IS NULL
                     OR EXISTS (SELECT 1 FROM "TrackStage" prev
                                 WHERE prev."trackId" = t.id
                                   AND prev.stage = $5
                                   AND (prev.status = 'done'
                                        OR ($6::text = 'settled'
                                            AND prev.status = 'failed'
                                            AND prev.retryable = false))))
                ORDER BY t."fileModified" DESC
                LIMIT $7`,
            stage,
            [...DUE_STATUSES],
            now,
            source,
            prerequisite?.stage ?? null,
            prerequisite?.wait ?? null,
            limit - work.length,
        );

        for (const row of rows) {
            if (!row.filePath) continue;
            const jobKey = `track-${row.trackId}-${stage}`;
            work.push({
                trackId: row.trackId,
                stage,
                status: row.status,
                attempt: row.attempt,
                source: row.source,
                filePath: row.filePath,
                duration: row.duration,
                title: row.title,
                jobKey,
                // Per attempt, so a retry never reuses the key a failed job
                // still holds.
                jobId: `${jobKey}-${row.attempt + 1}`,
            });
        }
    }

    return work;
}

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
// Idle backoff. The cycle is cheap only when it finds work; when there is none
// it still pays for the progress queries, which include a full scan of Track.
// A library that is fully enriched -- the steady state -- was paying that every
// 5 seconds forever against the pool that also serves audio streaming.
const ENRICHMENT_IDLE_INTERVAL_MS = 60 * 1000;
// Backoff window for a failed enrichment job. A failed job keeps its jobId
// marker, and the phases skip an entity whose jobId is still held (getJob
// check), so a failure backs off until this grace elapses and the failed job
// is cleaned -- then the slot is free and the entity retries. Without the grace
// a failure would retry every 5s cycle; without the getJob skip it would park
// out of selection until restart. Completed jobs are cleaned with grace 0 -- a
// success should be immediately re-queueable if the entity is legitimately reset.
const FAILED_JOB_RETRY_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Guards the enrichment cycle itself: every shipped shape
 * runs one backend, but a manual second process or a misconfigured compose
 * must not double-dispatch the same stage records. The TTL outlives the
 * worst real cycle so a crash leaves the lock to expiry, not a wedge.
 */
const CYCLE_LOCK_KEY = "enrichment:cycle";
const CYCLE_LOCK_TTL_MS = 4 * 60 * 60 * 1000; // 4 h, past the 2.5 h full-library bar

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
// Whether the worker has been explicitly stopped. Distinct from "no timer pending": while a
// cycle is executing there is no pending timer either, and the two must not be confused --
// treating a running cycle as a stopped worker is what allowed a second timer chain to be
// armed alongside the one the cycle was about to arm itself.
let enrichmentStopped = false;
let redis: Redis | null = null;
let controlSubscriber: Redis | null = null;
let isPaused = false;
let isStopping = false;
let userStopped = false; // True after explicit stop; prevents auto-restart via timer
let userStoppedWarned = false; // Throttle warning log to once per stop
let immediateEnrichmentRequested = false;
let activeEnrichmentWorkers: BullWorker[] = [];
let lastRunTime = 0;
const MIN_INTERVAL_MS = 10000; // Minimum 10s between cycles

const AUDIO_ANALYSIS_CONTROL_CHANNEL = "audio:analysis:control";

// Timestamp for once-per-hour orphaned failure record cleanup
let lastOrphanedFailuresCleanup: Date | null = null;

// Timestamp for once-per-day resolved failure record cleanup (>30 days old)
let lastResolvedCleanup: Date | null = null;

/**
 * Resume the real infrastructure the analyzer actually runs on: the
 * BullMQ workers, the vibe queuing bridge, the synchronous Python gate,
 * and the pub/sub resume signal. It deliberately does NOT touch the
 * isPaused/isStopping/userStopped local flags, so it can be called from
 * the cycle's own reverse-sync and from hang recovery without resetting
 * a user's explicit stop.
 */
async function resumeInfrastructure(): Promise<void> {
    await Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
    resumeVibeQueuing();
    // Clear synchronous gate BEFORE pub/sub resume -- Python sees "open" immediately
    await enrichmentStateService.clearGate();
    // Resume the Python audio analyzer in case it was paused by a prior stop
    try {
        await enrichmentStateService.publishToChannel(AUDIO_ANALYSIS_CONTROL_CHANNEL, "resume");
    } catch (err) {
        logger.warn(`[Enrichment] Failed to resume audio analyzer: ${(err as Error).message}`);
    }
}

/**
 * Timeout wrapper to prevent operations from hanging indefinitely
 * If an operation takes longer than the timeout, it will fail and move to the next item
 */

/**
 * One timeout per stage, sized to that stage's real work
 * (replaces the single duration-derived
 * `computeTrackEnrichmentTimeoutMs` that applied one budget to every
 * stage).
 *
 * The stage's work — not the track's length — decides the budget:
 *   - `recording` is identification: file tags, at most two MusicBrainz
 *     HTTP lookups, and an AcoustID question asked with the fingerprint
 *     stage's stored answer (no fpcalc runs in this stage). A network
 *     budget; track duration is irrelevant to it.
 *   - `analysis` decodes the first 90 seconds of the file
 *     and runs the Essentia chain; the analyzer's own
 *     DECODE_TIMEOUT is 120s, so 300s covers the window with the design's
 *     "plus two minutes" headroom to spare.
 *   - `embedding` runs CLAP over that same 90s window — smaller than the
 *     full analysis budget, larger than a pure network call.
 *   - `fingerprint` runs fpcalc over the whole file; the subprocess is
 *     bounded by fpcalcService's own timeout, so 30s bounds the record's
 *     patience at the same figure.
 *
 * These bound the RECORD's patience too: a `working` record older than
 * its stage's timeout is a dead attempt and gets re-queued (a timeout
 * does not count as an attempt).
 */
export const STAGE_TIMEOUT_MS: Record<StageName, number> = {
    recording: 30_000,
    analysis: 300_000,
    embedding: 120_000,
    fingerprint: 30_000,
};

/** The timeout for one stage's real work — no shared budget anywhere. */
export function getStageTimeoutMs(stage: StageName): number {
    return STAGE_TIMEOUT_MS[stage];
}

/**
 * Dispatches allowed before a stage's record closes as terminal: one
 * initial ask plus three retries. The queue's own
 * `DEFAULT_JOB_OPTIONS.attempts` counts retries inside one job; this
 * counts whole dispatches and is what closes a permanently failing
 * question.
 */
export const STAGE_RETRY_CAP = 4;

/**
 * Increasing waits before retries 1, 2 and 3: 1 min, 10 min, 1 h — then
 * the record closes. The record's `nextRetryAt` is set from this, so a
 * source that is briefly down is retried on a widening schedule and a
 * persistent refusal eventually stops being asked. A 30s/60s/120s ladder
 * closes a question about 3.5 minutes into an outage — shorter than any
 * real outage.
 */
const RETRY_LADDER_MS = [60_000, 600_000, 3_600_000];

export function computeStageRetryWaitMs(attempt: number): number {
    return RETRY_LADDER_MS[Math.min(Math.max(1, attempt), 3) - 1];
}

/**
 * Write the answer to a track's stage record: the question is answered
 * `done` by `source` with `evidence` explaining how it was reached.
 * Idempotent — re-answering a `done` record just refreshes the truth.
 */
export async function recordStageSuccess(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable,
             "nextRetryAt", evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, $3, 'done', $4, 1, true, NULL, $5::jsonb, now(), now())
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = 'done',
                source = EXCLUDED.source,
                "lastErrorCode" = NULL,
                "lastErrorMessage" = NULL,
                "failureClass" = NULL,
                retryable = true,
                "nextRetryAt" = NULL,
                evidence = EXCLUDED.evidence,
                "finishedAt" = now()
          WHERE "TrackStage".status <> 'blocked'`,
        `${trackId}__${stage}`,
        trackId,
        stage,
        source,
        JSON.stringify(evidence ?? { reason: "answered" }),
    );
}

/**
 * Record a failed attempt against a track's stage record.
 *
 * Two paths, per the design's "Running the engine" rules:
 *   - A rate limit is NOT a failure: the source gets paused (only it),
 *     the record goes back to `pending` with `nextRetryAt` at the pause
 *     deadline, and the attempt count does NOT move.
 *   - Any other error writes `failed` with its class — an
 *     unclassifiable error stays INCONCLUSIVE with its raw evidence
 *     (never a generic "Work" code) and a retry due at
 *     `now + computeStageRetryWaitMs(attempt)`. At the cap
 *     (`STAGE_RETRY_CAP`) the record closes: `retryable = false`,
 *     `nextRetryAt = null`, never offered again until a human re-decides.
 *
 * A record already closed (`failed`, not retryable) is never resurrected.
 */
export async function recordStageFailure(
    trackId: string,
    stage: StageName,
    source: string,
    err: unknown,
    evidence?: Record<string, unknown>,
): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (await sourcePauseController.handleRateLimit(source, err, evidence)) {
        // Source-caused, not work-caused: park the question until the
        // pause lifts without consuming an attempt.
        const pause = await sourcePauseController.getPause(source);
        const until = pause?.until ?? new Date(Date.now() + sourcePauseController.windowMs);

        // A question still waiting 24 h after it first parked gets ONE
        // alert — "waiting on <source>" — and stays pending regardless.
        // The `waitingSince`/`waitingAlerted` markers live in the record's
        // own evidence, so one wait raises one alert even across restarts.
        const [existing] = await prisma.$queryRawUnsafe<
            Array<{ evidence: Record<string, unknown> | null }>
        >(
            `SELECT evidence FROM "TrackStage"
              WHERE "trackId" = $1 AND stage = $2`,
            trackId,
            stage,
        );
        const prev = existing?.evidence ?? {};
        const waitingSince =
            typeof prev.waitingSince === "string"
                ? prev.waitingSince
                : new Date().toISOString();
        const waitEvidence: Record<string, unknown> = {
            ...prev,
            reason: "rate-limited",
            error: message,
            waitingSince,
            ...evidence,
        };
        if (
            Date.now() - new Date(waitingSince).getTime() >= 24 * 60 * 60_000 &&
            waitEvidence.waitingAlerted !== true
        ) {
            waitEvidence.waitingAlerted = true;
            const admin = await prisma.user.findFirst({
                where: { role: "admin" },
                select: { id: true },
            });
            if (admin) {
                const { notificationService } = await import("../services/notificationService");
                await notificationService
                    .create({
                        userId: admin.id,
                        type: "system",
                        title: `Enrichment waiting on ${source}`,
                        message: `${stage} for ${trackId} has been waiting on ${source} for over 24 h; the record stays pending until the pause lifts.`,
                    })
                    .catch(() => undefined);
            }
        }

        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable,
                 "nextRetryAt", "lastErrorCode", "lastErrorMessage", evidence)
             VALUES ($1, $2, $3, 'pending', $4, 0, true, $5, 'RATE_LIMITED', $6, $7::jsonb)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'pending',
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    "lastErrorCode" = 'RATE_LIMITED',
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    evidence = EXCLUDED.evidence
              WHERE ("TrackStage".status <> 'failed'
                     OR "TrackStage".retryable = true)
                AND "TrackStage".status <> 'blocked'`,
            `${trackId}__${stage}`,
            trackId,
            stage,
            source,
            until,
            message,
            JSON.stringify(waitEvidence),
        );
        return;
    }

    const failureClass = classifyFailure(err);
    const rows = await prisma.$queryRawUnsafe<
        Array<{ attempt: number; retryable: boolean; status: string }>
    >(
        `SELECT attempt, retryable, status FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    const current = rows[0];
    if (current && (current.status === "blocked" || (current.status === "failed" && !current.retryable))) return;

    // A `working` record is already in its `attempt`-th dispatch — the
    // claim counted it — so this failure IS that attempt and the count
    // stays. Anything else (never dispatched, or a re-failure arriving off
    // the claim path) moves to the next attempt. Floor of 1: a seeded
    // `working` at attempt 0 still gets its first failure recorded.
    // Terminal classes (DAMAGED / UNSUPPORTED / MULTICANNEL) close the
    // record immediately; INCONCLUSIVE stays retryable until the cap.
    const attempt =
        current?.status === "working"
            ? Math.max(current.attempt, 1)
            : (current?.attempt ?? 0) + 1;
    const retryable = failureClass === "INCONCLUSIVE" && attempt < STAGE_RETRY_CAP;
    const nextRetryAt = retryable
        ? new Date(Date.now() + computeStageRetryWaitMs(attempt))
        : null;

    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt,
             "lastErrorCode", "lastErrorMessage", "failureClass",
             retryable, "nextRetryAt", evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now(), now())
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = 'failed',
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence,
                "finishedAt" = now()`,
        `${trackId}__${stage}`,
        trackId,
        stage,
        source,
        attempt,
        failureClass,
        message,
        failureClass,
        retryable,
        nextRetryAt,
        JSON.stringify({ error: message, ...evidence }),
    );
}

/**
 * Record a genuine "the sources have nothing" answer: the question is
 * answered — `done`, no failure class, evidence naming what was asked.
 * A record that keeps going to `failed` over a correct "no" wastes the
 * retry ladder and never closes anything.
 */
export async function recordStageAbsent(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable,
             "nextRetryAt", evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, $3, 'done', $4, 1, true, NULL, $5::jsonb, now(), now())
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = 'done',
                source = EXCLUDED.source,
                "lastErrorCode" = NULL,
                "lastErrorMessage" = NULL,
                "failureClass" = NULL,
                retryable = true,
                "nextRetryAt" = NULL,
                evidence = EXCLUDED.evidence,
                "finishedAt" = now()
          WHERE "TrackStage".status <> 'blocked'`,
        `${trackId}__${stage}`,
        trackId,
        stage,
        source,
        JSON.stringify(evidence ?? { reason: "sources have nothing" }),
    );
}

/**
 * A closed dependency never leaves a pending orphan:
 * when the analysis record for a track has closed — retry cap reached or
 * permanent failure — the embedding built from its answer can never be
 * produced, so the embedding record closes too, with evidence naming the
 * analysis closure. Runs at the top of every cycle; idempotent, and it
 * never touches `blocked` records (a human decision outlives any machine
 * path, S10) or records already closed on their own.
 */
export async function closeOrphanedDependents(): Promise<void> {
    for (const [dependent, prerequisite] of Object.entries(PREREQUISITE_STAGE)) {
        if (!prerequisite) continue;
        // The dependent stage's own source, so the closed record reads
        // like every other record this map produces.
        const source =
            dependent === "analysis"
                ? "analyzer"
                : dependent === "embedding"
                  ? "clap"
                  : dependent === "fingerprint"
                    ? "fpcalc"
                    : "musicbrainz";
        const closed = await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" dep
                SET status = 'failed',
                    source = $2,
                    retryable = false,
                    "nextRetryAt" = NULL,
                    "failureClass" = 'DEPENDENCY_CLOSED',
                    "lastErrorCode" = 'DEPENDENCY_CLOSED',
                    "lastErrorMessage" = 'dependency ' || $3 || ' closed; this question can never be answered',
                    evidence = jsonb_build_object(
                        'reason',
                        'dependency ' || $3 || ' closed: '
                            || COALESCE(pre."failureClass", 'unknown'),
                        'closure', 'dependency-closed'
                    )
               FROM "TrackStage" pre
              WHERE dep."trackId" = pre."trackId"
                AND dep.stage = $1
                AND pre.stage = $3
                AND pre.status = 'failed'
                AND pre.retryable = false
                AND dep.status = 'pending'
                AND dep.retryable = true`,
            dependent,
            source,
            prerequisite.stage,
        );
        if (closed > 0) {
            logger.debug(
                `[Enrichment] Closed ${closed} '${dependent}' record(s) whose '${prerequisite.stage}' dependency is closed`,
            );
        }
    }
}

/**
 * Record the question against the outcome of an external call, per its
 * `Outcome` kind:
 *  - rateLimited: park until the call's `retryAfter` with no attempt
 *    consumed (the service already paused the source);
 *  - permanent: close with the given code — asking again changes nothing;
 *  - transient: hand the real error to `recordStageFailure`, so the retry
 *    ladder applies.
 * `answered`/`absent` are answers, not failures — the caller decides what
 * the question means.
 */
async function recordOutcomeFailure(
    trackId: string,
    stage: StageName,
    source: string,
    outcome: FailureOutcome,
    evidence?: Record<string, unknown>,
): Promise<void> {
    if (outcome.kind === "rateLimited") {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable,
                 "nextRetryAt", "lastErrorCode", "lastErrorMessage", evidence)
             VALUES ($1, $2, $3, 'pending', $4, 0, true, $5, 'RATE_LIMITED', $6, $7::jsonb)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'pending',
                    source = EXCLUDED.source,
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    "lastErrorCode" = 'RATE_LIMITED',
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    evidence = EXCLUDED.evidence
              WHERE ("TrackStage".status <> 'failed'
                     OR "TrackStage".retryable = true)
                AND "TrackStage".status <> 'blocked'`,
            `${trackId}__${stage}`,
            trackId,
            stage,
            source,
            outcome.retryAfter,
            `source '${source}' is paused until ${outcome.retryAfter.toISOString()}`,
            JSON.stringify(outcome.evidence),
        );
        return;
    }
    if (outcome.kind === "permanent") {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ attempt: number; retryable: boolean; status: string }>
        >(
            `SELECT attempt, retryable, status FROM "TrackStage"
              WHERE "trackId" = $1 AND stage = $2`,
            trackId,
            stage,
        );
        const current = rows[0];
        if (current && (current.status === "blocked" || (current.status === "failed" && !current.retryable))) return;
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt,
                 "lastErrorCode", "lastErrorMessage", "failureClass",
                 retryable, "nextRetryAt", evidence, "startedAt", "finishedAt")
             VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, 'PERMANENT',
                     false, NULL, $8::jsonb, now(), now())
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'failed',
                    source = EXCLUDED.source,
                    "lastErrorCode" = EXCLUDED."lastErrorCode",
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    "failureClass" = 'PERMANENT',
                    retryable = false,
                    "nextRetryAt" = NULL,
                    evidence = EXCLUDED.evidence,
                    "finishedAt" = now()`,
            `${trackId}__${stage}`,
            trackId,
            stage,
            source,
            current?.attempt ?? 0,
            outcome.error.code,
            outcome.error.message,
            JSON.stringify({ reason: outcome.error.message, ...evidence }),
        );
        return;
    }
    await recordStageFailure(
        trackId,
        stage,
        source,
        Object.assign(new Error(outcome.error.message), {
            code: outcome.error.code,
        }),
        { kind: "transient", ...evidence },
    );
}

/**
 * Ask a source within the stage budget. A blown budget — or any throw
 * from the call — is a failure to answer, not "the source has nothing":
 * it reaches the caller as `transient` with the real cause.
 */
async function askWithinBudget<T>(
    ask: () => Promise<Outcome<T>>,
    timeoutMs: number,
    label: string,
): Promise<Outcome<T>> {
    try {
        return await withTimeout(ask(), timeoutMs, label);
    } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            kind: "transient",
            error: {
                code: message === label ? "TIMEOUT" : "REQUEST_FAILED",
                message,
            },
        };
    }
}

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/**
 * Setup subscription to enrichment control channel
 */
async function setupControlChannel() {
    if (!controlSubscriber) {
        controlSubscriber = new Redis(config.redisUrl);
        await controlSubscriber.subscribe("enrichment:control");

        controlSubscriber.on("message", (channel, message) => {
            if (channel === "enrichment:control") {
                logger.debug(
                    `[Enrichment] Received control message: ${message}`,
                );

                if (message === "pause") {
                    isPaused = true;
                    logger.debug("[Enrichment] Paused");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                    haltVibeQueuing();
                } else if (message === "resume") {
                    isPaused = false;
                    logger.debug("[Enrichment] Resumed");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
                    resumeVibeQueuing();
                } else if (message === "stop") {
                    isStopping = true;
                    isPaused = true;
                    logger.debug(
                        "[Enrichment] Stopping gracefully - completing current item...",
                    );
                    // Pause all BullMQ workers + halt vibe queuing
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                    haltVibeQueuing();
                    // DO NOT kill the CLAP analyzer — it has its own idle timeout (MODEL_IDLE_TIMEOUT=300s)
                    // and will unload the model when the vibe queue is empty. Killing it caused
                    // permanent death because supervisor's autorestart didn't revive clean exits.
                }
            }
        });

        logger.debug("[Enrichment] Subscribed to control channel");
    }
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    // Clear the stop latch, or a restart within the same process arms one cycle and then
    // never reschedules.
    enrichmentStopped = false;
    logger.debug("\n=== Starting Unified Enrichment Worker ===");
    logger.debug(`   Artist batch: ${ARTIST_BATCH_SIZE}`);
    logger.debug(`   Track batch: ${TRACK_BATCH_SIZE}`);
    logger.debug(`   Interval: ${ENRICHMENT_INTERVAL_MS / 1000}s`);
    logger.debug("");

     // No crash-recovery sweep here any more. This used to reset every
     // `processing`/`queued` row back to `pending` on startup and flush
     // `audio:analysis:queue` to match. That was a workaround for having no
     // per-track record of the attempt: with `TrackStage` the attempt lives in
     // the record, so a job that died mid-flight is a `working` record whose
     // `nextRetryAt` comes round on its own, and a restart neither invents a
     // second attempt nor throws away work still sitting in the list.

     // A restart must not undo an operator's pause: if the
     // stored state says `paused`, honour it — the timer stays armed and
     // every cycle declines until an operator resumes or the state says
     // otherwise. Everything else (`running` left by a dead process,
     // `stopping` from a shutdown that never finished) is crash residue,
     // not an operator instruction, so it starts fresh.
     const existingState = await enrichmentStateService.getState();
     const honoringPause = existingState?.status === "paused";

     if (honoringPause) {
         isPaused = true;
         userStopped = false;
         isStopping = false;
         logger.warn(
             "[Enrichment] Honouring the persisted pause — " +
                 "use Resume on the Enrichment page to lift it",
         );
     } else {
         isPaused = false;
         isStopping = false;
         userStopped = false;
         if (existingState && existingState.status !== "idle") {
             await enrichmentStateService.clear();
         }
         // Initialize state
         await enrichmentStateService.initializeState();
     }

    // Start BullMQ Workers (artist, track, podcast)
    activeEnrichmentWorkers = await Promise.all([
        startArtistEnrichmentWorker(),
        startTrackEnrichmentWorker(),
        startPodcastEnrichmentWorker(),
    ]);

    if (honoringPause) {
        // Honour the pause to the end: workers must not consume while
        // paused, and the analysis gate must be re-armed `paused` even
        // if the key was lost — otherwise queued work drains through
        // the operator's instruction while the scheduler politely
        // declines to dispatch anything new.
        haltVibeQueuing();
        await enrichmentStateService.holdGateClosed();
        await Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(
            () => {},
        );
    } else {
        // CRITICAL (prod hang root cause): a stale synchronous gate
        // from a PREVIOUS process's stop() survives in Redis across
        // restarts -- stop() sets audio:analysis:gate="paused" and
        // nothing at startup ever cleared it. The fresh worker then
        // claims status="running" while the Python analyzer stays gated
        // forever: counters frozen, heartbeat fresh (the cycle keeps
        // writing lastActivity), the hang detector structurally blind.
        // Resume the real infrastructure -- clear the gate, resume
        // workers, wake the analyzer -- BEFORE claiming running, exactly
        // as an explicit resume would.
        await resumeInfrastructure();
    }

    // Start audio completion subscriber (Essentia → vibe queue bridge)
    startAudioCompletionSubscriber();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycle(false);

    // Self-rescheduling: schedule next cycle after current one completes
    scheduleNextEnrichmentCycle();
}

/**
 * Schedule the next enrichment cycle after the current one completes.
 * Replaces setInterval to prevent pile-up when cycles exceed ENRICHMENT_INTERVAL_MS.
 */
function scheduleNextEnrichmentCycle(delayMs: number = ENRICHMENT_INTERVAL_MS) {
    enrichmentInterval = setTimeout(async () => {
        // Drop the handle immediately. Once this callback is running the timer has already
        // fired and the handle is spent -- but it is still non-null, and anything that
        // tests "is a timer pending?" would believe one is and try to replace it. Clearing
        // a spent handle does nothing, so that caller's replacement timer survives
        // alongside the one this callback arms in its finally: two chains where there
        // should be one. See bumpScheduleToFastInterval.
        enrichmentInterval = null;
        let didWork = false;
        // How long to wait before the next cycle. Set here and used by the single
        // scheduling call in the finally block, because scheduling from more than one
        // place spawns parallel timer chains -- see the note there.
        let nextDelayMs: number | null = null;
        // The reschedule MUST be in a finally. Without it, a single rejection
        // from runEnrichmentCycle (a Redis reconnect, a DB failover) skips the
        // next-schedule call and the enrichment chain is dead for the lifetime
        // of the process, silently -- the only trace is one unhandledRejection
        // log line.
        try {
            const result = await runEnrichmentCycle(false);

            // A cycle that declined to run has learned nothing about whether there is
            // work, so backing off for a minute on the strength of it is wrong. Come back
            // as soon as the floor allows.
            //
            // This is not hypothetical. The busy interval is 5s and the floor is 10s, so
            // EVERY productive cycle armed a 5s timer whose tick was then refused for
            // being early, reported "nothing happened", and re-armed at 60s. The real
            // cadence with work outstanding was 65 seconds. Measured cost while embedding
            // 59 tracks: 50 seconds of actual work spread over ten minutes, with the
            // embedder sitting idle through gaps of 216s and 350s -- long enough that it
            // also unloaded its model and paid to load it again.
            if (result.declined) {
                const waitedFor = Date.now() - lastRunTime;
                const untilAllowed = Math.max(0, MIN_INTERVAL_MS - waitedFor);
                nextDelayMs = Math.max(untilAllowed, ENRICHMENT_INTERVAL_MS);
                return;
            }

            // Every phase that queued something counts. Scan and vibe were left out, so a
            // cycle whose only achievement was handing the embedder a hundred tracks
            // reported itself as idle and slept for a minute.
            didWork =
                result.artists > 0 ||
                result.tracks > 0 ||
                result.audioQueued > 0 ||
                (result.vibeQueued ?? 0) > 0 ||
                (result.fingerprintsQueued ?? 0) > 0;
        } catch (error) {
            // Treat a failure as "work pending" so the retry is prompt rather
            // than backed off for a minute.
            didWork = true;
            logger.error(
                "[Enrichment] Cycle failed; continuing with the next cycle:",
                error instanceof Error ? error.message : String(error)
            );
        } finally {
            // EXACTLY ONE scheduling call, and it lives here.
            //
            // A `return` inside the try above still runs this block, so scheduling from
            // both places does not replace the timer -- it starts a second chain. Each
            // declined cycle would then double the number of chains, and since a declined
            // cycle is the common case while work is outstanding, the process fills with
            // timers until it dies. That is not theoretical: it took the test server from
            // 181MB to 886MB in about a minute and then out of memory entirely.
            //
            // The reschedule must also stay in a finally. Without it, a single rejection
            // from runEnrichmentCycle (a Redis reconnect, a DB failover) skips the
            // next-schedule call and the enrichment chain is dead for the lifetime of the
            // process, silently -- the only trace is one unhandledRejection log line.
            //
            // stopUnifiedEnrichmentWorker() nulls this out; don't resurrect the chain
            // after an explicit stop.
            // The handle was nulled at the top of this callback, so it can no longer stand
            // in for "the worker is still running". stopUnifiedEnrichmentWorker sets
            // workerStopped, which is what actually means "do not resurrect the chain".
            if (!enrichmentStopped) {
                scheduleNextEnrichmentCycle(
                    nextDelayMs ??
                        (didWork
                            ? ENRICHMENT_INTERVAL_MS
                            : ENRICHMENT_IDLE_INTERVAL_MS)
                );
            }
        }
    }, delayMs);
}

/**
 * Pull the next scheduled cycle forward to the fast interval.
 *
 * The trigger paths call runEnrichmentCycle directly, so a user-initiated run is
 * never blocked by the idle backoff. But the timer that was already pending is
 * still on the idle delay, so the FOLLOW-UP cycle would be a minute away just as
 * work starts flowing. Reset it.
 */
function bumpScheduleToFastInterval(): void {
    // No pending timer means either the worker is stopped or a cycle is running right now.
    // In the second case the cycle's own finally is about to arm the next one, and arming
    // another here would leave both alive forever -- one leaked chain per overlapping
    // trigger, each polling Redis on its own five-second beat. Scan completions call this
    // without awaiting, so overlapping is the common case, not the edge case.
    if (enrichmentInterval === null) return;
    clearTimeout(enrichmentInterval);
    enrichmentInterval = null;
    scheduleNextEnrichmentCycle(ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export async function stopUnifiedEnrichmentWorker() {
    enrichmentStopped = true;
    if (enrichmentInterval) {
        clearTimeout(enrichmentInterval);
        enrichmentInterval = null;
    }
    logger.debug("[Enrichment] Worker stopped");
    if (redis) {
        redis.disconnect();
        redis = null;
    }
    if (controlSubscriber) {
        controlSubscriber.disconnect();
        controlSubscriber = null;
    }

    // Close BullMQ Workers, audio subscriber, and Queues
    await Promise.all(activeEnrichmentWorkers.map((w) => w.close())).catch(() => {});
    activeEnrichmentWorkers = [];
    await stopAudioCompletionSubscriber().catch(() => {});
    await closeEnrichmentQueues().catch(() => {});

    // Mark as stopped in state
    await enrichmentStateService
        .updateState({
            status: "idle",
            currentPhase: null,
        })
        .catch((err) =>
            logger.error("[Enrichment] Failed to update state:", err),
        );
}

/**
 * Where a claimed attempt for each stage is handed to its queue.
 *
 * Declared once so the phase functions and the "Retry failed and blocked"
 * control both dispatch through the same producer. Two producers on one queue
 * is what let the same work be created in two places with two different job
 * keys — see the note on STAGE_QUEUES.
 */
const STAGE_PRODUCERS: Record<StageName, (item: StageWork) => Promise<void>> = {
    recording: async (item) => {
        await trackQueue.add(
            "enrich",
            { trackId: item.trackId, trackTitle: item.title },
            // Per-attempt jobId: a retry never reuses the key a failed job
            // still holds.
            { jobId: item.jobId },
        );
    },
    analysis: async (item) => {
        // The analyzer consumes a plain Redis list, not a BullMQ queue.
        await getRedis().rpush(
            STAGE_QUEUES.analysis,
            JSON.stringify({
                trackId: item.trackId,
                filePath: item.filePath,
                duration: item.duration, // Avoids file read in the analyzer
                jobId: item.jobId,       // Per-attempt key; the analyzer logs it
            }),
        );
    },
    embedding: async (item) => {
        await vibeQueue.add(
            "embed",
            { trackId: item.trackId, filePath: item.filePath, duration: item.duration },
            { jobId: item.jobId },
        );
    },
    fingerprint: async (item) => {
        // Handed to the fingerprint pool (see runFingerprintInPool): local
        // fpcalc at machine concurrency, per-call stage timeout, and the
        // dispatch loop returns immediately so the other stages — and the
        // cycle — are never gated behind the sweep. dispatchStageWork still
        // owns the claim; runFingerprintStageWork owns the answer.
        runFingerprintInPool(item);
    },
};

/**
 * Answer one claimed fingerprint question: run fpcalc on the file — LOCAL,
 * no network, so no source pause can apply — and persist the fingerprint
 * via `persistAcoustidFingerprint` whether or not any AcoustID lookup will
 * ever match (the sweep covers every track;
 * the dedupe column wants the fingerprint regardless of identity outcome).
 *
 * This is the stage that finally covers the ~7,264 ISRC tracks the old
 * `enrichSingleTrack` path skipped: fingerprinting here is unconditional,
 * identity is the recording stage's business.
 *
 * Failure handling is the same contract the recording job uses:
 * `recordStageFailure` classifies the error onto the record — an ordinary
 * fpcalc failure stays retryable INCONCLUSIVE with widening backoff until
 * the retry cap closes it; the record is never silently skipped and never
 * parked as done. The source is 'fpcalc' (the local binary), so neither a
 * paused 'acoustid' network source nor a MusicBrainz pause can gate this
 * work. A track that already carries its stored fingerprint (a previous
 * attempt persisted but died before settling, or the recording stage
 * stored it) is answered from the stored value — fetched once, never
 * recomputed, never overwritten with nothing.
 */
async function runFingerprintStageWork(item: StageWork): Promise<void> {
    try {
        const track = await prisma.track.findUnique({
            where: { id: item.trackId },
            select: { acoustidFingerprint: true },
        });
        if (!track) {
            throw new Error(`ENTITY_NOT_FOUND: Track ${item.trackId} deleted`);
        }

        if (track.acoustidFingerprint) {
            await recordStageSuccess(item.trackId, "fingerprint", "fpcalc", {
                reason: "fingerprint already stored",
                characters: track.acoustidFingerprint.length,
            });
            return;
        }

        if (!item.filePath) {
            throw new Error(
                `Track ${item.trackId} has no file path to fingerprint`,
            );
        }
        const absolutePath = resolveTrackFilePath(item.filePath);
        if (!absolutePath) {
            throw new Error(
                `Track ${item.trackId} path escapes the music folder: ${item.filePath}`,
            );
        }

        // Throws FpcalcFailure on a real failure — the error carries fpcalc's
        // exit code and stderr, so classifyFailure below sees the true reason.
        const fingerprint = await fpcalcService.fingerprintFile(absolutePath);

        await persistAcoustidFingerprint(item.trackId, fingerprint.fingerprint);
        await recordStageSuccess(item.trackId, "fingerprint", "fpcalc", {
            characters: fingerprint.fingerprint.length,
            duration: fingerprint.duration,
        });
    } catch (err) {
        logger.debug(
            `[Enrichment] Fingerprint failed for ${item.trackId}: ${(err as Error).message}`,
        );
        await recordStageFailure(item.trackId, "fingerprint", "fpcalc", err, {
            paths: ["fpcalc"],
        });
    }
}

/**
 * The fingerprint stage's own worker loop.
 *
 * fpcalc is a local subprocess owned by this process, so no queue round-trip
 * is paid — but the stage must never run ONE subprocess at a time inside the
 * dispatch loop, never gate the other stages' dispatch (or the cycle) behind
 * a full-library sweep, and never let one hung fpcalc stall anything. This
 * pool takes each claimed item, runs up to `os.availableParallelism()`
 * subprocesses at once, and bounds EVERY call with the stage's own timeout
 * (getStageTimeoutMs('fingerprint')): a hung run rejects, and the rejection
 * is recorded through recordStageFailure like any other fingerprint failure —
 * classified, retryable, asked again after the backoff. The producer returns
 * immediately; the answers land on the records on the pool's own schedule.
 */
const FINGERPRINT_CONCURRENCY = Math.max(1, os.availableParallelism());

class FingerprintPool {
    private active = 0;
    private waiting: Array<() => void> = [];

    async run<T>(task: () => Promise<T>): Promise<T> {
        while (this.active >= FINGERPRINT_CONCURRENCY) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
const fingerprintPool = new FingerprintPool();
const fingerprintWork = new Set<Promise<void>>();

function runFingerprintInPool(item: StageWork): void {
    const run = fingerprintPool
        .run(() =>
            withTimeout(
                runFingerprintStageWork(item),
                getStageTimeoutMs("fingerprint"),
                `Timeout fingerprinting ${item.filePath ?? item.trackId}`,
            ),
        )
        .catch((err: unknown) => {
            // The per-call budget expired (or the pool itself broke):
            // record it as the classified failure it is — never a silent
            // drop, never an unhandled rejection.
            logger.warn(
                `[Enrichment] Fingerprint work for ${item.trackId} did not finish: ${(err as Error).message}`,
            );
            return recordStageFailure(
                item.trackId,
                "fingerprint",
                "fpcalc",
                err,
                { paths: ["fpcalc"], timedOut: true },
            );
        })
        .finally(() => {
            fingerprintWork.delete(run);
        });
    fingerprintWork.add(run);
}

/**
 * Resolves when every fingerprint run handed to the pool has settled (done,
 * failed, or timed out). Observability/test hook — the engine itself never
 * waits on the sweep.
 */
export async function waitForFingerprintWork(): Promise<void> {
    while (fingerprintWork.size > 0) {
        await Promise.allSettled([...fingerprintWork]);
    }
}

/**
 * The fingerprint phase: answer every track's local fingerprint question.
 * Its stage filter keeps a hot recording/analysis/embedding stage from
 * starving the sweep of its share of the batch limit.
 */
export async function executeFingerprintPhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    // No fpcalc binary: the questions stay pending — owed, not failed.
    // Installing chromaprint is what answers them; nothing is made up and
    // nothing is marked done that was not measured.
    if (!features.fpcalc) return 0;

    const work = await getNextWork(TRACK_BATCH_SIZE, "fingerprint");
    // The pool, not the raw worker: the dispatch loop hands out claims and
    // returns; the subprocesses run on their own schedule at machine
    // concurrency, bounded per call by the stage's own timeout.
    return dispatchStageWork("fingerprint", work, async (item) => {
        runFingerprintInPool(item);
    });
}

/**
 * Re-open the recording stages whose evidence shows they answered a no-match
 * WITHOUT ever asking AcoustID — the fingerprint stage was settled as a
 * permanent failure when they ran, so the AcoustID step was skipped and the
 * skip recorded in the evidence (see `enrichSingleTrack`). Whenever a control
 * re-opens or re-asks the fingerprint stage, a NEW fingerprint may land, so
 * those no-matches are no longer honest answers: they never got to ask the
 * question the new fingerprint answers.
 *
 * The evidence marker — not the mere absence of an MBID — is what selects a
 * row: a no-match that DID run AcoustID (the fingerprint existed, the lookup
 * missed) stays closed. The attempt is deliberately left alone: the re-open
 * buys exactly one more ask with the new fingerprint; if that misses again
 * the record closes terminal again.
 */
async function reopenRecordingsThatNeverAskedAcoustid(): Promise<number> {
    const reopened = await prisma.$executeRawUnsafe(
        `UPDATE "TrackStage" ts
            SET status = 'pending',
                retryable = true,
                "nextRetryAt" = NULL,
                "startedAt" = NULL
          WHERE ts.stage = 'recording'
            AND ts.status = 'failed'
            AND ts.retryable = false
            AND ts.evidence ->> 'acoustid' = 'skipped'`,
    );
    if (reopened > 0) {
        logger.info(
            `[Enrichment] Re-opened ${reopened} recording stage(s) that never asked AcoustID`,
        );
    }
    return reopened;
}

/**
 * "Retry failed and blocked" — the only re-queue control.
 *
 * One `getNextWork` over `TrackStage`: every track that still owes an answer,
 * or is due a retry — one record per track per stage. Nothing is reset and
 * nothing is wiped: the records already say what is owed, a `done` answer is
 * not re-asked, and a terminal (`retryable = false`) answer stays closed.
 *
 * The one deliberate exception rides the same control: handing the
 * fingerprint stage out again (a due retry) may settle a NEW fingerprint, so
 * a recording stage that closed as a no-match WITHOUT AcoustID is re-opened
 * right here, before the sweep reads the records. It is not offered yet —
 * the fingerprint → recording gate keeps it unoffered while the fingerprint
 * question is open — and once the retry lands it is due again, this time
 * with a fingerprint to ask with.
 *
 * This replaces `runFullEnrichment`, which wiped every embedding and cleared
 * every track's `enrichmentTags` to force a re-ask of questions most tracks
 * had already answered correctly.
 */
export async function retryFailedAndBlocked(
    limit = TRACK_BATCH_SIZE,
): Promise<StageWork[]> {
    await reopenRecordingsThatNeverAskedAcoustid();

    const work = await getNextWork(limit);

    // dispatchStageWork filters to the stage it is given, so passing the
    // whole list to each producer hands out exactly that stage's owed rows.
    for (const stage of STAGE_ORDER) {
        await dispatchStageWork(stage, work, STAGE_PRODUCERS[stage]);
    }

    return work;
}

/**
 * "Re-decide everything" — an operator override that deliberately ignores
 * `done`, for the case "we know the answer was wrong".
 *
 * It re-opens every stage question, answered or not, so the sweep asks again.
 * The one thing it never does is re-run AcoustID over a track we already
 * identified: a track with a `recordingMbid` keeps its recording answer,
 * because re-fingerprinting would spend a fingerprint and a lookup to
 * rediscover something already in the column.
 *
 * Only the queue's own state moves. No answer is deleted — `track_embeddings`
 * rows and `enrichmentTags` stay exactly as they are, which is the whole
 * difference between this and the `resetAllEnrichmentData` it replaces.
 */
export async function redecideEverything(): Promise<{ reopened: number }> {
    let reopened = 0;

    for (const stage of STAGE_ORDER) {
        reopened += await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" ts
                SET status = 'pending',
                    attempt = 0,
                    "lastErrorCode" = NULL,
                    "lastErrorMessage" = NULL,
                    "failureClass" = NULL,
                    retryable = true,
                    "nextRetryAt" = NULL,
                    "startedAt" = NULL,
                    "finishedAt" = NULL,
                    "decidedAt" = NULL,
                    "decidedBy" = NULL
               FROM "Track" t
              WHERE ts.stage = $1
                AND t.id = ts."trackId"
                -- AcoustID dedup guard: never re-ask a recording we found.
                AND NOT (ts.stage = 'recording' AND t."recordingMbid" IS NOT NULL)`,
            stage,
        );
    }

    // The loop above re-opens the fingerprint stage (so new fingerprints
    // land) — which is exactly when a recording no-match that never asked
    // AcoustID stops being an honest answer. Re-open those with it, in the
    // same place: the loop's own AcoustID dedup guard skips recording rows
    // whose track carries a `recordingMbid`, and this catches the marked
    // no-match rows even in that corner. The gate then holds the re-opened
    // questions until the re-asked fingerprint question is settled.
    reopened += await reopenRecordingsThatNeverAskedAcoustid();

    // Mirror the reopen onto the columns the analyzer claims and the settings
    // UI reads, so a record saying `pending` is not contradicted by a column
    // still saying `completed` — that contradiction let reconcileStaleStage
    // -Records flip a deliberately re-opened question straight back to `done`
    // before anything had re-answered it.
    await prisma.track.updateMany({
        where: { analysisStatus: { not: "pending" } },
        data: {
            analysisStatus: "pending",
            analysisStartedAt: null,
            analysisRetryCount: 0,
        },
    });

    logger.debug(`[Enrichment] Re-deciding everything: ${reopened} stage records reopened`);

    // Do NOT dispatch here. The re-opened questions are pending, and the
    // next scheduled cycle's getNextWork hands them out -- dispatching
    // straight away would claim every record to `working` before the
    // operator could even see the reopened state, and a claim whose job
    // nobody consumed is exactly the parked-record pattern this replaces.

    return { reopened };
}

/**
 * Main enrichment cycle
 *
 * Flow:
 * 1. Artist metadata (MusicBrainz/Wikidata/ListenBrainz) - blocking, required for track enrichment
 * 2. Track tags (MusicBrainz genres) - blocking, quick API calls
 * 3. Audio analysis (Essentia) - NON-BLOCKING, queued to Redis for background processing
 *
 * Steps 1 & 2 must complete before enrichment is "done".
 * Step 3 runs entirely in background via the audio-analyzer Docker container.
 *
 * @param fullMode - If true, processes everything. If false, only pending items.
 */
async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
    /** Queued for embedding this cycle. */
    vibeQueued?: number;
    /** Fingerprint answers landed this cycle (local fpcalc, inline). */
    fingerprintsQueued?: number;
    /**
     * Set when the cycle declined to run at all rather than running and finding nothing.
     *
     * The two look identical from the outside and must not be treated the same: a cycle
     * that found nothing should back off, while a cycle that was merely too early should
     * come back promptly. Conflating them is what left the embedder idle for minutes at a
     * time -- see the scheduling note in scheduleNextEnrichmentCycle.
     */
    declined?: "already-running" | "too-soon";
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Handle stopping state: transition to idle before checking isPaused.
    // This must run first because stop sets both isStopping AND isPaused.
    // If we checked isPaused first, we'd return early and never clear isStopping.
    if (isStopping) {
        // No "stop cleanup" reset. It flipped every `processing` row back to
        // `pending` and zeroed the retry count, which is the same
        // crash-recovery sweep in a different place: it re-asked questions the
        // stage records have already answered and hid the true state. The
        // record owns the attempt; stopping does not edit answers.
        await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
        isStopping = false;
        isPaused = false;
        userStopped = true;
        return emptyResult;
    }

    // User explicitly stopped -- don't auto-restart via timer.
    // Only explicit actions (re-run, full enrich, triggerEnrichmentNow) clear this.
    if (userStopped && !fullMode && !immediateEnrichmentRequested) {
        if (!userStoppedWarned) {
            const pendingCount = await prisma.track.count({ where: { analysisStatus: "pending" } });
            if (pendingCount > 0) {
                logger.warn(`[Enrichment] userStopped=true but ${pendingCount} tracks are pending. Use "Run Enrichment" or "Full Enrichment" to resume.`);
                userStoppedWarned = true;
            }
        }
        return emptyResult;
    }

    // Sync local flags with state service (fallback for missed control messages)
    if (isPaused) {
        // Reverse sync: if state says running but local isPaused is true, resume.
        // Must resume the REAL infrastructure, not just clear the local flag --
        // a missed "resume" control message (Redis reconnect, message loss) leaves
        // the BullMQ workers paused and the analyzer gate closed while state claims
        // running: the exact false-heartbeat hang this class exists to kill.
        const state = await enrichmentStateService.getState();
        if (state?.status === "running") {
            logger.warn("[Enrichment] Reverse sync: state is running but local pause was set -- resuming workers + analyzer gate");
            await resumeInfrastructure();
            isPaused = false;
        }
    } else {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused") {
            isPaused = true;
        } else if (state?.status === "stopping") {
            // State says stopping but we missed the control message. Same
            // reasoning as the isStopping branch above: no reset of
            // `processing` rows, because the stage record owns the attempt and
            // rewriting the column would contradict it.
            await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
            userStopped = true;
            return emptyResult;
        }
    }

    if (isPaused) {
        return emptyResult;
    }

    // Never allow concurrent runs
    if (isRunning) {
        return { ...emptyResult, declined: "already-running" };
    }

    // Enforce minimum interval (unless full mode or immediate request)
    const bypassIntervalCheck = fullMode || immediateEnrichmentRequested;
    const now = Date.now();
    if (!bypassIntervalCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return { ...emptyResult, declined: "too-soon" };
    }

    immediateEnrichmentRequested = false;
    lastRunTime = now;

    // Detect hangs: warn if enrichment has been "running" > 15 min with no state update
    const isHung = await enrichmentStateService.detectHang();
    if (isHung) {
        logger.warn("[Enrichment] Hang detected — enrichment has been running > 15 min with no activity");
    }

    // One cycle, one owner, across processes too: the
    // in-process flag above only covers this process. If the cycle lock is
    // held, another process is dispatching and this call declines rather
    // than double-offering the same records.
    if (!(await distributedLock.acquire(CYCLE_LOCK_KEY, CYCLE_LOCK_TTL_MS))) {
        return { ...emptyResult, declined: "already-running" };
    }

    isRunning = true;

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;
    let vibeQueued = 0;
    let fingerprintsQueued = 0;

    try {
        // Closed dependencies first: a record whose prerequisite stage
        // closed terminal can never be answered, and must not sit `pending`
        // for the life of the library.
        await closeOrphanedDependents();

        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase("artists", executeArtistsPhase);
        if (artistResult === null) {
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase("tracks", executeMoodTagsPhase);
        if (trackResult === null) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        // Fingerprint sweep — local fpcalc, no prerequisite: every track
        // gets its fingerprint stored,
        // independent of where its identity or analysis stand. A paused
        // 'acoustid' source gates only the network lookup, never this.
        const fingerprintResult = await runPhase("fingerprint", executeFingerprintPhase);
        if (fingerprintResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        fingerprintsQueued = fingerprintResult;

        const audioResult = await runPhase("audio", executeAudioPhase);
        if (audioResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase("podcasts", executePodcastRefreshPhase);

        // Vibe embedding sweep — catches tracks missed by the event-driven subscriber
        const vibeResult = await runPhase("vibe", executeVibePhase);
        vibeQueued = vibeResult ?? 0;

        // Orphaned failure cleanup -- runs at most once per hour, never during stop/pause
        const ONE_HOUR_MS = 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastOrphanedFailuresCleanup || Date.now() - lastOrphanedFailuresCleanup.getTime() > ONE_HOUR_MS)) {
            await enrichmentFailureService.cleanupOrphanedFailures();
            lastOrphanedFailuresCleanup = new Date();
        }

        // Daily: clean up old resolved failures (>30 days)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastResolvedCleanup || Date.now() - lastResolvedCleanup.getTime() > ONE_DAY_MS)) {
            lastResolvedCleanup = new Date();
            await enrichmentFailureService.cleanupOldResolved();
        }

        const features = await featureDetection.getFeatures();
        // Computed ONCE per cycle. This used to be called here and again
        // unconditionally below, so a tick that did work paid for the whole
        // progress query set twice.
        const progress = await getEnrichmentProgress();
        const didWork =
            artistsProcessed > 0 ||
            tracksProcessed > 0 ||
            audioQueued > 0 ||
            fingerprintsQueued > 0;

         // Log progress (only if work was done)
         if (didWork) {
            logger.debug(`\n[Enrichment Progress]`);
            logger.debug(
                `   Artists: ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`,
            );
            logger.debug(
                `   Track Tags: ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`,
            );
            logger.debug(
                `   Audio Analysis: ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%) [background]`,
            );
            if (features.fpcalc) {
                logger.debug(
                    `   Fingerprints: ${progress.fingerprints.completed}/${progress.fingerprints.total} (${progress.fingerprints.progress}%)`,
                );
            }
            if (features.vibeEmbeddings) {
                logger.debug(
                    `   Vibe Embeddings: ${progress.clapEmbeddings.completed}/${progress.clapEmbeddings.total} (${progress.clapEmbeddings.progress}%) [background]`,
                );
            }
            logger.debug("");

            // Update state with progress
            await enrichmentStateService.updateState({
                artists: {
                    total: progress.artists.total,
                    completed: progress.artists.completed,
                    failed: progress.artists.failed,
                },
                tracks: {
                    total: progress.trackTags.total,
                    completed: progress.trackTags.enriched,
                    failed: 0,
                },
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: progress.audioAnalysis.processing,
                },
                completionNotificationSent: false, // Reset flag when new work is processed
            });

        }

        // If everything is complete, mark as idle and send notification (only once)
        // Clear mixes cache when core enrichment completes (artist images now available)
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys: string[] = [];
                    let scanCursor = "0";
                    do {
                        const [nextCursor, batch] = await redisInstance.scan(scanCursor, "MATCH", "mixes:*", "COUNT", 100);
                        scanCursor = nextCursor;
                        mixKeys.push(...batch);
                    } while (scanCursor !== "0");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after core enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        coreCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on core complete:",
                        error,
                    );
                }
            }
        }

        if (progress.isFullyComplete) {
            // Flush final audio counter before going idle -- it may be stale because
            // the update block above only runs when audioQueued > 0.  Once all tracks
            // are already queued, that block is skipped while Essentia finishes in
            // the background, leaving the counter frozen at a mid-run snapshot.
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: 0,
                },
            });

            // Read state once -- used to gate both pre-compute and notification below.
            const stateBeforeNotify = await enrichmentStateService.getState();

            // Pre-compute vibe map projection so it's cached before first page visit.
            // Gated on completionNotificationSent: once that flag is set the library is
            // stable and the projection is already cached.  Without this guard,
            // precomputeProjection() fires every 5-second tick, deletes the cache keys
            // before UMAP finishes, and the cache is never stable.
            if (!stateBeforeNotify?.completionNotificationSent) {
                precomputeProjection().catch(e =>
                    logger.error("[Enrichment] Vibe map pre-compute failed:", e)
                );
            }

            // Clear mixes cache again when fully complete (audio analysis done)
            if (!stateBeforeNotify?.fullCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys: string[] = [];
                    let scanCursor = "0";
                    do {
                        const [nextCursor, batch] = await redisInstance.scan(scanCursor, "MATCH", "mixes:*", "COUNT", 100);
                        scanCursor = nextCursor;
                        mixKeys.push(...batch);
                    } while (scanCursor !== "0");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after full enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        fullCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on full complete:",
                        error,
                    );
                }
            }

            if (!stateBeforeNotify?.completionNotificationSent) {
                try {
                    const { notificationService } = await import("../services/notificationService");
                    const users = await prisma.user.findMany({ select: { id: true } });
                      // The counts are TrackStage-backed for track stages
                      // so the summary reports what the failures
                      // API actually shows.
                      const failureCounts = await enrichmentFailureService.getFailureCounts();

                      for (const user of users) {
                          if (failureCounts.total > 0) {
                              const parts: string[] = [];
                              if (failureCounts.artist > 0) parts.push(`${failureCounts.artist} artist(s)`);
                              if (failureCounts.track > 0) parts.push(`${failureCounts.track} track(s)`);
                              if (failureCounts.audio > 0) parts.push(`${failureCounts.audio} audio analysis`);
                              if (failureCounts.vibe > 0) parts.push(`${failureCounts.vibe} vibe embedding(s)`);
                              if (failureCounts.scan > 0) parts.push(`${failureCounts.scan} fingerprint(s)`);
                              if (failureCounts.podcast > 0) parts.push(`${failureCounts.podcast} podcast(s)`);

                            await notificationService.create({
                                userId: user.id,
                                type: "error",
                                title: "Enrichment Completed with Errors",
                                message: `${failureCounts.total} failures: ${parts.join(", ")}. Check Settings > Enrichment for details.`,
                            });
                        }

                        await notificationService.notifySystem(
                            user.id,
                            "Enrichment Complete",
                            `Enriched ${progress.artists.completed} artists, ${progress.trackTags.enriched} tracks, ${progress.audioAnalysis.completed} audio analyses`,
                        );
                    }

                    await enrichmentStateService.updateState({ completionNotificationSent: true });
                    logger.debug("[Enrichment] Completion notification sent");
                } catch (error) {
                    logger.error("[Enrichment] Failed to send completion notification:", error);
                }
            }
        }
    } catch (error) {
        logger.error("[Enrichment] Cycle error:", error);

        // Record the SYSTEM-level failure. This is not a track-stage
        // failure — per-track stage failures live only in TrackStage
        // the EnrichmentFailure ledger remains for entities
        // that have no stage record, and "the enrichment system" is one.
        // The old counter-based circuit breaker that gated this write is
        // gone: a source that fails is held by its
        // `SourceAttempt` pause, and a suppressed error ledger is a
        // third copy of a fact the pause and the record already own.
        await enrichmentFailureService
            .recordFailure({
                entityType: "artist", // Generic type for system errors
                entityId: "system",
                entityName: "Enrichment System",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
                errorCode: "SYSTEM_ERROR",
            })
            .catch((err) =>
                logger.error("[Enrichment] Failed to record failure:", err),
            );
    } finally {
        isRunning = false;
        await distributedLock.release(CYCLE_LOCK_KEY);
    }

    return {
        artists: artistsProcessed,
        tracks: tracksProcessed,
        audioQueued,
        vibeQueued,
        fingerprintsQueued,
    };
}


/**
 * True when the track's fingerprint stage closed as a PERMANENT failure
 * (`failed`, `retryable = false`): the fingerprint question is settled —
 * answered "never" — so the recording stage's AcoustID step is skipped and
 * the skip recorded, instead of the stage polling for a fingerprint that
 * will never arrive. A pending, working, or retryable-failed fingerprint
 * record is NOT settled; those states never get this far, because the
 * fingerprint → recording gate in PREREQUISITE_STAGE keeps the recording
 * stage unoffered while the question is open.
 */
async function fingerprintStageSettledFailed(trackId: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ status: string; retryable: boolean }>
    >(
        `SELECT status, retryable FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = 'fingerprint'`,
        trackId,
    );
    const row = rows[0];
    return !!row && row.status === "failed" && !row.retryable;
}

/**
 * Enrich a single track's tags from MusicBrainz genres.
 * Used by the BullMQ track enrichment Worker (Phase 4).
 *
 * The `recording` record owns the answer: this function writes `done`
 * (identified — with the source that answered) or `failed` (INCONCLUSIVE
 * with its evidence) via the record functions, so a retry rides the
 * record's `nextRetryAt` and a closed record is never re-offered. A
 * rate-limit-shaped failure pauses only the source that refused us and
 * does not consume an attempt.
 *
 * The AcoustID step runs only once the fingerprint question is settled
 * (the fingerprint → recording edge in PREREQUISITE_STAGE): it reuses the
 * stored fingerprint, or — when the fingerprint stage closed as a permanent
 * failure — is skipped with the skip recorded in the evidence. It never
 * waits here and never defers: waiting is the gate's job.
 */
/** A genre tag with the vote count MusicBrainz attached to it. */
type CatalogueGenre = { name: string; count: number };

/** One row of a release's tracklist, as the catalogue chain returns it. */
type CatalogueRecording = {
    recordingId: string;
    title: string;
    durationMs: number | null;
    isrcs: string[];
    genres: CatalogueGenre[];
};

/** What the album chain answered: this track's row plus the album-level answers. */
type CatalogueAnswer = {
    entry: CatalogueRecording;
    albumGenres: CatalogueGenre[];
    originalYear: number | null;
    label: string | null;
};

/**
 * Find our file in the release's tracklist: a row whose title agrees with
 * ours (same ladder as album titles — `titlesAgree`) and whose length is
 * within 2.5 s, or, if no row satisfies both, the first row whose title
 * agrees. An album with two files of one title ("Reprise", a hidden
 * track) is told apart by the duration; a mislabelled length does not
 * lose the song.
 */
function matchCatalogueRecording(
    recordings: CatalogueRecording[],
    trackTitle: string,
    durationSec: number | null,
): CatalogueRecording | null {
    let titleOnly: CatalogueRecording | null = null;
    for (const rec of recordings) {
        if (!titlesAgree(rec.title, trackTitle)) continue;
        if (
            durationSec == null ||
            rec.durationMs == null ||
            Math.abs(rec.durationMs - durationSec * 1000) <= 2500
        ) {
            return rec;
        }
        titleOnly ??= rec;
    }
    return titleOnly;
}

/**
 * Fill the album row from the chain: original year, label, and the top
 * five genres — each written only where the row is still blank, so a scan
 * tag or a manual edit is never overwritten, and concurrent jobs for two
 * tracks of one album write the same answer at worst.
 */
async function fillAlbumFromCatalogue(
    album: { id: string; year: number | null; label: string | null; genres: Prisma.JsonValue },
    answer: CatalogueAnswer,
): Promise<void> {
    const data: {
        year?: number;
        originalYear?: number;
        label?: string;
        genres?: string[];
    } = {};
    if (album.year == null && answer.originalYear != null) {
        data.year = answer.originalYear;
    }
    if (!album.label && answer.label) data.label = answer.label;
    const existing = album.genres as string[] | null;
    if ((existing == null || existing.length === 0) && answer.albumGenres.length > 0) {
        data.genres = [...answer.albumGenres]
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map((g) => g.name);
    }
    if (Object.keys(data).length > 0) {
        await prisma.album.update({ where: { id: album.id }, data });
    }
}

export async function enrichSingleTrack(
    trackId: string,
): Promise<"identified" | "no_match" | "deferred"> {
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    if (!track) {
        const err = new Error(`ENTITY_NOT_FOUND: Track ${trackId} deleted`);
        (err as any).entityNotFound = true;
        throw err;
    }

    const artistName = track.album.artist.name;

    // Recording identity + genres. Ladder:
    // (a) the file's own identity tags answer first with no network call;
    // (b) the album's catalogue — one two-request fetch chain shared by
    // every track on the album, cached 30 days — answers second, taking
    // this track's recording, ISRCs, and genres from the release's
    // tracklist; (c) only what the chain did not answer falls to the
    // per-track title-checked name search; and (d) AcoustID runs only for
    // the remainder — and its computed or tagged fingerprint is stored
    // either way, since the dedupe column wants the fingerprint whether or
    // not the lookup matched. Tracks that already carry an ISRC identify
    // their recording from it directly, so no AcoustID work is needed.
    //
    // Genres go to the genre tables only: the top five
    // tags — the recording's own when it has them, else the album's —
    // populate TrackGenre via populateTrackGenres. Moods come from audio
    // analysis only, so this stage writes
    // nothing into `enrichmentTags` — not real tags, not the old
    // "_not_found"/"_no_mood_tags" sentinels.
    //
    // The recording budget is the stage's own (STAGE_TIMEOUT_MS) — two or
    // three HTTP calls' worth, independent of the track's duration and
    // shared with no other stage.
    const timeoutMs = getStageTimeoutMs("recording");
    let recordingMbid: string | null = null;
    let needsIsrc = false;
    let answerSource = "musicbrainz";
    let fingerprintToStore: string | null = null;
    // First failed ask among the identity chain, with the source that
    // failed. A failed call is NOT a no-match: the record defers with the
    // real cause until the retry ladder or the source pause resolves.
    let failedAsk: { source: string; outcome: FailureOutcome } | null = null;
    // Set when the AcoustID step never ran — the fingerprint stage closed
    // as a permanent failure, or the source is paused. The no-match (if it
    // comes to that) must be honest about which identity steps ran.
    let acoustidSkipped = false;
    // Set when the album chain answered for this track: the identity, the
    // ISRCs, the genres, and the album-level answers (original year,
    // label, genres) all come from that one chain and are never re-asked
    // per track.
    let catalogueAnswer: CatalogueAnswer | null = null;

    if (!track.isrc) {
        needsIsrc = true;
        const trackRef = {
            id: track.id,
            title: track.title,
            filePath: track.filePath,
            duration: track.duration,
        };

        // (a) File tags first — read once, no network.
        const tags = await readIdentityTags(trackRef);
        if (tags?.recordingMbid) {
            recordingMbid = tags.recordingMbid;
            answerSource = "file_tag";
            if (tags.fingerprint) fingerprintToStore = tags.fingerprint;
        } else {
            // (b) The album's catalogue — two requests for the whole
            // album (the release group, then its earliest release with the
            // tracklist), served from cache for every further track. Only
            // albums whose stored id is a real MusicBrainz id can be
            // fetched; placeholder ids are locally made up and stay on the
            // per-track ladder.
            if (hasRealMbid(track.album.rgMbid)) {
                const chain = await askWithinBudget(
                    () =>
                        musicBrainzService.getAlbumCatalogue(
                            track.album.rgMbid!,
                        ),
                    timeoutMs,
                    `Timeout fetching MB album: ${track.album.title}`,
                );
                if (chain.kind === "answered") {
                    const entry = matchCatalogueRecording(
                        chain.value.recordings,
                        track.title,
                        track.duration,
                    );
                    if (entry) {
                        catalogueAnswer = {
                            entry,
                            albumGenres: chain.value.genres,
                            originalYear: chain.value.originalYear,
                            label: chain.value.label,
                        };
                        recordingMbid = entry.recordingId;
                    }
                } else if (chain.kind !== "absent") {
                    failedAsk = { source: "musicbrainz", outcome: chain };
                }
            }

            // (c) The per-track name search, then (d) AcoustID — only for
            // tracks the chain did not answer (placeholder album, or a
            // file that is not on the release's tracklist). When the chain
            // call itself failed there is nothing to fall through to: the
            // search and AcoustID would just re-ask a host that is already
            // failing, so the record defers on the chain's real cause.
            if (!catalogueAnswer && !failedAsk) {
                const search = await askWithinBudget(
                    () =>
                        musicBrainzService.searchRecording(track.title, artistName),
                    timeoutMs,
                    `Timeout searching MB recording: ${track.title}`,
                );
                if (search.kind === "answered") {
                    recordingMbid = search.value.trackMbid;
                } else if (search.kind !== "absent") {
                    failedAsk = { source: "musicbrainz", outcome: search };
                }

                // AcoustID for the remainder — only when neither the tags
                // nor the album chain nor the name search answered.
                //
                // The gate (PREREQUISITE_STAGE: fingerprint → recording,
                // "settled") guarantees the fingerprint QUESTION has been
                // answered before this stage ever runs. Either a
                // fingerprint is stored — the AcoustID step consumes it —
                // or the fingerprint stage closed as a permanent failure
                // and no fingerprint will ever arrive: then the step is
                // skipped here and the skip is written into this stage's
                // evidence, so the no-match (if it comes to that) is honest
                // about which identity steps ran. The source pause still
                // applies to the asking itself: an AcoustID rate limit must
                // stop the asking, not the sweep. features.fpcalc gates the
                // FINGERPRINT phase, never this step — this step never runs
                // fpcalc.
                if (!recordingMbid) {
                    if (
                        !track.acoustidFingerprint &&
                        (await fingerprintStageSettledFailed(track.id))
                    ) {
                        acoustidSkipped = true;
                        logger.debug(
                            `[Track Enrichment] ${track.title}: AcoustID skipped — fingerprint stage closed as a permanent failure`,
                        );
                    } else if (
                        !(await sourcePauseController.isPaused("acoustid"))
                    ) {
                        const identified = await askWithinBudget(
                            () =>
                                identifyTrackByAcoustid(
                                    trackRef,
                                    tags,
                                    // Reuse the fingerprint the fingerprint
                                    // stage already stored on the track —
                                    // never spend a second fpcalc run
                                    // recomputing what is on disk.
                                    track.acoustidFingerprint
                                        ? { fingerprint: track.acoustidFingerprint }
                                        : null,
                                ),
                            timeoutMs,
                            `Timeout asking AcoustID: ${track.title}`,
                        );
                        if (identified.kind === "answered") {
                            recordingMbid = identified.value.recordingMbid;
                            answerSource = identified.value.source;
                            fingerprintToStore =
                                identified.value.fingerprint ?? null;
                            logger.debug(
                                `[Track Enrichment] ${track.title}: AcoustID identified via ${identified.value.source} (recording ${identified.value.recordingMbid})`,
                            );
                        } else if (identified.kind === "absent") {
                            // Asked and nothing matched — an answer, not a
                            // failure. The dedupe column still wants the
                            // fingerprint (it is in the evidence).
                            const fp = identified.evidence["fingerprint"];
                            if (typeof fp === "string") fingerprintToStore = fp;
                        } else if (!failedAsk) {
                            failedAsk = { source: "acoustid", outcome: identified };
                        }
                    } else {
                        acoustidSkipped = true;
                        logger.debug(
                            `[Track Enrichment] ${track.title}: AcoustID skipped — source paused`,
                        );
                    }
                }
            }
        }

        if (fingerprintToStore) {
            try {
                await persistAcoustidFingerprint(track.id, fingerprintToStore);
            } catch (err) {
                // A failed fingerprint write is a real failure, not an
                // empty warning: the record keeps the actual error and the
                // question stays open with its own retry schedule.
                await recordStageFailure(track.id, "recording", "acoustid", err, {
                    stage: "persisting the fingerprint on Track",
                });
                return "deferred";
            }
        }
    } else {
        // Track already has an ISRC: find the recording from the known
        // identifier instead of re-identifying it.
        const rec = await askWithinBudget(
            () => musicBrainzService.lookupByIsrc(track.isrc!),
            timeoutMs,
            `Timeout looking up MB recording by ISRC: ${track.title}`,
        );
        if (rec.kind === "answered") {
            recordingMbid = rec.value.recordingId;
            answerSource = "isrc";
        } else if (rec.kind !== "absent") {
            failedAsk = { source: "musicbrainz", outcome: rec };
        }
    }

    if (failedAsk) {
        // The question never got an answer: the source itself failed.
        // recordOutcomeFailure parks the record with the REAL cause (a
        // rate limit stays pending with nextRetryAt at the pause deadline
        // and no attempt consumed; other failures take the retry ladder).
        // Nothing is written to the track row — the record owns the open
        // question.
        await recordOutcomeFailure(
            track.id,
            "recording",
            failedAsk.source,
            failedAsk.outcome,
            {
                paths: track.isrc
                    ? ["isrc"]
                    : catalogueAnswer
                      ? ["album-catalogue"]
                      : ["mb-search", "acoustid"],
                ...(acoustidSkipped
                    ? {
                          acoustid: "skipped",
                          reason:
                              "fingerprint stage closed as a permanent failure, or the source is paused — AcoustID was never asked",
                      }
                    : {}),
            },
        );
        return "deferred";
    }

    if (!recordingMbid) {
        if (!acoustidSkipped) {
            // Every identity source that could be asked was asked and
            // answered "nothing": that is an answer, not a failure. The
            // record closes `done` with evidence naming who was asked —
            // a record whose correct answer is "does not exist" must not
            // burn the retry ladder re-asking the same question.
            await recordStageAbsent(
                track.id,
                "recording",
                track.isrc ? "musicbrainz" : "acoustid",
                {
                    reason:
                        "sources have no recording for this track",
                    asked: track.isrc
                        ? ["isrc", "acoustid"]
                        : ["mb-search", "acoustid"],
                },
            );
            return "no_match";
        }
        // Nothing was asked or the only remaining source is paused — an
        // unclassifiable miss stays INCONCLUSIVE on the record, with the
        // raw evidence kept, so the question can be re-asked when its
        // nextRetryAt lands (until the retry cap closes it).
        const acoustidEvidence = acoustidSkipped
            ? {
                  acoustid: "skipped",
                  reason:
                      "fingerprint stage closed as a permanent failure — no fingerprint to ask with",
              }
            : {};
        await recordStageFailure(
            track.id,
            "recording",
            answerSource,
            new Error(
                `No recording identified for "${track.title}" by ${artistName}`,
            ),
            {
                paths: track.isrc ? ["isrc"] : ["mb-search", "acoustid"],
                ...acoustidEvidence,
            },
        );
        // No tag stamp here: the question was never answered, so the
        // record stays open and the track keeps its current tags until
        // a source actually answers.
        return "no_match";
    }

    // The answer lands on Track: "which recording is this?" needs an
    // answer to KEEP, not just one to use for this run.
    await prisma.track.update({
        where: { id: track.id },
        data: { recordingMbid },
    });

    if (catalogueAnswer) {
        try {
            const [firstIsrc] = catalogueAnswer.entry.isrcs;
            if (firstIsrc) {
                await trackIdentityService.storeIsrc(
                    track.id,
                    firstIsrc,
                    "musicbrainz",
                );
            }
            const genreSource =
                catalogueAnswer.entry.genres.length > 0
                    ? catalogueAnswer.entry.genres
                    : catalogueAnswer.albumGenres;
            const topGenres = [...genreSource]
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map((g) => g.name);
            // Genres to the genre tables only — the track row keeps
            // no parallel tag list.
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            // The same chain answers the album: original year, label, and
            // genres, filled only where the row is still blank (a scan
            // tag or a manual edit may already have answered).
            await fillAlbumFromCatalogue(track.album, catalogueAnswer);
            await recordStageSuccess(track.id, "recording", "musicbrainz", {
                recordingMbid,
                reason: "identified from the album's tracklist",
                tags: topGenres,
            });
            logger.debug(
                `   ✓ ${track.title}: [${topGenres.slice(0, 3).join(", ")}...]`,
            );
            return "identified";
        } catch (err) {
            logger.debug(
                `[Track Enrichment] album-catalogue write failed for ${track.title}: ${err}`,
            );
            await recordStageFailure(track.id, "recording", "musicbrainz", err, {
                recordingMbid,
                stage: "writing the album-chain answer",
            });
            return "deferred";
        }
    }

    try {
        if (needsIsrc) {
            const isrc = await askWithinBudget(
                () => musicBrainzService.getRecordingIsrc(recordingMbid),
                timeoutMs,
                `Timeout fetching MB ISRC: ${track.title}`,
            );
            if (isrc.kind === "answered") {
                await trackIdentityService.storeIsrc(
                    track.id,
                    isrc.value,
                    "musicbrainz",
                );
            }
            // `absent` — the identified recording has no ISRC — is an
            // answer: there is nothing to store, and the question is done.
        }
        const genres = await askWithinBudget(
            () => musicBrainzService.getRecordingGenres(recordingMbid),
            timeoutMs,
            `Timeout fetching MB genres: ${track.title}`,
        );
        if (genres.kind === "answered") {
            const topGenres = genres.value.genres
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map((g) => g.name);
            // Genres to the genre tables only — the track row keeps
            // no parallel tag list.
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            await recordStageSuccess(track.id, "recording", answerSource, {
                recordingMbid,
                reason: `identified via ${answerSource}`,
                tags: topGenres,
            });
            logger.debug(
                `   ✓ ${track.title}: [${topGenres.slice(0, 3).join(", ")}...]`,
            );
            return "identified";
        }
        if (genres.kind === "absent") {
            // Identified, but the recording genuinely has no genres — that
            // is an answer, not a failure. The record says "no genres";
            // no sentinel is written anywhere.
            await recordStageSuccess(track.id, "recording", answerSource, {
                recordingMbid,
                reason: `identified via ${answerSource}, recording carries no genres`,
            });
            return "identified";
        }
        // Identified, but the genres/ISRC question failed: record it with
        // the real cause so the question is re-asked on the record's own
        // schedule.
        await recordOutcomeFailure(
            track.id,
            "recording",
            "musicbrainz",
            genres,
            {
                recordingMbid,
                stage: "fetching genres/isrc for an identified recording",
            },
        );
        return "deferred";
    } catch (err) {
        logger.debug(
            `[Track Enrichment] MB recording enrichment failed for ${track.title}: ${err}`,
        );
        // An unexpected throw (a DB write, not a source answer): record it
        // with its real error so the question is re-asked on the record's
        // own schedule.
        await recordStageFailure(track.id, "recording", answerSource, err, {
            recordingMbid,
            stage: "fetching genres/isrc for an identified recording",
        });
        return "deferred";
    }
}


/**
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (either stopping or paused).
 */
async function shouldHaltCycle(): Promise<boolean> {
    if (isStopping || userStopped) {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        isStopping = false;
        isPaused = false;
        return true;
    }
    return isPaused;
}

/**
 * Run a phase and return result. Returns null if cycle should halt.
 */
async function runPhase(
    phaseName:
        | "artists"
        | "tracks"
        | "scan"
        | "audio"
        | "podcasts"
        | "vibe"
        | "fingerprint",
    executor: () => Promise<number>,
): Promise<number | null> {
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: phaseName,
    });

    const result = await executor();

    if (await shouldHaltCycle()) {
        return null;
    }

    return result;
}

export async function executeArtistsPhase(): Promise<number> {
    // Reset temp-MBID artists that have been unresolvable for >24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.artist.updateMany({
        where: {
            mbid: { startsWith: "temp-" },
            enrichmentStatus: "unresolvable",
            lastEnriched: { lt: oneDayAgo },
        },
        data: { enrichmentStatus: "pending" },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pendingArtists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
                { enrichmentStatus: "unresolvable", lastEnriched: { lt: sevenDaysAgo } },
            ],
            albums: { some: {} },
        },
        select: { id: true, name: true },
        take: ARTIST_BATCH_SIZE,
    });

    if (pendingArtists.length === 0) return 0;

    // Free reusable jobIds: completed immediately, failed after a backoff grace.
    // Without this a failed artist's `artist-<id>` marker blocks every re-add
    // until BullMQ's removeOnFail age (24h) expires -- far slower than intended.
    try {
        await artistQueue.clean(0, 0, "completed");
        await artistQueue.clean(FAILED_JOB_RETRY_GRACE_MS, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] artistQueue clean failed: ${(err as Error).message}`);
    }

    let queued = 0;
    for (const artist of pendingArtists) {
        try {
            // Only enqueue + park as "enriching" when the jobId slot is actually
            // free. A failed job younger than the grace still holds the slot, so
            // a plain add() would no-op while we parked the artist as
            // "enriching" anyway -- removing it from selection until a process
            // restart, never actually retrying. Skipping here leaves it
            // "failed"/"pending" so it backs off and retries once the grace
            // clean above frees the slot.
            const jobId = `artist-${artist.id}`;
            if (await artistQueue.getJob(jobId)) continue;
            // Add FIRST — if Redis is down, status stays "pending" and retries naturally
            await artistQueue.add(
                "enrich",
                { artistId: artist.id, artistName: artist.name },
                { jobId },
            );
            // Update AFTER successful add
            await prisma.artist.update({
                where: { id: artist.id },
                data: { enrichmentStatus: "enriching" },
            });
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue artist ${artist.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} artists`);
    }
    return queued;
}

/**
 * Claim the owed records for `stage` and put one job per track on its queue.
 *
 * This is the ONLY producer for each stage's queue. Selection comes from
 * `TrackStage`, so a track whose record is answered — or is a terminal failure
 * — is simply not offered, and no track's answer can hold another track's
 * stage behind it.
 */
/**
 * Sync stage records still in `working` against the truth in the columns.
 *
 * The `analysis` and `embedding` questions are answered by the Python
 * consumers, which write `Track.analysisStatus` / `Track.vibeAnalysisStatus`
 * / `track_embeddings` — never the record. Without this pass a record would
 * sit in `working` forever after its answer landed, so the record could
 * never gate the next stage. When the column has answered, the record is
 * synced to that answer; when the attempt's own stage timeout elapsed with
 * no answer, the attempt is dead — the record goes back to `pending` with a
 * fresh `nextRetryAt`, and per the design a timeout does NOT count as an
 * attempt (the attempt count stays where it was).
 */
async function reconcileStaleStageRecords(stage: StageName): Promise<void> {
    if (stage === "recording") {
        // The recording question is answered in-process by enrichSingleTrack;
        // a `working` record older than the stage timeout is a dead attempt.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending',
                    "nextRetryAt" = now() + ($3::double precision * interval '1 millisecond')
              WHERE stage = $1
                AND status = 'working'
                AND "startedAt" < now() - ($2::double precision * interval '1 millisecond')`,
            stage,
            getStageTimeoutMs(stage),
            computeStageRetryWaitMs(1),
        );
        return;
    }

    if (stage === "analysis") {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ trackId: string; answer: string; error: string | null }>
        >(
            `SELECT ts."trackId", t."analysisStatus" AS answer, t."analysisError" AS error
               FROM "TrackStage" ts
               JOIN "Track" t ON t.id = ts."trackId"
              WHERE ts.stage = 'analysis'
                AND ts.status = 'working'
                AND t."analysisStatus" IN ('completed', 'failed', 'permanently_failed')`,
        );
        for (const row of rows) {
            if (row.answer === "completed") {
                await recordStageSuccess(row.trackId, "analysis", "analyzer", {
                    syncedFrom: "analysisStatus",
                    answer: "completed",
                });
            } else {
                await recordStageFailure(
                    row.trackId,
                    "analysis",
                    "analyzer",
                    new Error(row.error ?? "analysis failed"),
                    { syncedFrom: "analysisStatus", answer: row.answer },
                );
            }
        }
        return;
    }

    // embedding: the answer is a track_embeddings row, or a failed
    // vibeAnalysisStatus — but only an answer that POSTDATES the current
    // claim attempt. An embedding row left over from BEFORE the claim is
    // the previous answer still being readable (a force re-decide keeps it
    // so the vibe map keeps working), not the answer to this attempt;
    // syncing from it would close a re-opened question without anything
    // having re-answered it. A dead attempt (working past the stage
    // timeout with no fresh answer) re-queues like recording's.
    await prisma.$executeRawUnsafe(
        `UPDATE "TrackStage"
            SET status = 'pending',
                "nextRetryAt" = now() + ($3::double precision * interval '1 millisecond')
          WHERE stage = $1
            AND status = 'working'
            AND "startedAt" IS NOT NULL
            AND "startedAt" < now() - ($2::double precision * interval '1 millisecond')
            AND NOT EXISTS (
                SELECT 1 FROM track_embeddings te
                 WHERE te.track_id = "TrackStage"."trackId"
                   AND te.analyzed_at >= "TrackStage"."startedAt"
            )`,
        stage,
        getStageTimeoutMs(stage),
        computeStageRetryWaitMs(1),
    );
    const rows = await prisma.$queryRawUnsafe<
        Array<{ trackId: string; answer: string; error: string | null }>
    >(
        `SELECT ts."trackId",
                CASE WHEN te.track_id IS NOT NULL THEN 'completed'
                     ELSE t."vibeAnalysisStatus" END AS answer,
                t."vibeAnalysisError" AS error
           FROM "TrackStage" ts
           JOIN "Track" t ON t.id = ts."trackId"
           LEFT JOIN track_embeddings te
                  ON te.track_id = t.id AND te.analyzed_at >= ts."startedAt"
          WHERE ts.stage = 'embedding'
            AND ts.status = 'working'
            AND ts."startedAt" IS NOT NULL
            AND (te.track_id IS NOT NULL
                 OR (t."vibeAnalysisStatus" IN ('failed', 'permanently_failed')
                     AND (t."vibeAnalysisStatusUpdatedAt" IS NULL
                          OR t."vibeAnalysisStatusUpdatedAt" >= ts."startedAt")))`,
    );
    for (const row of rows) {
        if (row.answer === "completed") {
            await recordStageSuccess(row.trackId, "embedding", "clap", {
                syncedFrom: "track_embeddings",
                answer: "completed",
            });
        } else {
            await recordStageFailure(
                row.trackId,
                "embedding",
                "clap",
                new Error(row.error ?? "embedding failed"),
                { syncedFrom: "vibeAnalysisStatus", answer: row.answer },
            );
        }
    }

    await prisma.$executeRawUnsafe(
        `UPDATE "TrackStage"
            SET status = 'pending',
                "nextRetryAt" = now() + ($3::double precision * interval '1 millisecond')
          WHERE stage = $1
            AND status = 'working'
            AND "startedAt" < now() - ($2::double precision * interval '1 millisecond')`,
        stage,
        getStageTimeoutMs(stage),
        computeStageRetryWaitMs(1),
    );
}

async function dispatchStageWork(
    stage: StageName,
    work: StageWork[],
    add: (item: StageWork) => Promise<void>,
): Promise<number> {
    let owed = work.filter((w) => w.stage === stage);
    if (owed.length === 0) return 0;

    // The record owns the answer: sync any record still `working` whose
    // answer has already landed in the columns before deciding what to
    // hand out.
    await reconcileStaleStageRecords(stage);

    // Defense in depth: getNextWork already skips a paused source, but a
    // pause opened between the offer and the dispatch must not hand out
    // more work for the same refusing source.
    const source = owed[0].source
        ?? (stage === "analysis"
              ? "analyzer"
              : stage === "embedding"
                ? "clap"
                : stage === "fingerprint"
                  ? "fpcalc"
                  : "musicbrainz");
    if (await sourcePauseController.isPaused(source)) {
        logger.debug(
            `[Enrichment] ${stage}: source '${source}' paused — ${owed.length} owed attempts wait`,
        );
        return 0;
    }

    let queued = 0;
    // Defense in depth: getNextWork already skips tracks the scan flagged
    // missing, but a scan can flag a file between the offer and the
    // dispatch. Such an item is dropped here BEFORE the claim, so no attempt
    // is consumed and no failure is recorded for a file that is not there.
    if (owed.length > 0) {
        const missingIds = new Set(
            (
                await prisma.$queryRawUnsafe<Array<{ trackId: string }>>(
                    `SELECT id AS "trackId" FROM "Track"
                      WHERE "missingSince" IS NOT NULL AND id = ANY($1::text[])`,
                    owed.map((w) => w.trackId),
                )
            ).map((r) => r.trackId),
        );
        if (missingIds.size > 0) {
            logger.debug(
                `[Enrichment] ${stage}: dropping ${missingIds.size} item(s) flagged missing between offer and dispatch`,
            );
        }
        owed = owed.filter((w) => !missingIds.has(w.trackId));
        if (owed.length === 0) return 0;
    }
    for (const item of owed) {
        try {
            // Claim the record before queueing: `working` keeps the next cycle
            // from re-offering the same attempt, and the worker writes the
            // answer (`done`/`failed`) when it lands. A track with no record
            // yet has never been asked, so the claim creates one. The claim
            // sets the lease -- if the worker dies mid-attempt the record
            // comes due again when the lease elapses WITHOUT consuming an
            // attempt (a lost job is infra, not a failed answer);
            // each re-offer bumps `redelivered` instead, and three of those
            // close the record as "kept losing its worker" instead of
            // looping forever. A record already answered (`done`, or a
            // closed `failed`) is never claimed: the DO UPDATE's WHERE
            // clause enforces that.
            const claimed = await prisma.$queryRawUnsafe<Array<{ attempt: number; redelivered: number }>>(
                `INSERT INTO "TrackStage"
                    (id, "trackId", stage, status, source, attempt, retryable, evidence,
                     "startedAt", "nextRetryAt")
                 VALUES ($1, $2, $3, 'working', $4, 1, true, $5::jsonb,
                         now(), now() + make_interval(secs => $6))
                 ON CONFLICT ("trackId", stage) DO UPDATE
                    SET status = 'working',
                        "startedAt" = now(),
                        "nextRetryAt" = now() + make_interval(secs => $6),
                        "attempt" = CASE WHEN "TrackStage".status = 'working'
                                         THEN "TrackStage"."attempt"
                                         ELSE "TrackStage"."attempt" + 1 END,
                        "redelivered" = CASE WHEN "TrackStage".status = 'working'
                                              THEN "TrackStage"."redelivered" + 1
                                              ELSE 0 END
                  WHERE ("TrackStage".status IN ('pending', 'failed')
                         AND "TrackStage".retryable = true)
                     OR ("TrackStage".status = 'working'
                         AND "TrackStage"."nextRetryAt" IS NOT NULL
                         AND "TrackStage"."nextRetryAt" <= now()
                         AND "TrackStage"."redelivered" < ${STAGE_REDELIVERY_CAP})
                 RETURNING attempt, "redelivered"`,
                `${item.trackId}__${stage}`,
                item.trackId,
                stage,
                source,
                JSON.stringify({ question: item.jobKey }),
                STAGE_CLAIM_LEASE_MS / 1000,
            );
            if (claimed.length === 0) {
                // At the redelivery cap: close it with its evidence and
                // stop offering it, or a poison file loops every cycle
                // without ever consuming an attempt.
                const closed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                    `UPDATE "TrackStage"
                        SET status = 'failed',
                            retryable = false,
                            "lastErrorCode" = 'LOST_WORKER',
                            "lastErrorMessage" = 'Kept losing its worker (3 lease expiries, no answer)',
                            "failureClass" = 'INCONCLUSIVE',
                            "nextRetryAt" = NULL,
                            "finishedAt" = now()
                      WHERE "trackId" = $1 AND stage = $2
                        AND status = 'working'
                        AND "redelivered" >= ${STAGE_REDELIVERY_CAP}
                      RETURNING id`,
                    item.trackId,
                    stage,
                );
                if (closed.length > 0) {
                    logger.warn(
                        `[Enrichment] ${stage}: ${item.title} lost its worker ${STAGE_REDELIVERY_CAP} times — record closed until a human re-decides`,
                    );
                    const admin = await prisma.user.findFirst({
                        where: { role: "admin" },
                        select: { id: true },
                    });
                    if (admin) {
                        const { notificationService } = await import("../services/notificationService");
                        await notificationService
                            .create({
                                userId: admin.id,
                                type: "error",
                                title: `Enrichment: ${item.title} kept losing its worker`,
                                message: `${stage} was re-offered ${STAGE_REDELIVERY_CAP} times without an answer and stayed un-attempted; the record is closed until reopened from Settings > Enrichment.`,
                            })
                            .catch(() => undefined);
                    }
                }
                continue;
            }
            // Each redelivery gets its own jobId so a re-offer never reuses
            // the dead attempt's queue key; the attempt count stays put
            // because the failed delivery was never an answer.
            item.jobId = `${item.jobKey}-${claimed[0].attempt}-r${claimed[0].redelivered}`;

            await add(item);
            queued++;
        } catch (err) {
            // Release the claim: the push never happened, so the record must
            // stay due instead of parking in `working` past the lease.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage"
                    SET status = 'pending', "startedAt" = NULL, "nextRetryAt" = NULL
                  WHERE "trackId" = $1 AND stage = $2 AND status = 'working'`,
                item.trackId,
                stage,
            ).catch(() => undefined);
            logger.warn(
                `[Enrichment] Failed to queue ${stage} for ${item.trackId}: ${(err as Error).message}`,
            );
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} tracks for ${stage}`);
    }
    return queued;
}

/**
 * Phase 2 — the `recording` question (mood tags + ISRC).
 *
 * Replaces the record-driven re-queue, which re-selected every track whose
 * `enrichmentTags` was empty and re-added `track-<id>`. That re-asked an
 * already-answered question every tick, and the held `track-<id>` jobId let
 * one failed job park the track until restart.
 */
export async function executeMoodTagsPhase(): Promise<number> {
    const work = await getNextWork(TRACK_BATCH_SIZE);

    return dispatchStageWork("recording", work, async (item) => {
        await trackQueue.add(
            "enrich",
            { trackId: item.trackId, trackTitle: item.title },
            // Per-attempt jobId: a retry never reuses the key a failed job
            // still holds.
            { jobId: item.jobId },
        );
    });
}

/**
 * Phase 3 — the `analysis` question (Essentia decode + measure).
 *
 * Deletes two workarounds this replaces:
 *   - the LIVE dead-analyzer reset, which flushed `audio:analysis:queue` and
 *     flipped every `queued` row back to `pending` on a stale heartbeat;
 *   - the purgatory drain, which condemned past-cap tracks to
 *     `permanently_failed` (or "recovered" them to `completed`) by rewriting
 *     the column, so the answer in the record and the flag on the row could
 *     contradict each other.
 *
 * Both existed because nothing owned "this track, this question". The record
 * does now: a terminal answer is not offered again, a not-yet-due retry is not
 * offered yet, and a track whose file is missing keeps its flag and its true
 * state instead of being deleted or silently re-queued.
 */
export async function executeAudioPhase(): Promise<number> {
    const work = await getNextWork(TRACK_BATCH_SIZE);

    return dispatchStageWork("analysis", work, async (item) => {
        const redis = getRedis();
        await redis.rpush(
            STAGE_QUEUES.analysis,
            JSON.stringify({
                trackId: item.trackId,
                filePath: item.filePath,
                duration: item.duration, // Avoids file read in the analyzer
                jobId: item.jobId, // Per-attempt key; the analyzer logs it
            }),
        );
    });
}

const VIBE_SWEEP_BATCH_SIZE = 100;

/** Artist centroids to rebuild per cycle — bounds cycle time. */
const CENTROID_REBUILD_BATCH = 50;

/**
 * Catch-up pass for artist centroids (replaces the dead Last.fm similarity
 * source's data path). Tracks that gained a CLAP embedding since their
 * artist's last centroid computation — per-track embed completion between
 * cycles, or re-embedded rows after a rebuild-all — have a newer
 * analyzed_at than their artist's computedAt (or no centroid row at all),
 * so they surface here on the next cycle. Rides the existing enrichment
 * cycle; no new scheduler.
 */
async function rebuildStaleArtistCentroids(): Promise<void> {
    const stale = await prisma.$queryRaw<Array<{ artistId: string }>>`
        SELECT al."artistId"
        FROM "Track" t
        JOIN "Album" al ON al.id = t."albumId"
        JOIN track_embeddings te ON te.track_id = t.id
        LEFT JOIN artist_embeddings ae ON ae."artistId" = al."artistId"
        WHERE ae."artistId" IS NULL
           OR ae."computedAt" < te.analyzed_at
        GROUP BY al."artistId"
        LIMIT ${CENTROID_REBUILD_BATCH}
    `;
    if (stale.length === 0) return;

    let rebuilt = 0;
    let usable = 0;
    for (const { artistId } of stale) {
        try {
            const { trackCount } = await rebuildArtistCentroid(artistId);
            if (trackCount > 0) {
                rebuilt++;
                if (trackCount >= MIN_LOCAL_TRACKS) usable++;
            }
        } catch (err) {
            logger.warn(
                `[Enrichment] Centroid rebuild failed for artist ${artistId}:`,
                err,
            );
        }
    }
    logger.debug(
        `[Enrichment] Centroid catch-up: ${rebuilt}/${stale.length} artists rebuilt ` +
            `(${usable} with >=${MIN_LOCAL_TRACKS} tracks)`,
    );
}

/**
 * Phase 4 — the `embedding` question (CLAP).
 *
 * The global `audioInFlight` count is gone. It asked "is ANY track still
 * waiting or in flight?" and returned 0 for the whole phase if the answer was
 * yes, so one unreadable file — permanently `pending`, never analysable —
 * switched embedding off for the entire library forever. Gating is per track
 * now: `embedding` is offered only for tracks whose OWN `analysis` record is
 * `done`, which keeps the design's rule that an unanalysed track is never
 * embedded without letting one track's answer hold anyone else's.
 */
export async function executeVibePhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }

    // Rebuild artist centroids for artists whose source embeddings changed
    // since the last computation. Runs before the queueing below so tracks
    // embedded in earlier cycles are already covered while freshly queued
    // ones land next cycle.
    await rebuildStaleArtistCentroids();

    // Ensure vibe queue is resumed -- the audioCompletionSubscriber may have
    // paused it and the resume timer may have deferred (found audio still active)
    await vibeQueue.resume().catch(() => {});

    return dispatchStageWork("embedding", await getNextWork(VIBE_SWEEP_BATCH_SIZE), async (item) => {
        await vibeQueue.add(
            "embed",
            { trackId: item.trackId, filePath: item.filePath, duration: item.duration },
            // Per-attempt jobId, so a retry never lands on the dedup marker a
            // failed job still holds.
            { jobId: item.jobId },
        );
    });
}

export async function executePodcastRefreshPhase(): Promise<number> {
    const podcastCount = await prisma.podcast.count();
    if (podcastCount === 0) return 0;

    const ONE_HOUR = 60 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - ONE_HOUR);
    const stalePodcasts = await prisma.podcast.findMany({
        where: { lastRefreshed: { lt: staleThreshold } },
        select: { id: true, title: true },
    });

    if (stalePodcasts.length === 0) return 0;

    // BullMQ keeps the jobId dedup marker in Redis after a job settles -- for
    // BOTH completed and failed jobs. The original #81 fix cleaned only
    // "completed", which left failed jobs as permanent poison: one failed
    // refresh kept its `podcast-<id>` marker forever, so every later add() with
    // that jobId silently no-op'd and the podcast never refreshed again (a
    // single corrupt failed job took out all auto-refresh). Clean both states
    // so a failed refresh is retried rather than wedging the feed.
    try {
        await podcastQueue.clean(0, 0, "completed");
        await podcastQueue.clean(0, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] podcastQueue clean failed: ${(err as Error).message}`);
    }

    // Claim these podcasts by advancing lastRefreshed before queuing.
    // refreshPodcastFeed only advances lastRefreshed on success or a 304, so
    // without this an unreachable feed would keep matching the stale-window
    // query and be re-queued every cycle (seconds apart). Bumping up front
    // gives every outcome -- success, 304, or failure -- a full backoff window;
    // a successful refresh advances it again moments later.
    await prisma.podcast.updateMany({
        where: { id: { in: stalePodcasts.map((p) => p.id) } },
        data: { lastRefreshed: new Date() },
    });

    let queued = 0;
    for (const podcast of stalePodcasts) {
        try {
            await podcastQueue.add(
                "refresh",
                { podcastId: podcast.id, podcastTitle: podcast.title },
                { jobId: `podcast-${podcast.id}` }, // dedup -- safe now that completed jobs are cleaned above
            );
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue podcast ${podcast.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} podcast refreshes`);
    }
    return queued;
}

 /**
  * Get comprehensive enrichment progress
 *
 * Returns separate progress for:
 * - Artists & Track Tags: "Core" enrichment (must complete before app is fully usable)
 * - Audio Analysis: "Background" enrichment (runs in separate container, non-blocking)
 */
/**
 * Short-lived memo for the progress readout.
 *
 * The same figures are wanted by the orchestrator tick AND by
 * GET /enrichment/progress, which the settings UI polls every few seconds --
 * per open tab. Recomputing per caller meant the poll rate multiplied a
 * full-table aggregate. The worker's own cycle is never faster than
 * ENRICHMENT_INTERVAL_MS, so a memo of that length costs it nothing.
 */
let progressMemo: { at: number; value: EnrichmentProgress } | null = null;
const PROGRESS_MEMO_MS = 5 * 1000;

type EnrichmentProgress = Awaited<ReturnType<typeof computeEnrichmentProgress>>;

export async function getEnrichmentProgress(): Promise<EnrichmentProgress> {
    if (progressMemo && Date.now() - progressMemo.at < PROGRESS_MEMO_MS) {
        return progressMemo.value;
    }
    const value = await computeEnrichmentProgress();
    progressMemo = { at: Date.now(), value };
    return value;
}

/** Drop the memo so the next read reflects a write that just happened. */
export function invalidateEnrichmentProgress(): void {
    progressMemo = null;
}

async function computeEnrichmentProgress() {
    // Artist progress
    const artistCounts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        _count: true,
    });

    const artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
    const artistCompleted =
        (artistCounts.find((s) => s.enrichmentStatus === "completed")?._count || 0) +
        (artistCounts.find((s) => s.enrichmentStatus === "unresolvable")?._count || 0);
    const artistPending =
        artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;

    // Per-track stages are counted from `TrackStage`, not from the Track
    // columns and not from whether an answer row (`track_embeddings`,
    // `enrichmentTags`) exists: the record owns the answer, so the record is
    // what progress must read. A track with no record for a stage has never
    // been asked -- that is owed work, not finished work. One query per
    // stage, each a single LEFT JOIN from `Track`, so a missing record
    // counts as pending rather than vanishing from the totals.
    const stageCounts = await Promise.all(
        STAGE_ORDER.map(async (stage) => {
            const [row] = await prisma.$queryRaw<
                {
                    total: bigint;
                    completed: bigint;
                    working: bigint;
                    retryable_failed: bigint;
                    terminal_failed: bigint;
                }[]
            >`
                SELECT
                    count(*)                                                    AS total,
                    count(*) FILTER (WHERE ts.status = 'done')                AS completed,
                    count(*) FILTER (WHERE ts.status = 'working')             AS working,
                    count(*) FILTER (
                        WHERE ts.status = 'failed' AND ts.retryable
                    )                                                           AS retryable_failed,
                    count(*) FILTER (
                        WHERE ts.status = 'failed' AND NOT ts.retryable
                    )                                                           AS terminal_failed
                FROM "Track" t
                LEFT JOIN "TrackStage" ts
                         ON ts."trackId" = t.id AND ts.stage = ${stage}
            `;
            return {
                total: Number(row?.total ?? 0),
                completed: Number(row?.completed ?? 0),
                working: Number(row?.working ?? 0),
                retryableFailed: Number(row?.retryable_failed ?? 0),
                terminalFailed: Number(row?.terminal_failed ?? 0),
            };
        }),
    );
    const [recording, analysis, embedding, fingerprint] = stageCounts;

    // Queue depth is NOT derived from the records -- a claimed (`working`)
    // record covers a job that may still be sitting in the queue -- so the
    // analysis queue's true depth is read from the Redis list itself. The
    // embedding queue is BullMQ: a job waiting there is covered by its
    // claimed (`working`) record, so the record count IS the true state
    // for that stage and no queue call is needed.
    const audioQueueLength = await getRedis().llen("audio:analysis:queue");

    // A recording record whose fingerprint question is NOT settled is
    // blocked, not owed: the fingerprint → recording edge in
    // PREREQUISITE_STAGE keeps it unoffered, so counting it as pending work
    // would show the UI a number the sweep cannot act on (and, before the
    // gate existed, those blocked rows were re-polled forever). The same
    // settled condition the gate enforces — done, or closed as a permanent
    // failure — is what unblocks a row; everything else it could be is
    // waiting. Reported separately in trackTags: an open question, just not
    // an actionable one.
    const [recordingWaitingRow] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM "TrackStage" ts
         WHERE ts.stage = 'recording'
           AND (ts.status = 'pending'
                OR (ts.status = 'failed' AND ts.retryable
                    AND (ts."nextRetryAt" IS NULL
                         OR ts."nextRetryAt" <= now())))
           AND NOT EXISTS (
               SELECT 1 FROM "TrackStage" prev
                WHERE prev."trackId" = ts."trackId"
                  AND prev.stage = 'fingerprint'
                  AND (prev.status = 'done'
                       OR (prev.status = 'failed'
                           AND NOT prev.retryable))
           )
    `;
    const recordingWaiting = Number(recordingWaitingRow?.waiting ?? 0);

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const recordingPending =
        recording.total -
        recording.completed -
        recording.terminalFailed -
        recording.retryableFailed -
        recording.working;
    const analysisPending =
        analysis.total -
        analysis.completed -
        analysis.terminalFailed -
        analysis.retryableFailed -
        analysis.working;
    const embeddingPending =
        embedding.total -
        embedding.completed -
        embedding.terminalFailed -
        embedding.retryableFailed -
        embedding.working;
    const fingerprintPending =
        fingerprint.total -
        fingerprint.completed -
        fingerprint.terminalFailed -
        fingerprint.retryableFailed -
        fingerprint.working;
    const coreComplete =
        artistPending === 0 &&
        recordingPending === 0 &&
        // A waiting recording is not a done answer: core completion must not
        // fire while questions are parked behind the fingerprint gate.
        recordingWaiting === 0;

    return {
        // Where every number below comes from -- the settings UI and the
        // state-service counters must not claim a column-derived figure.
        source: "TrackStage",

        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            failed:
                artistCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count || 0,
            progress:
                artistTotal > 0 ?
                    Math.round((artistCompleted / artistTotal) * 100)
                :   0,
        },
        trackTags: {
            total: recording.total,
            enriched: recording.completed,
            // Actionable now: the sweep can offer these.
            pending: recordingPending - recordingWaiting,
            // Open but blocked behind the fingerprint gate — the sweep
            // cannot act on them until the fingerprint question settles.
            waiting: recordingWaiting,
            progress:
                recording.total > 0 ?
                    Math.round(
                        (recording.completed / recording.total) * 100,
                    )
                :   0,
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: analysis.total,
            completed: analysis.completed,
            pending: analysisPending,
            queued: audioQueueLength,
            processing: analysis.working,
            failed: analysis.retryableFailed,
            permanentlyFailed: analysis.terminalFailed,
            progress:
                analysis.total > 0 ?
                    Math.round((analysis.completed / analysis.total) * 100)
                :   0,
            isBackground: true, // Flag to indicate this runs separately
        },

        // CLAP embeddings (for vibe similarity search)
        clapEmbeddings: {
            total: embedding.total,
            completed: embedding.completed,
            pending: embeddingPending,
            processing: embedding.working,
            failed: embedding.retryableFailed + embedding.terminalFailed,
            progress:
                embedding.total > 0 ?
                    Math.round((embedding.completed / embedding.total) * 100)
                :   0,
            isBackground: true,
        },

        // AcoustID fingerprints (local fpcalc; covers EVERY track — the
        // dedupe column wants the fingerprint whether or not any lookup
        // matched).
        fingerprints: {
            total: fingerprint.total,
            completed: fingerprint.completed,
            pending: fingerprintPending,
            processing: fingerprint.working,
            failed: fingerprint.retryableFailed + fingerprint.terminalFailed,
            progress:
                fingerprint.total > 0 ?
                    Math.round((fingerprint.completed / fingerprint.total) * 100)
                :   0,
            isBackground: true,
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete &&
            analysisPending === 0 &&
            audioQueueLength === 0 &&
            analysis.working === 0 &&
            embeddingPending === 0 &&
            embedding.working === 0 &&
            fingerprintPending === 0 &&
            fingerprint.working === 0,
    };
}

/**
 * Trigger an immediate enrichment cycle (non-blocking)
 * Used when new tracks are added and we want to collect mood tags right away
 * instead of waiting for the 30s background interval
 */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // A trigger runs one cycle; it does not lift a stop or a pause an
    // operator set: the deadline is the truth, the records
    // wait, and only "Run Enrichment" / "Full Enrichment" restart the
    // scheduler. Clearing stop here is what let an auto-trigger after a
    // scan silently restart a stopped engine.

    // Set flag to bypass the minimum interval check (does NOT bypass isRunning —
    // a concurrent cycle will still cause this call to return an empty result)
    immediateEnrichmentRequested = true;
    invalidateEnrichmentProgress();
    bumpScheduleToFastInterval();

    return runEnrichmentCycle(false);
}


