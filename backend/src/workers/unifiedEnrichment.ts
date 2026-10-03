/**
 * The enrichment scheduler: artist metadata, per-track identification,
 * audio analysis, CLAP embeddings, fingerprints and podcast refresh, driven
 * from TrackStage records on a self-rescheduling cycle.
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
    type IdentityTags,
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
import { titlesAgree } from "../services/albumIdentity";
import { hasRealMbid } from "../services/artistIdentity";
import type { Outcome } from "../utils/outcome";

/** The three kinds that failed to answer anything, as opposed to `Absent`. */
type FailureOutcome = Extract<
    Outcome<unknown>,
    { kind: "rateLimited" | "transient" | "permanent" }
>;
import { sourcePauseController } from "../services/sourcePauseController";
import { distributedLock } from "../utils/distributedLock";
import { embeddingsDeferredForGpu } from "../services/gpuRuntime";

// ── Per-track stage queue ────────────────────────────────────────────────

/**
 * The four questions owed per track: which recording it is, its audio
 * analysis, its CLAP embedding, and its local AcoustID fingerprint. Each
 * stage waits only on what PREREQUISITE_STAGE declares for the same track.
 */
export type StageName = "recording" | "analysis" | "embedding" | "fingerprint";

export const STAGE_ORDER: readonly StageName[] = [
    "recording",
    "analysis",
    "embedding",
    "fingerprint",
] as const;

/**
 * "output": the dependent stage reads the prerequisite's answer, so only `done` unblocks it.
 * "settled": the question only needs answering, either `done` or closed as a
 * permanent failure; a retryable failure or an open question does not count.
 */
export type StageWaitKind = "output" | "settled";

export interface StagePrerequisite {
    stage: StageName;
    wait: StageWaitKind;
}

/**
 * What each stage actually reads from another stage for the same track. This
 * is the only place stages wait on each other; nothing polls at runtime.
 */
export const PREREQUISITE_STAGE: Record<StageName, StagePrerequisite | null> = {
    // The AcoustID step reads the stored fingerprint. A fingerprint closed as a
    // permanent failure never produces one, so then the step is skipped and the
    // skip is written into this stage's evidence.
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
 * Exactly one producer per queue, so the same work cannot be queued twice under
 * different job keys. Fingerprinting runs fpcalc inline and has no queue.
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

/** Lease re-offers do not consume attempts; this many close the record so a
 * poison file cannot loop forever. */
const STAGE_REDELIVERY_CAP = 3;

/**
 * The work owed for each stage: records with no answer or a due retry, whose
 * prerequisite has answered for the same track. Selection reads TrackStage,
 * never Track status columns, so one failed track cannot hold the rest back.
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

        // A paused source gets no work; each attempt would only burn its timeout.
        // Fingerprinting's source is the local fpcalc binary, which nothing pauses.
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

        // A just-enabled GPU runtime gets a head start on the embedding stage
        // only: a "yes" in the release window must reach the pipeline before
        // the library is embedded on CPU. Bounded by a hard timeout inside
        // the check, so a stuck download defers nothing forever.
        if (stage === "embedding" && (await embeddingsDeferredForGpu(now))) {
            logger.debug(
                "[Enrichment] 'embedding' deferred: GPU runtime installing",
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
// A failed job keeps its jobId, and the phases skip an entity whose jobId is
// still held, so a failure backs off until this grace cleans the job. Completed
// jobs are cleaned immediately so a reset entity can be queued again.
const FAILED_JOB_RETRY_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * One enrichment cycle at a time across processes, so a second backend cannot
 * double-dispatch stage records. The TTL outlives the longest real cycle, so a
 * crash releases the lock by expiry.
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
 * Resume the BullMQ workers, the vibe queuing bridge, the Python analysis gate
 * and the pub/sub resume signal. Leaves the local pause/stop flags alone, so
 * it can run from the cycle and from hang recovery without undoing a user's stop.
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
 * Per-stage budget, sized to the stage's work rather than the track's length:
 * identification is a few HTTP calls, analysis and embedding decode a 90 s
 * window, fingerprinting is bounded by fpcalc's own timeout. A `working` record
 * older than its budget is a dead attempt and is re-offered without costing one.
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
 * How many answers a stage may have in flight: measured drain rate times the
 * record's patience, so no job waits in a queue past its lease and runs twice.
 * Recording is limited by MusicBrainz's ~1 request/s; fingerprinting is uncapped.
 */
export const STAGE_IN_FLIGHT_CAP: Partial<Record<StageName, number>> = {
    recording: 30,
    analysis: 200,
    embedding: 16,
};

/**
 * Dispatches before a record closes as terminal: one ask plus three retries.
 * BullMQ's `attempts` counts retries inside one job; this counts whole dispatches.
 */
export const STAGE_RETRY_CAP = 4;

/** Waits before retries 1-3 (1 min, 10 min, 1 h), then the record closes, so a
 * short outage is ridden out and a lasting refusal stops being asked. */
const RETRY_LADDER_MS = [60_000, 600_000, 3_600_000];

export function computeStageRetryWaitMs(attempt: number): number {
    return RETRY_LADDER_MS[Math.min(Math.max(1, attempt), 3) - 1];
}

/** Answer a track's stage `done` by `source`, with evidence; idempotent. */
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
                "startedAt" = COALESCE("TrackStage"."startedAt", now()),
                "finishedAt" = now()
          WHERE "TrackStage".status <> 'blocked'`,
        `${trackId}__${stage}`,
        trackId,
        stage,
        source,
        JSON.stringify(evidence ?? { reason: "answered" }),
    );
    // The backend is the only writer of the status columns; the stage record
    // is the truth and these are its display mirror.
    if (stage === "embedding") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = 'completed',
                    "vibeAnalysisError" = NULL,
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            trackId,
        );
    } else if (stage === "analysis") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = 'completed',
                    "analysisError" = NULL,
                    "analysisStartedAt" = NULL
              WHERE id = $1`,
            trackId,
        );
    }
}

/**
 * Record a failed attempt. A rate limit pauses only that source and parks the
 * record `pending` without consuming an attempt. Any other error writes `failed`
 * with its class and a retry time, and closes the record at STAGE_RETRY_CAP.
 * A closed record is never reopened here.
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

        // A question still waiting 24 h after it first parked raises its source's
        // alert once and stays pending. The marker lives in the record's evidence,
        // so restarts do not raise it again.
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
            const { notificationService } = await import("../services/notificationService");
            await notificationService
                .notifyAdmins({
                    type: "system",
                    title: `Enrichment waiting on ${source}`,
                    message: `Some tracks have waited on ${source} for over 24 h. They stay pending until its rate limit lifts.`,
                    groupKey: `${WAITING_KEY_PREFIX}${source}`,
                })
                .catch(() => undefined);
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
        if (stage === "embedding") {
            // Parked on a rate limit, not failed: the mirror says pending.
            await prisma.$executeRawUnsafe(
                `UPDATE "Track"
                    SET "vibeAnalysisStatus" = 'pending',
                        "vibeAnalysisError" = $2,
                        "vibeAnalysisStatusUpdatedAt" = now()
                  WHERE id = $1`,
                trackId,
                message,
            );
        }
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

    // A `working` record's claim already counted this attempt; anything else moves
    // to the next one (at least 1). Terminal classes close the record at once;
    // INCONCLUSIVE stays retryable until the cap.
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
                "startedAt" = COALESCE("TrackStage"."startedAt", now()),
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
    if (stage === "embedding") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = $2,
                    "vibeAnalysisError" = $3,
                    "vibeAnalysisRetryCount" = $4,
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            trackId,
            retryable ? "failed" : "permanently_failed",
            message.slice(0, 500),
            attempt,
        );
    } else if (stage === "analysis") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = $2,
                    "analysisError" = $3,
                    "analysisRetryCount" = $4,
                    "analysisStartedAt" = NULL
              WHERE id = $1`,
            trackId,
            retryable ? "failed" : "permanently_failed",
            message.slice(0, 500),
            attempt,
        );
    }
}

/** Record "the sources have nothing" as a `done` answer with evidence of what
 * was asked, so a correct "no" does not burn the retry ladder. */
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
                "startedAt" = COALESCE("TrackStage"."startedAt", now()),
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
 * Close embedding records whose analysis record closed, since the embedding
 * can never be built. Idempotent; runs each cycle and never touches `blocked`
 * records or ones already closed.
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
                    "startedAt" = COALESCE(dep."startedAt", now()),
                    "finishedAt" = COALESCE(dep."finishedAt", now()),
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
 * Record an external call's failure by its Outcome kind: rate limited parks with
 * no attempt consumed, permanent closes with `code`, transient takes the retry
 * ladder. `answered`/`absent` are answers and are the caller's to handle.
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
                    "startedAt" = COALESCE("TrackStage"."startedAt", now()),
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

/** Ask a source within the stage budget. A blown budget or a throw comes back
 * as `transient` with the real cause, never as "nothing found". */
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

     // No startup sweep is needed: a job that died mid-flight is a `working` record
     // whose lease comes due on its own.

     // A stored `paused` is an operator instruction and survives a restart. Any
     // other leftover state (`running`, `stopping`) is crash residue and starts fresh.
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
        // Keep workers halted and the analysis gate armed `paused` even if the key was
        // lost, or queued work would drain through the operator's pause.
        haltVibeQueuing();
        await enrichmentStateService.holdGateClosed();
        await Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(
            () => {},
        );
    } else {
        // A previous process's stop() leaves the analysis gate `paused` in Redis, and
        // the analyzer would stay gated while this worker reports running. Resume the
        // real infrastructure before claiming `running`.
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

/** Schedule the next cycle. Self-rescheduling, so an overrunning cycle cannot
 * pile up pending ticks. */
function scheduleNextEnrichmentCycle(delayMs: number = ENRICHMENT_INTERVAL_MS) {
    enrichmentInterval = setTimeout(async () => {
        // The timer has fired; clear the spent handle so bumpScheduleToFastInterval does
        // not mistake it for a pending one and start a second chain.
        enrichmentInterval = null;
        let didWork = false;
        // How long to wait before the next cycle. Set here and used by the single
        // scheduling call in the finally block, because scheduling from more than one
        // place spawns parallel timer chains -- see the note there.
        let nextDelayMs: number | null = null;
        try {
            const result = await runEnrichmentCycle(false);

            // A cycle that declined to run has learned nothing about whether
            // there is work, so backing off for a minute on the strength of it
            // is wrong. Come back as soon as the floor allows.
            if (result.declined) {
                const waitedFor = Date.now() - lastRunTime;
                const untilAllowed = Math.max(0, MIN_INTERVAL_MS - waitedFor);
                nextDelayMs = Math.max(untilAllowed, ENRICHMENT_INTERVAL_MS);
                return;
            }

            // Every phase that queued something counts as work.
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
            // The only scheduling call, in a finally so an early return or a rejected cycle
            // still re-arms the chain; scheduling from two places would start a second
            // chain. `enrichmentStopped` is how stopUnifiedEnrichmentWorker ends it.
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
 * Pull the pending timer forward to the fast interval, so the cycle after a
 * user-triggered run is not stuck on the idle delay.
 */
function bumpScheduleToFastInterval(): void {
    // No pending timer means stopped, or a cycle is running and its finally will
    // arm the next one; arming another here would leak a second chain. Scan
    // completions call this without awaiting, so that overlap is common.
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

/** Where a claimed attempt is handed to its queue, shared by the phases and
 * "Retry failed and blocked" so each queue keeps one producer. */
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
        // The fingerprint pool runs fpcalc at machine concurrency and returns at once,
        // so no stage or cycle waits on the sweep. dispatchStageWork owns the claim;
        // runFingerprintStageWork owns the answer.
        runFingerprintInPool(item);
    },
};

/**
 * Answer one fingerprint question with local fpcalc and store the fingerprint
 * whatever identification later finds, since dedupe uses it too. A stored
 * fingerprint is reused, never recomputed. Failures go through recordStageFailure.
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
 * The fingerprint pool: up to availableParallelism() fpcalc runs at once, each
 * bounded by the stage timeout, so one hung run stalls nothing. A timeout is
 * recorded like any other fingerprint failure.
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

/** Resolves once every fingerprint run handed to the pool has settled. The
 * engine never waits on this; it is for tests and observability. */
export async function waitForFingerprintWork(): Promise<void> {
    while (fingerprintWork.size > 0) {
        await Promise.allSettled([...fingerprintWork]);
    }
}

/** Offer the fingerprint stage its own batch, so busier stages cannot starve it. */
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
 * Reopen recording records that answered no-match without asking AcoustID
 * (their evidence carries the skip marker). Once a new fingerprint can land,
 * that no-match is no longer honest. A no-match that did ask AcoustID stays
 * closed, and the attempt count is left as is: one more ask, then it closes again.
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
 * "Retry failed and blocked": offer every record that is owed or due a retry.
 * Nothing is reset; `done` and terminal answers stay closed. Recording no-matches
 * that never asked AcoustID are reopened first, and the fingerprint gate holds
 * them until the retried fingerprint lands.
 */
export async function retryFailedAndBlocked(
    limit = TRACK_BATCH_SIZE,
): Promise<StageWork[]> {
    await reopenRecordingsThatNeverAskedAcoustid();

    // Each stage gets its own window, so one press reopens every owed question.
    const work: StageWork[] = [];
    for (const stage of STAGE_ORDER) {
        const stageWork = await getNextWork(limit, stage);
        work.push(...stageWork);
        await dispatchStageWork(stage, stageWork, STAGE_PRODUCERS[stage]);
    }

    return work;
}

/**
 * "Re-decide everything": reopen every stage question, answered or not, for
 * when the answers are known to be wrong. A track that already has a
 * recordingMbid keeps its recording answer. No answer rows are deleted.
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

    // Reopening fingerprints makes no-matches that never asked AcoustID stale;
    // reopen those too, including tracks the loop skipped for having an MBID.
    reopened += await reopenRecordingsThatNeverAskedAcoustid();

    // Mirror the reopen onto the Track columns the analyzer claims and the UI reads;
    // a column still saying `completed` would let reconcileStaleStageRecords close
    // the reopened record again before anything answered it.
    await prisma.track.updateMany({
        where: { analysisStatus: { not: "pending" } },
        data: {
            analysisStatus: "pending",
            analysisStartedAt: null,
            analysisRetryCount: 0,
        },
    });

    logger.debug(`[Enrichment] Re-deciding everything: ${reopened} stage records reopened`);

    // No dispatch here: the next cycle offers the reopened records. Claiming them
    // now would hide the reopened state and park unconsumed claims until the lease.

    return { reopened };
}

const ENRICHMENT_FAILURES_KEY = "enrichment-failures";
const WAITING_KEY_PREFIX = "enrichment-waiting:";

/** Remove each source's waiting alert once no alerted record still waits on it. */
export async function syncWaitingAlerts(): Promise<void> {
    const { notificationService } = await import("../services/notificationService");
    const alerts = await prisma.notification.findMany({
        where: { groupKey: { startsWith: WAITING_KEY_PREFIX } },
        distinct: ["groupKey"],
        select: { groupKey: true },
    });
    if (alerts.length === 0) return;
    const waiting = await prisma.$queryRawUnsafe<Array<{ source: string }>>(
        `SELECT DISTINCT source FROM "TrackStage"
          WHERE status = 'pending' AND "lastErrorCode" = 'RATE_LIMITED'
            AND evidence->>'waitingAlerted' = 'true'`,
    );
    const still = new Set(waiting.map((r) => `${WAITING_KEY_PREFIX}${r.source}`));
    for (const { groupKey } of alerts) {
        if (groupKey && !still.has(groupKey)) await notificationService.resolve(groupKey);
    }
}

/** Keep one alert per admin naming what enrichment could not finish. It changes
 * only when the failure counts change and is removed once nothing has failed. */
export async function syncEnrichmentFailureAlert(): Promise<void> {
    const { notificationService } = await import("../services/notificationService");
    // TrackStage-backed for track stages, so it matches the failures list in Settings.
    const failureCounts = await enrichmentFailureService.getFailureCounts();
    if (failureCounts.total === 0) {
        await notificationService.resolve(ENRICHMENT_FAILURES_KEY);
        return;
    }

    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [
        failureCounts.artist > 0 && count(failureCounts.artist, "artist", "artists"),
        failureCounts.track > 0 && count(failureCounts.track, "track", "tracks"),
        failureCounts.audio > 0 && count(failureCounts.audio, "audio analysis", "audio analyses"),
        failureCounts.vibe > 0 && count(failureCounts.vibe, "vibe embedding", "vibe embeddings"),
        failureCounts.scan > 0 && count(failureCounts.scan, "fingerprint", "fingerprints"),
        failureCounts.podcast > 0 && count(failureCounts.podcast, "podcast", "podcasts"),
    ].filter(Boolean);

    await notificationService.notifyAdmins({
        type: "error",
        title: "Enrichment failures",
        message: `${count(failureCounts.total, "item", "items")} could not be enriched: ${parts.join(", ")}.`,
        metadata: { href: "/settings#enrichment-failures" },
        groupKey: ENRICHMENT_FAILURES_KEY,
    });
}

async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
    /** Queued for embedding this cycle. */
    vibeQueued?: number;
    /** Fingerprint answers landed this cycle (local fpcalc, inline). */
    fingerprintsQueued?: number;
    /**
     * Set when the cycle declined to run, as opposed to running and finding nothing.
     * An empty cycle backs off; a declined one should come back promptly.
     */
    declined?: "already-running" | "too-soon";
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Handle stopping state: transition to idle before checking isPaused.
    // This must run first because stop sets both isStopping AND isPaused.
    // If we checked isPaused first, we'd return early and never clear isStopping.
    if (isStopping) {
        // No stop-cleanup reset: stopping does not edit answers. The record
        // owns the attempt, and flipping `processing` rows back to `pending`
        // here would re-ask questions the stage records have already answered.
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
        // State says running but this process is paused: resume the real infrastructure,
        // not just the flag. A missed resume message would otherwise leave workers
        // paused and the analyzer gated while state reports running.
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

    // The flag above covers this process; the lock covers others, so two processes
    // never offer the same records.
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
        // Close dependents of closed prerequisites first, so they never sit `pending`.
        await closeOrphanedDependents();
        await syncWaitingAlerts();

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
        // Computed ONCE per cycle; everything below reads this copy.
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

            const stateBeforeNotify = await enrichmentStateService.getState();

            // Precompute the vibe map projection once the library is stable (the completion
            // notice not yet sent). Running it every tick would delete the cache keys before
            // UMAP finished, and the cache would never settle.
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
                    await syncEnrichmentFailureAlert();

                    await enrichmentStateService.updateState({ completionNotificationSent: true });
                } catch (error) {
                    logger.error("[Enrichment] Failed to update the failure alert:", error);
                }
            }
        }
    } catch (error) {
        logger.error("[Enrichment] Cycle error:", error);

        // A failure of the enrichment system itself. Per-track failures live only in
        // TrackStage; this ledger is for entities without a stage record.
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
 * True when the fingerprint stage closed as a permanent failure: the question
 * is settled as "never", so identification skips AcoustID and records the skip.
 * Open fingerprint states never reach here; the prerequisite gate holds them.
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
 * Find our file in the release's tracklist: a row whose title agrees and whose
 * length is within 2.5 s, else the first row whose title agrees. Duration tells
 * apart two files with one title; a wrong length does not lose the song.
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

/** Fill the album's original year, label and top five genres, each only where
 * still blank, so scan tags and manual edits are never overwritten. */
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

/**
 * Answer one track's `recording` question and write it to the record. Runs only
 * once the fingerprint question is settled; waiting is the gate's job.
 */
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

    // Identification order: the file's own identity tags; the album's catalogue
    // (one cached fetch shared by every track); the title-checked name search;
    // then AcoustID. A tagged ISRC is asked first; MusicBrainz not knowing it falls
    // through like no identifier. Genres go to TrackGenre only; moods come from analysis.
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

    const trackRef = {
        id: track.id,
        title: track.title,
        filePath: track.filePath,
        duration: track.duration,
    };

    // The per-track fallback: name search, then AcoustID. Reached by tracks with no
    // identifier and by tracks whose ISRC MusicBrainz does not know. Mutates the
    // ladder state above.
    const runPerTrackFallback = async (
        tags: IdentityTags | null,
    ): Promise<void> => {
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

        // AcoustID for whatever is still unidentified. The prerequisite gate guarantees
        // the fingerprint question is settled: use the stored fingerprint, or skip and
        // record the skip when it closed as a permanent failure. A rate limit pauses
        // the asking, not the sweep.
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
    };

    if (!track.isrc) {
        needsIsrc = true;
        // (a) File tags first — read once, no network.
        const tags = await readIdentityTags(trackRef);
        if (tags?.recordingMbid) {
            recordingMbid = tags.recordingMbid;
            answerSource = "file_tag";
            if (tags.fingerprint) fingerprintToStore = tags.fingerprint;
        } else {
            // The album's catalogue: two requests per album, cached for its other tracks.
            // Only real MusicBrainz ids can be fetched; placeholder ids stay per-track.
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

            // Name search then AcoustID, only for tracks the catalogue did not answer. If
            // the catalogue call itself failed, defer on that cause instead of re-asking a
            // failing host.
            if (!catalogueAnswer && !failedAsk) {
                await runPerTrackFallback(tags);
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
        } else {
            // No recording carries this ISRC in MusicBrainz — not an
            // answer to the question. The per-track fallback runs, and
            // whatever recording answers it owes a fresh ISRC: the
            // stored code is not on it.
            needsIsrc = true;
            await runPerTrackFallback(null);
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

    if (failedAsk) {
        // The source failed to answer: park the record with the real cause and leave
        // the track row alone.
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
            // Every source asked said "nothing": close `done` with evidence naming who was
            // asked, rather than burning the retry ladder.
            await recordStageAbsent(
                track.id,
                "recording",
                "acoustid",
                {
                    reason:
                        "sources have no recording for this track",
                    asked: track.isrc
                        ? ["isrc", "mb-search", "acoustid"]
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

    // Every null path above returned; TypeScript will not narrow the
    // mutable let inside the fetch callbacks below, so the answered id
    // continues as a const.
    const mbid = recordingMbid;

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
            // Genres live in the genre tables only.
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
                () => musicBrainzService.getRecordingIsrc(mbid),
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
            () => musicBrainzService.getRecordingGenres(mbid),
            timeoutMs,
            `Timeout fetching MB genres: ${track.title}`,
        );
        if (genres.kind === "answered") {
            const topGenres = genres.value.genres
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map((g) => g.name);
            // Genres live in the genre tables only.
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
            // Enqueue and mark "enriching" only when the jobId slot is free. A failed job
            // inside the grace still holds it, so add() would no-op and the artist would sit
            // "enriching" until restart.
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
 * Sync `working` records with the columns the Python consumers write, since they
 * never write the record. An answered column closes the record; an attempt past
 * its stage timeout goes back to `pending` without consuming an attempt.
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
            `SELECT ts."trackId",
                    CASE WHEN t."analyzedAt" >= ts."startedAt" THEN 'completed'
                         ELSE t."analysisStatus" END AS answer,
                    t."analysisError" AS error
               FROM "TrackStage" ts
               JOIN "Track" t ON t.id = ts."trackId"
              WHERE ts.stage = 'analysis'
                AND ts.status = 'working'
                AND ts."startedAt" IS NOT NULL
                AND (t."analyzedAt" >= ts."startedAt"
                     OR (t."analysisStatus" IN ('failed', 'permanently_failed')
                         AND (t."analysisStartedAt" IS NULL
                              OR t."analysisStartedAt" >= ts."startedAt")))`,
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

    // Only an embedding answer newer than the current claim counts. An older row is
    // the previous answer kept readable for the vibe map; syncing from it would
    // close a reopened question unanswered.
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

/**
 * Claim the owed records for `stage` and queue one job per track: the only
 * producer for each stage's queue.
 */
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

    // Dispatch only as deep as the stage can drain within the record's lease; the
    // rest stays `pending` for the next offer.
    const cap = STAGE_IN_FLIGHT_CAP[stage];
    if (cap !== undefined) {
        const working = await prisma.trackStage.count({
            where: { stage, status: "working" },
        });
        if (working >= cap) return 0;
        if (owed.length > cap - working) owed = owed.slice(0, cap - working);
    }

    for (const item of owed) {
        try {
            // Claim before queueing, so the next cycle does not re-offer the attempt. The
            // lease re-offers a record whose worker died without consuming an attempt; each
            // re-offer bumps `redelivered`, which closes the record at the cap. The WHERE
            // clause never claims an answered or closed record.
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

/** The `recording` question (identity and genres), offered from the records. */
export async function executeMoodTagsPhase(): Promise<number> {
    // Each stage gets its own share of the offer, so a recording backlog cannot
    // starve analysis and embedding.
    const work = await getNextWork(TRACK_BATCH_SIZE, "recording");

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
 * The `analysis` question (Essentia decode and measure), offered from the
 * records. Nothing here flushes the analysis list or rewrites columns, which
 * would let a queued job and its record disagree.
 */
export async function executeAudioPhase(): Promise<number> {
    // Its own window, so analysis overlaps network-bound identification.
    const work = await getNextWork(TRACK_BATCH_SIZE, "analysis");

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
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = 'processing',
                    "analysisStartedAt" = now()
              WHERE id = $1`,
            item.trackId,
        );
    });
}

const VIBE_SWEEP_BATCH_SIZE = 100;

/** Artist centroids to rebuild per cycle — bounds cycle time. */
const CENTROID_REBUILD_BATCH = 50;

/**
 * Rebuild centroids for artists with tracks embedded after the artist's
 * centroid was computed (or with no centroid yet). Runs inside the cycle.
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
 * The `embedding` question (CLAP), offered only for tracks whose own analysis
 * is `done`, so one unanalysable file cannot hold back anyone else's.
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

    // Its own window, sized by the in-flight cap to the CLAP workers.
    const work = await getNextWork(VIBE_SWEEP_BATCH_SIZE, "embedding");
    return dispatchStageWork("embedding", work, async (item) => {
        await vibeQueue.add(
            "embed",
            { trackId: item.trackId, filePath: item.filePath, duration: item.duration },
            // Per-attempt jobId, so a retry never lands on the dedup marker a
            // failed job still holds.
            { jobId: item.jobId },
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = 'processing',
                    "vibeAnalysisStartedAt" = now(),
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            item.trackId,
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

    // BullMQ keeps the jobId marker after completed and failed jobs alike; a kept
    // failed job would make every later add() for that podcast a silent no-op. Clean both.
    try {
        await podcastQueue.clean(0, 0, "completed");
        await podcastQueue.clean(0, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] podcastQueue clean failed: ${(err as Error).message}`);
    }

    // Advance lastRefreshed before queuing so every outcome, including an
    // unreachable feed, gets a full backoff window instead of re-queuing each cycle.
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

/** Memo for the progress readout, polled by the scheduler and every open
 * settings tab; it lives no longer than a cycle interval. */
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

/** Enrichment progress per stage, read from the records and the analysis queue. */
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

    // Per-stage counts come from TrackStage, one LEFT JOIN from Track per stage, so
    // a track with no record counts as owed rather than vanishing from the totals.
    const stageCounts = await Promise.all(
        STAGE_ORDER.map(async (stage) => {
            const [row] = await prisma.$queryRaw<
                {
                    total: bigint;
                    completed: bigint;
                    working: bigint;
                    retryable_failed: bigint;
                    terminal_failed: bigint;
                    file_missing: bigint;
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
                          AND ts."failureClass" IS DISTINCT FROM 'FILE_MISSING'
                    )                                                           AS terminal_failed,
                    count(*) FILTER (
                        WHERE ts.status = 'failed' AND NOT ts.retryable
                          AND ts."failureClass" = 'FILE_MISSING'
                    )                                                           AS file_missing
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
                fileMissing: Number(row?.file_missing ?? 0),
            };
        }),
    );
    const [recording, analysis, embedding, fingerprint] = stageCounts;

    // The analysis queue is a Redis list, so its depth is read from the list. The
    // embedding queue's jobs are all covered by `working` records.
    const audioQueueLength = await getRedis().llen("audio:analysis:queue");

    // Recording records whose fingerprint is not settled are blocked, not owed:
    // the gate keeps them unoffered. Reported separately so the UI does not show
    // work the sweep cannot do. Missing files are counted as `waitingMissing`.
    const [recordingWaitingRow] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM "TrackStage" ts
          JOIN "Track" t ON t.id = ts."trackId"
         WHERE t."missingSince" IS NULL
           AND ts.stage = 'recording'
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

    // Questions about missing files are closed by the scan as FILE_MISSING and
    // reported per stage as `waitingMissing`; the scan reopens them if the file returns.

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const recordingPending =
        recording.total -
        recording.completed -
        recording.terminalFailed -
        recording.retryableFailed -
        recording.working -
        recording.fileMissing;
    const analysisPending =
        analysis.total -
        analysis.completed -
        analysis.terminalFailed -
        analysis.retryableFailed -
        analysis.working -
        analysis.fileMissing;
    const embeddingPending =
        embedding.total -
        embedding.completed -
        embedding.terminalFailed -
        embedding.retryableFailed -
        embedding.working -
        embedding.fileMissing;
    const fingerprintPending =
        fingerprint.total -
        fingerprint.completed -
        fingerprint.terminalFailed -
        fingerprint.retryableFailed -
        fingerprint.working -
        fingerprint.fileMissing;
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
            // Owed again when a scan finds the file; nothing the sweep can do meanwhile.
            waitingMissing: recording.fileMissing,
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
            waitingMissing: analysis.fileMissing,
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
            waitingMissing: embedding.fileMissing,
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
            waitingMissing: fingerprint.fileMissing,
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

/** Run one enrichment cycle now, without waiting for the timer. Non-blocking. */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // A trigger runs one cycle and never lifts an operator's stop or pause; only
    // "Run Enrichment" and "Full Enrichment" restart the scheduler.

    // Set flag to bypass the minimum interval check (does NOT bypass isRunning —
    // a concurrent cycle will still cause this call to return an empty result)
    immediateEnrichmentRequested = true;
    invalidateEnrichmentProgress();
    bumpScheduleToFastInterval();

    return runEnrichmentCycle(false);
}


