/**
 * The cleanup cron deletes each finished kind past its own retention period.
 */

import { runDataCleanup } from "../dataCleanup";
import { prisma } from "../../utils/db";

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        webhookEvent: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        discoveryBatch: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
    },
}));

describe("Data Cleanup", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("should clean up old download jobs", async () => {
        (prisma.downloadJob.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 5 });

        const result = await runDataCleanup();

        expect(result.downloadJobs).toBe(5);
        expect(result.total).toBe(5);
        expect(prisma.downloadJob.deleteMany).toHaveBeenCalledWith({
            where: {
                status: { in: ["completed", "failed"] },
                completedAt: {
                    lt: expect.any(Date),
                },
            },
        });
    });

    it("should clean up old webhook events", async () => {
        (prisma.webhookEvent.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 10 });

        const result = await runDataCleanup();

        expect(result.webhookEvents).toBe(10);
        expect(result.total).toBe(10);
        expect(prisma.webhookEvent.deleteMany).toHaveBeenCalledWith({
            where: {
                processed: true,
                createdAt: {
                    lt: expect.any(Date),
                },
            },
        });
    });

    it("should clean up old discovery batches", async () => {
        (prisma.discoveryBatch.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 3 });

        const result = await runDataCleanup();

        expect(result.discoveryBatches).toBe(3);
        expect(result.total).toBe(3);
        expect(prisma.discoveryBatch.deleteMany).toHaveBeenCalledWith({
            where: {
                status: "completed",
                completedAt: {
                    lt: expect.any(Date),
                },
            },
        });
    });

    it("should clean up all types in one run", async () => {
        (prisma.downloadJob.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 15 });
        (prisma.webhookEvent.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 42 });
        (prisma.discoveryBatch.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 2 });

        const result = await runDataCleanup();

        expect(result.downloadJobs).toBe(15);
        expect(result.webhookEvents).toBe(42);
        expect(result.discoveryBatches).toBe(2);
        expect(result.total).toBe(59);
    });

    it("should use correct retention periods", async () => {
        await runDataCleanup();

        const now = new Date();
        /** Whole days between now and a deleteMany call's cutoff. */
        const daysRetained = (mock: jest.Mock, field: "completedAt" | "createdAt") => {
            const cutoff = mock.mock.calls[0][0].where[field].lt as Date;
            return Math.round((now.getTime() - cutoff.getTime()) / (1000 * 60 * 60 * 24));
        };

        expect(daysRetained(prisma.downloadJob.deleteMany as jest.Mock, "completedAt")).toBe(30);
        expect(daysRetained(prisma.webhookEvent.deleteMany as jest.Mock, "createdAt")).toBe(30);
        expect(daysRetained(prisma.discoveryBatch.deleteMany as jest.Mock, "completedAt")).toBe(60);
    });
});
