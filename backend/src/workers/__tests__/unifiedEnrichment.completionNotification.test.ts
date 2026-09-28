/**
 * One completion alert per user per run (invariant 8).
 *
 * A live run proved the old shape: every completion wrote BOTH
 * "Enrichment Completed with Errors" and "Enrichment Complete" in the same
 * millisecond, per user. A run that finished with failures gets the error
 * alert alone; a clean run gets the system alert. This drives the real
 * send function against the real Notification table and counts the rows.
 *
 * Run with:
 *   npx jest src/workers/__tests__/unifiedEnrichment.completionNotification.test.ts --maxWorkers=1
 */

import { prisma } from "../../utils/db";
import { sendCompletionNotifications } from "../../workers/unifiedEnrichment";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const PREFIX = "cnp";
const id = (n: string) => `${PREFIX}_${n}`;

const progress = {
    artists: { completed: 3 },
    trackTags: { enriched: 12 },
    audioAnalysis: { completed: 12 },
} as never;

async function makeUsers(): Promise<void> {
    await prisma.user.create({
        data: { id: id("admin"), username: id("admin"), passwordHash: "x", role: "admin", tokenVersion: 0 },
    });
    await prisma.user.create({
        data: { id: id("plain"), username: id("plain"), passwordHash: "x", role: "user", tokenVersion: 0 },
    });
}

/** The alert counts are global by design, so the slate must be globally
 *  clean for the clean-run case; this checkout's per-worker test DB is
 *  the slate, and every suite re-seeds what it needs in its own setup. */
async function clearAllFailures(): Promise<void> {
    await prisma.enrichmentFailure.deleteMany({});
    await prisma.trackStage.deleteMany({ where: { status: "failed" } });
}

async function notifications(userId: string): Promise<Array<{ type: string; title: string }>> {
    return prisma.notification.findMany({
        where: { userId },
        select: { type: true, title: true },
        orderBy: { createdAt: "asc" },
    });
}

async function wipe(): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.enrichmentFailure.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
}

beforeEach(async () => {
    await wipe();
    await clearAllFailures();
    await makeUsers();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("one completion alert per user", () => {
    it("a clean run sends exactly one system alert per user", async () => {
        await sendCompletionNotifications(progress);

        for (const user of [id("admin"), id("plain")]) {
            const rows = await notifications(user);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual({ type: "system", title: "Enrichment Complete" });
        }
    });

    it("a run with failures sends exactly one error alert per user, and no system alert", async () => {
        await prisma.enrichmentFailure.create({
            data: {
                entityType: "artist",
                entityId: id("artist-1"),
                entityName: "A Failed Artist",
                errorMessage: "MusicBrainz 503",
            },
        });

        await sendCompletionNotifications(progress);

        for (const user of [id("admin"), id("plain")]) {
            const rows = await notifications(user);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual({ type: "error", title: "Enrichment Completed with Errors" });
        }
    });
});
