/**
 * A failing job is completed instead when another job brought in the same
 * album, by its release-group id, while it was running. One completed before
 * it started proves nothing now; another album id is another album; a job
 * without an id has no duplicate.
 */

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_dup_user";
const completeFromDuplicate = (job: unknown): Promise<boolean> =>
    (simpleDownloadManager as any).completeFromDuplicate(job);

const job = (id: string, status: string, targetMbid: string | null, artistName: string, albumTitle: string, completedAt?: Date) =>
    prisma.downloadJob.create({
        data: {
            id,
            userId: USER,
            subject: `${artistName} - ${albumTitle}`,
            type: "album",
            status,
            targetMbid,
            completedAt: completedAt ?? (status === "completed" ? new Date() : null),
            createdAt: status === "completed" ? undefined : new Date(Date.now() - 60_000),
            metadata: { artistName, albumTitle },
        },
    });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

afterEach(() => prisma.downloadJob.deleteMany({ where: { userId: USER } }));

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("ignores a completed job for another album", async () => {
    await job("sdm_dup_other", "completed", "rg-other", "Interpol", "Antics");
    const failing = await job("sdm_dup_me", "processing", "rg-me", "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(false);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_dup_me" } })).status).toBe("processing");
});

it("completes from a job with the same release-group id", async () => {
    await job("sdm_dup_other", "completed", "rg-other", "Interpol", "Antics");
    await job("sdm_dup_twin", "completed", "rg-me", "Low", "Trust (Deluxe)");
    const failing = await job("sdm_dup_me", "processing", "rg-me", "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(true);
    const done = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_dup_me" } });
    expect(done.status).toBe("completed");
    expect((done.metadata as any).mergedWithJob).toBe("sdm_dup_twin");
});

it("does not complete from a job with the same artist and title but another album id", async () => {
    await job("sdm_dup_twin", "completed", "rg-elsewhere", "Low", "Trust");
    const failing = await job("sdm_dup_me", "processing", "rg-me", "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(false);
});

it("never completes a job that has no album id", async () => {
    await job("sdm_dup_twin", "completed", null, "Low", "Trust");
    const failing = await job("sdm_dup_me", "processing", null, "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(false);
});

it("does not count a copy that arrived before the job started", async () => {
    await job("sdm_dup_twin", "completed", "rg-me", "Low", "Trust", new Date(Date.now() - 3600_000));
    const failing = await job("sdm_dup_me", "processing", "rg-me", "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(false);
});
