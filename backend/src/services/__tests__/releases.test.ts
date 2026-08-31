/**
 * What closing the window means.
 *
 * 1.10.1 asks nothing, so none of this is exercised by the shipped catalog yet.
 * It is the contract v2's social and commons opt-ins will run on, and the whole
 * point is that silence is recorded as a decline rather than left absent for
 * later code to interpret — so it is pinned before anything depends on it.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { dismissRelease, hasOptedIn, pendingReleases, setChoice } from "../releases";
import * as catalog from "../releases/catalog";

jest.mock("../../utils/db", () => {
    const tx = {
        releaseChoice: { findUnique: jest.fn(), upsert: jest.fn() },
        releaseAcknowledgement: { upsert: jest.fn() },
    };
    return {
        prisma: {
            releaseAcknowledgement: { findMany: jest.fn(), upsert: tx.releaseAcknowledgement.upsert },
            releaseChoice: { findUnique: jest.fn(), upsert: jest.fn() },
            $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
            __tx: tx,
        },
    };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prisma } = require("../../utils/db");
const tx = prisma.__tx;

/** A release that asks two things, so dismissal has something to settle. */
const ASKING = {
    version: "9.9.9",
    title: "Test release",
    summary: "",
    date: "2026-01-01",
    items: [
        { kind: "note" as const, key: "n", title: "", body: "" },
        {
            kind: "choice" as const,
            key: "social.network",
            title: "",
            body: "",
            defaultValue: false as const,
        },
        {
            kind: "choice" as const,
            key: "commons.contribute",
            title: "",
            body: "",
            defaultValue: false as const,
        },
    ],
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(catalog, "findRelease").mockReturnValue(ASKING);
    tx.releaseChoice.findUnique.mockResolvedValue(null);
    prisma.releaseAcknowledgement.findMany.mockResolvedValue([]);
});

describe("dismissRelease", () => {
    it("records a decision for every unanswered choice, not an absence", async () => {
        const out = await dismissRelease("u1", "9.9.9");
        expect(out.recordedDefaults).toEqual(["social.network", "commons.contribute"]);
        expect(tx.releaseChoice.upsert).toHaveBeenCalledTimes(2);
    });

    it("records those decisions as off, and as decided by dismissal", async () => {
        await dismissRelease("u1", "9.9.9");
        for (const call of tx.releaseChoice.upsert.mock.calls) {
            expect(call[0].create).toMatchObject({
                enabled: false,
                decidedBy: ChoiceDecidedBy.DISMISSED,
            });
        }
    });

    it("leaves an explicit yes alone -- closing the window is not a retraction", async () => {
        tx.releaseChoice.findUnique.mockImplementation(async ({ where }: never) => {
            const key = (where as { userId_key: { key: string } }).userId_key.key;
            return key === "social.network" ? { decidedBy: ChoiceDecidedBy.EXPLICIT } : null;
        });
        const out = await dismissRelease("u1", "9.9.9");
        expect(out.recordedDefaults).toEqual(["commons.contribute"]);
        expect(tx.releaseChoice.upsert).toHaveBeenCalledTimes(1);
    });

    it("marks the release acknowledged", async () => {
        await dismissRelease("u1", "9.9.9");
        expect(tx.releaseAcknowledgement.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: { userId: "u1", version: "9.9.9" } }),
        );
    });

    it("does nothing for a version it does not know", async () => {
        jest.spyOn(catalog, "findRelease").mockReturnValue(undefined);
        const out = await dismissRelease("u1", "0.0.0");
        expect(out.recordedDefaults).toEqual([]);
        expect(tx.releaseAcknowledgement.upsert).not.toHaveBeenCalled();
    });
});

describe("setChoice", () => {
    it("marks a deliberate answer as explicit, either way", async () => {
        await setChoice({ userId: "u1", version: "9.9.9", key: "social.network", enabled: true });
        expect(prisma.releaseChoice.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ enabled: true, decidedBy: ChoiceDecidedBy.EXPLICIT }),
            }),
        );
        await setChoice({ userId: "u1", version: "9.9.9", key: "social.network", enabled: false });
        expect(prisma.releaseChoice.upsert).toHaveBeenLastCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({ enabled: false, decidedBy: ChoiceDecidedBy.EXPLICIT }),
            }),
        );
    });
});

describe("hasOptedIn", () => {
    it("is false when never asked", async () => {
        prisma.releaseChoice.findUnique.mockResolvedValue(null);
        expect(await hasOptedIn("u1", "commons.contribute")).toBe(false);
    });

    it("is false when the row says off, however it got there", async () => {
        prisma.releaseChoice.findUnique.mockResolvedValue({ enabled: false });
        expect(await hasOptedIn("u1", "commons.contribute")).toBe(false);
    });

    it("is true only for a stored yes", async () => {
        prisma.releaseChoice.findUnique.mockResolvedValue({ enabled: true });
        expect(await hasOptedIn("u1", "commons.contribute")).toBe(true);
    });
});

describe("pendingReleases", () => {
    it("hides what the user has already closed", async () => {
        jest.restoreAllMocks();
        const real = catalog.RELEASES[0].version;
        prisma.releaseAcknowledgement.findMany.mockResolvedValue([{ version: real }]);
        expect((await pendingReleases("u1")).map((r) => r.version)).not.toContain(real);
    });
});

describe("catalog", () => {
    it("has a 1.10.1 entry with the ONNX note and re-embed action", () => {
        const release = catalog.RELEASES.find((r) => r.version === "1.10.1");
        expect(release).toBeDefined();

        const keys = release!.items.map((i) => i.key);
        expect(keys).toContain("clap.onnx");
        expect(keys).toContain("clap.reembed");

        const note = release!.items.find(
            (i): i is Extract<catalog.ReleaseItem, { kind: "note" }> => i.kind === "note" && i.key === "clap.onnx",
        );
        expect(note?.body).toContain("Swapped the audio analyzer to ONNX");

        const action = release!.items.find(
            (i): i is Extract<catalog.ReleaseItem, { kind: "action" }> => i.kind === "action" && i.key === "clap.reembed",
        );
        expect(action?.cta).toBe("Rebuild your embeddings");
        expect(action?.settingsPath).toBe("/settings#cache");
    });
});
