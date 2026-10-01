/**
 * A failing job is completed instead when another job already brought in the
 * same album: same release-group id, or the same artist and title. Any other
 * completed job is not a duplicate.
 */

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_dup_user";
const completeFromDuplicate = (job: unknown): Promise<boolean> =>
    (simpleDownloadManager as any).completeFromDuplicate(job);

const job = (id: string, status: string, targetMbid: string | null, artistName: string, albumTitle: string) =>
    prisma.downloadJob.create({
        data: {
            id,
            userId: USER,
            subject: `${artistName} - ${albumTitle}`,
            type: "album",
            status,
            targetMbid,
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

it("completes from a job with the same artist and title in any case", async () => {
    await job("sdm_dup_twin", "completed", "rg-elsewhere", " low ", "TRUST");
    const failing = await job("sdm_dup_me", "processing", null, "Low", "Trust");

    expect(await completeFromDuplicate(failing)).toBe(true);
});

it("does not match on an empty title", async () => {
    await job("sdm_dup_twin", "completed", "rg-elsewhere", "Low", "");
    const failing = await job("sdm_dup_me", "processing", null, "Low", "");

    expect(await completeFromDuplicate(failing)).toBe(false);
});
