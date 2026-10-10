/**
 * Missed webhooks recovered from the history a real Lidarr returned (recorded missing-tracks and
 * bundle runs), on the real test database: a missed grab links its job once under the webhook's own
 * event id; a delivered event is left alone; an import-incomplete record counts no attempt; the read
 * reaches back to the oldest active download; a two-album grab is recovered as one grab listing both;
 * each import carries the files history shows for its album; file history is read only for new imports.
 */

import { prisma } from "../../utils/db";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { recoverMissedEvents } from "../lidarrHistoryRecovery";

const USER = "history_recovery_user";
const recorded = loadScenario("missing-tracks");
const grab = recorded.webhooks.find((w) => w.eventType === "Grab")!.payload;
const historyRead = recorded.exchanges.find((e) => e.path.includes("/history/since") && e.path.includes("eventType=7"))!;

let lidarr: LidarrReplay;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
    lidarr = await startLidarrReplay(recorded);
    lidarr.at(historyRead.seq);
});

afterEach(async () => {
    await lidarr.close();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const waitingJob = (createdAt = new Date()) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Brad Sucks - Guess Who’s a Mess", type: "album", status: "processing",
            targetMbid: grab.albums[0].mbId, lidarrAlbumId: grab.albums[0].id, createdAt, attempts: 1,
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        },
    });

it("links the job to a grab whose webhook never arrived, under the webhook's event id, once", async () => {
    const job = await waitingJob();

    expect(await recoverMissedEvents(lidarr.url, "key")).toBe(2);
    expect(await recoverMissedEvents(lidarr.url, "key")).toBe(0);

    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.lidarrRef).toBe(grab.downloadId);
    expect(row.attempts).toBe(1);
    expect(await prisma.webhookEvent.findUnique({ where: { eventId: `lidarr-Grab-${grab.downloadId}` } })).not.toBeNull();
});

it("leaves an event the webhook already delivered alone", async () => {
    await prisma.webhookEvent.create({
        data: { eventId: `lidarr-Grab-${grab.downloadId}`, source: "lidarr", eventType: "Grab", payload: grab, processed: true },
    });
    expect(await recoverMissedEvents(lidarr.url, "key")).toBe(1);
});

it("reads back to the oldest active download when it started before the newest event", async () => {
    const started = new Date(Date.now() - 3 * 3600_000);
    await waitingJob(started);
    await prisma.webhookEvent.create({
        data: { eventId: "lidarr-newest", source: "lidarr", eventType: "Test", payload: {}, processed: true },
    });

    await recoverMissedEvents(lidarr.url, "key");

    const read = lidarr.asked.find((a) => a.path.includes("/history/since"))!;
    const since = new Date(new URLSearchParams(read.path.split("?")[1]).get("date")!);
    expect(since.getTime()).toBeLessThanOrEqual(started.getTime());
});

describe("a bundle's history", () => {
    const bundle = loadScenario("bundle");
    const bundleGrab = bundle.webhooks.find((w) => w.eventType === "Grab")!.payload;
    const lastSeq = Math.max(...bundle.exchanges.map((e) => e.seq));
    const stored = (id: string) => prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: id } });

    // The setup download that brought the owned album was imported, and its
    // events stored, before the bundle; the live server had them already.
    const earlier = (type: number) =>
        (bundle.exchanges.find((e) => e.path.includes("/history/since") && e.path.includes(`eventType=${type}&`))!.response as any[])
            .filter((record) => record.downloadId !== bundleGrab.downloadId);

    beforeEach(async () => {
        await lidarr.close();
        lidarr = await startLidarrReplay(bundle);
        lidarr.at(lastSeq);
        for (const [eventType, record] of [
            ...earlier(1).map((r) => ["Grab", r] as const),
            ...earlier(8).map((r) => ["Download", r] as const),
        ]) {
            const eventId = eventType === "Grab" ? `lidarr-Grab-${record.downloadId}` : `lidarr-Download-${record.downloadId}-${record.albumId}`;
            await prisma.webhookEvent.upsert({
                where: { eventId },
                create: { eventId, source: "lidarr", eventType, payload: {}, processed: true },
                update: {},
            });
        }
    });

    it("recovers the grab once, listing every album, and each import with that album's own files", async () => {
        await recoverMissedEvents(lidarr.url, "key");

        const recoveredGrab = (await stored(`lidarr-Grab-${bundleGrab.downloadId}`)).payload as any;
        expect(recoveredGrab.albums.map((a: any) => a.id).sort()).toEqual(bundleGrab.albums.map((a: any) => a.id).sort());
        for (const album of bundleGrab.albums) {
            const recorded = bundle.webhooks.find((w) => w.eventType === "Download" && w.payload.album.id === album.id)!.payload;
            const recovered = (await stored(`lidarr-Download-${bundleGrab.downloadId}-${album.id}`)).payload as any;
            expect(recovered.trackFiles).toHaveLength(recorded.trackFiles.length);
        }
    });

    it("reads Lidarr's file history only for imports it has not stored yet", async () => {
        await recoverMissedEvents(lidarr.url, "key");
        const reads = () => lidarr.asked.filter((a) => a.path.includes("eventType=3")).length;
        const before = reads();

        await recoverMissedEvents(lidarr.url, "key");
        expect(reads()).toBe(before);
    });
});
