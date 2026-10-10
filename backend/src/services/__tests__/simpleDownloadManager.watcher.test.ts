/**
 * The watcher's own steps against Lidarr's state at recorded moments, on the
 * real test database: an album Lidarr holds in full completes its job and is
 * scanned in; a job whose download Lidarr replaced follows the new download for
 * the same album; one whose download left the queue unimported fails after three
 * cycles; and a request made while Lidarr cannot be reached waits for it.
 */

import { prisma } from "../../utils/db";
import { loadScenario, startLidarrReplay, type LidarrReplay, type LidarrScenario } from "../../__tests__/helpers/lidarrReplay";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { lidarrService } from "../lidarr";
import { scanQueue } from "../../workers/queues";
import type { LidarrAlbum, LidarrQueueItem } from "../../types/lidarr";

jest.setTimeout(60_000);

const USER = "sdm_watch_user";
const junkRun = loadScenario("junk-removed");

let lidarr: LidarrReplay;

const queueReads = (run: LidarrScenario) =>
    run.exchanges.filter((e) => e.path.startsWith("/api/v1/queue?")) as { seq: number; response: { records: LidarrQueueItem[] } }[];

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    lidarr = await startLidarrReplay(junkRun);
    await useLidarr(lidarr.url);
});

afterEach(async () => {
    await lidarr.close();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (data: Record<string, unknown>) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Brad Sucks", type: "album", status: "processing", attempts: 1,
            metadata: { artistName: "Brad Sucks" }, ...data,
        },
    });

const row = (id: string) => prisma.downloadJob.findUniqueOrThrow({ where: { id } });

it("completes a job whose album Lidarr holds in full and asks for a library scan", async () => {
    const albums = junkRun.exchanges.find((e) => e.path === "/api/v1/album")!;
    const whole = (albums.response as LidarrAlbum[]).find((a) => (a.statistics?.percentOfTracks ?? 0) >= 100)!;
    const partial = (albums.response as LidarrAlbum[]).find((a) => (a.statistics?.percentOfTracks ?? 0) < 100)!;
    lidarr.at(albums.seq);
    const done = await job({ targetMbid: whole.foreignAlbumId, lidarrAlbumId: whole.id, lidarrRef: "DL-A" });
    const waiting = await job({ targetMbid: partial.foreignAlbumId, lidarrAlbumId: partial.id, lidarrRef: "DL-B" });

    await simpleDownloadManager.reconcileWithLidarr(await lidarrService.getReconciliationSnapshot());

    expect((await row(done.id)).status).toBe("completed");
    expect((await row(waiting.id)).status).toBe("processing");
    expect(await scanQueue.getJob(`scan-${done.id}`)).toBeDefined();
});

it("follows the download Lidarr queued for the same album when the job's own left the queue", async () => {
    const withItem = queueReads(junkRun).find((e) => e.response.records.length > 0)!;
    const next = withItem.response.records[0];
    // The watcher reads the queue, then the album list; the snapshot needs both.
    lidarr.at(withItem.seq + 1);
    const following = await job({ lidarrAlbumId: next.albumId, lidarrRef: "DL-GONE" });

    await simpleDownloadManager.syncWithLidarrQueue(await lidarrService.getReconciliationSnapshot());

    const r = await row(following.id);
    expect(r.lidarrRef).toBe(next.downloadId);
    expect((r.metadata as any).previousDownloadIds).toEqual(["DL-GONE"]);
});

it("fails a job whose download left Lidarr's queue unimported, after three cycles", async () => {
    const empty = queueReads(junkRun).find((e) => e.response.records.length === 0)!;
    lidarr.at(empty.seq + 1);
    const gone = await job({ lidarrAlbumId: 999_999, lidarrRef: "DL-GONE" });

    for (let cycle = 1; cycle <= 3; cycle++) {
        await simpleDownloadManager.syncWithLidarrQueue(await lidarrService.getReconciliationSnapshot());
        expect((await row(gone.id)).status).toBe(cycle < 3 ? "processing" : "failed");
    }
    expect((await row(gone.id)).error).toBe("Lidarr removed the download without importing it");
});

it("holds a request while Lidarr cannot be reached, instead of failing it", async () => {
    await lidarr.close();
    await useLidarr("http://127.0.0.1:9");
    const held = await job({ status: "pending", targetMbid: "16f30346-886a-3144-9377-cbfceb32fd34", metadata: { artistName: "Brad Sucks", albumTitle: "Out of It" } });

    await simpleDownloadManager.startDownload(held.id, "Brad Sucks", "Out of It", "16f30346-886a-3144-9377-cbfceb32fd34");

    const r = await row(held.id);
    expect(r.status).toBe("pending");
    expect((r.metadata as any).waitingForLidarr).toBe(true);
    lidarr = await startLidarrReplay(junkRun);
});
