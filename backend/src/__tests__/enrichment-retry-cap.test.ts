/**
 * Retry discipline on the stage record.
 *
 * Rules under test:
 *   - A temporary error writes `failed` with `retryable = true` and
 *     `nextRetryAt = now + increasing wait` — the waits get longer per
 *     attempt, they do not stay flat.
 *   - Nothing is retried past the configured cap (3 attempts, matching
 *     `DEFAULT_JOB_OPTIONS.attempts` and `EnrichmentFailure.maxRetries`):
 *     at the cap the record goes `retryable = false` and the dequeuer
 *     stops offering it.
 *   - A question that has an answer (`done`, or a terminal `failed`) is
 *     never re-offered — the record owns the answer.
 *
 * These drive the real record functions and the real dequeuer against this
 * checkout's own test DB; they fail on the current code, where nothing ever
 * writes `nextRetryAt`/`retryable` and claimed records sit in `working`
 * forever.
 *
 * Run with:
 *   npx jest src/__tests__/enrichment-retry-cap.test.ts --forceExit --maxWorkers=1
 */

import { prisma } from "../utils/db";
import {
    computeStageRetryWaitMs,
    getNextWork,
    recordStageFailure,
    recordStageSuccess,
    STAGE_RETRY_CAP,
} from "../workers/unifiedEnrichment";
import { sourcePauseController } from "../services/sourcePauseController";

const PREFIX = "retrycap";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                attempt = EXCLUDED.attempt,
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status, "musicbrainz",
        opts.attempt ?? 0, opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify({ probe: "mb-search", rc: 1 }),
    );
}

async function seedTrack(
    trackId: string,
    opts: { recording?: { status: string; attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending",
            enrichmentTags: [],
        },
    });
    await putStage(trackId, "recording", opts.recording?.status ?? "pending", {
        attempt: opts.recording?.attempt ?? 0,
        retryable: opts.recording?.retryable ?? true,
        nextRetryAt: opts.recording?.nextRetryAt ?? null,
    });
}

async function getRecord(trackId: string, stage: string): Promise<any> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function seedFkChain(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Retry Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Retry Album", primaryType: "Album" },
    });
}

beforeEach(async () => {
    await wipe();
    await seedFkChain();
    // Never let a pause left over from another case hide the work under test.
    await sourcePauseController.resume("musicbrainz");
});

afterAll(async () => {
    await wipe();
    await sourcePauseController.resume("musicbrainz");
    await prisma.$disconnect();
});

describe("increasing waits for temporary errors", () => {
    it("computeStageRetryWaitMs grows with the attempt count", () => {
        const w1 = computeStageRetryWaitMs(1);
        const w2 = computeStageRetryWaitMs(2);
        const w3 = computeStageRetryWaitMs(3);
        expect(w2).toBeGreaterThan(w1);
        expect(w3).toBeGreaterThan(w2);
    });

    it("first failure parks the record until now + wait(1), second until now + wait(2)", async () => {
        const trackId = id("temp");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("connection reset by peer"));
        const first = await getRecord(trackId, "recording");
        expect(first.status).toBe("failed");
        expect(first.retryable).toBe(true);
        expect(first.attempt).toBe(1);
        expect(new Date(first.nextRetryAt).getTime()).toBeGreaterThan(Date.now() - 1000);

        // Second failure: the wait must be LONGER than the first, not the same.
        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("connection reset by peer"));
        const second = await getRecord(trackId, "recording");
        expect(second.attempt).toBe(2);
        expect(new Date(second.nextRetryAt).getTime()).toBeGreaterThan(
            new Date(first.nextRetryAt).getTime(),
        );
    });

    it("the record is not offered before its nextRetryAt and is offered after", async () => {
        const notDue = id("notdue");
        const due = id("due");
        await seedTrack(notDue, {
            recording: { status: "failed", attempt: 1, nextRetryAt: new Date(Date.now() + 10 * 60_000) },
        });
        await seedTrack(due, {
            recording: { status: "failed", attempt: 1, nextRetryAt: new Date(Date.now() - 60_000) },
        });
        // Both tracks' fingerprint questions are SETTLED, so the recording
        // rows are actually offered when due (the fingerprint → recording
        // gate holds them while the question is open).
        await putStage(due, "fingerprint", "done");
        await putStage(notDue, "fingerprint", "done");

        const offered = await getNextWork(10);
        const offeredIds = offered.filter((w) => w.stage === "recording").map((w) => w.trackId);
        expect(offeredIds).not.toContain(notDue);
        expect(offeredIds).toContain(due);
    });
});

describe("no retry past the cap", () => {
    it("the cap is 3 attempts", () => {
        expect(STAGE_RETRY_CAP).toBe(3);
    });

    it("attempts 1 and 2 stay retryable; the third attempt closes the record", async () => {
        const trackId = id("cap");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        expect((await getRecord(trackId, "recording")).retryable).toBe(true);

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        expect((await getRecord(trackId, "recording")).retryable).toBe(true);

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        const closed = await getRecord(trackId, "recording");
        expect(closed.status).toBe("failed");
        expect(closed.retryable).toBe(false);

        // A closed record is never re-offered, and a later failure call
        // cannot resurrect it. (The track's other questions — e.g. its
        // never-asked fingerprint — are separate records and may still be
        // owed; the closed one is not.)
        const offered = await getNextWork(10);
        expect(
            offered.filter((w) => w.stage === "recording").map((w) => w.trackId),
        ).not.toContain(trackId);

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        expect((await getRecord(trackId, "recording")).retryable).toBe(false);
    });
});

describe("a question with an answer is never re-offered", () => {
    it("a done record is not offered even when the Track column still looks pending", async () => {
        const trackId = id("answered");
        await seedTrack(trackId, { recording: { status: "done", attempt: 1 } });

        const offered = await getNextWork(10);
        // The recording question is answered — it must not come back. (The
        // analysis record does not exist yet, so analysis is legitimately
        // due; the answered question here is the recording one.)
        expect(
            offered
                .filter((w) => w.stage === "recording")
                .map((w) => w.trackId),
        ).not.toContain(trackId);
    });

    it("recordStageSuccess writes done with its evidence and source", async () => {
        const trackId = id("success");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        await recordStageSuccess(trackId, "recording", "file_tag", {
            recordingMbid: "mb-123",
            reason: "tag carried the recording id",
        });

        const rec = await getRecord(trackId, "recording");
        expect(rec.status).toBe("done");
        expect(rec.source).toBe("file_tag");
        expect(rec.evidence).toMatchObject({ recordingMbid: "mb-123" });
        expect(rec.finishedAt).toBeTruthy();

        const offered = await getNextWork(10);
        expect(
            offered
                .filter((w) => w.stage === "recording")
                .map((w) => w.trackId),
        ).not.toContain(trackId);
    });
});
