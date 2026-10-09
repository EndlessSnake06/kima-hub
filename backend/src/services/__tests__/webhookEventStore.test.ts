/**
 * The webhook event store on the real test database: each event is stored
 * once, a repeat comes back as the stored row, Lidarr events are keyed by
 * type and download id, and processing state, retries and cleanup act on the rows.
 */

import { prisma } from "../../utils/db";
import { webhookEventStore } from "../webhookEventStore";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const SOURCE = "store-test";
const grab = (downloadId: string) => ({ eventType: "Grab", downloadId, albums: [{ id: 4, title: "Guess Who’s a Mess" }] });

const clean = () => prisma.webhookEvent.deleteMany({ where: { source: { in: [SOURCE, "lidarr"] }, eventId: { contains: "store-test" } } });

beforeEach(clean);
afterAll(async () => {
    await clean();
    await prisma.webhookEvent.deleteMany({ where: { source: SOURCE } });
    await closeEngineConnections();
});

it("stores a new event once and hands a repeat back as the stored row", async () => {
    const first = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test" });
    const again = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test" });

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    expect(await prisma.webhookEvent.count({ where: { source: SOURCE } })).toBe(1);
});

it("keys a Lidarr event by its type and download id, and an import by its album too", async () => {
    const grabbed = await webhookEventStore.storeEvent("lidarr", "Grab", grab("store-test-dl-1"));
    const imported = (album: number) =>
        webhookEventStore.storeEvent("lidarr", "Download", { eventType: "Download", downloadId: "store-test-dl-1", album: { id: album } });
    const first = await imported(4);
    const second = await imported(5);
    const repeat = await webhookEventStore.storeEvent("lidarr", "Grab", grab("store-test-dl-1"));

    expect(grabbed.event.eventId).toBe("lidarr-Grab-store-test-dl-1");
    expect(first.event.eventId).toBe("lidarr-Download-store-test-dl-1-4");
    expect(second.created).toBe(true);
    expect((await imported(4)).created).toBe(false);
    expect(repeat.created).toBe(false);
});

it("keys any other event by a hash of its payload", async () => {
    const { event } = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test hash" });
    expect(event.eventId).toMatch(/^store-test-[0-9a-f]{16}$/);
});

it("records processing, failures and retries on the row", async () => {
    const { event } = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test state" });

    await webhookEventStore.markFailed(event.id, "Lidarr timed out");
    await webhookEventStore.markFailed(event.id, "Lidarr timed out again");
    let row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.retryCount).toBe(2);
    expect(row.error).toBe("Lidarr timed out again");
    expect((await webhookEventStore.getUnprocessedEvents(SOURCE, 3)).map((e) => e.id)).toEqual([event.id]);
    expect(await webhookEventStore.getUnprocessedEvents(SOURCE, 2)).toEqual([]);

    await webhookEventStore.markProcessed(event.id, "job-1");
    row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.processed).toBe(true);
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.correlationId).toBe("job-1");
    expect(await webhookEventStore.getUnprocessedEvents(SOURCE)).toEqual([]);
});

it("leaves an event stored moments ago to the route still processing it", async () => {
    const { event } = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test fresh" });
    expect(await webhookEventStore.getUnprocessedEvents(SOURCE, 3, 60_000)).toEqual([]);
    expect((await webhookEventStore.getUnprocessedEvents(SOURCE, 3, 0)).map((e) => e.id)).toEqual([event.id]);
});

it("deletes events older than the cutoff whether processed or not", async () => {
    const old = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test old" });
    const fresh = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note: "store-test new" });
    await prisma.webhookEvent.update({ where: { id: old.event.id }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });

    expect(await webhookEventStore.cleanupOldEvents(30)).toBeGreaterThanOrEqual(1);
    expect(await prisma.webhookEvent.findUnique({ where: { id: old.event.id } })).toBeNull();
    expect(await prisma.webhookEvent.findUnique({ where: { id: fresh.event.id } })).not.toBeNull();
});
