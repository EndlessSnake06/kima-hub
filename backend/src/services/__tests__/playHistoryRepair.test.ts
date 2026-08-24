/**
 * The repair, against history whose right answer is known in advance.
 *
 * Every case here is constructed so the correct verdict is not a matter of
 * opinion: either the gap to the next play makes the listen impossible, or it
 * leaves it genuinely unknown. The tests exist mostly to hold the second line —
 * a repair that deletes ambiguous rows would look tidier and would be throwing
 * away real listening.
 */

import { analysePlayHistory, repairPlayHistory } from "../playHistoryRepair";

jest.mock("../../utils/db", () => ({
    prisma: { play: { findMany: jest.fn(), deleteMany: jest.fn() } },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prisma } = require("../../utils/db");

const T0 = new Date("2026-03-01T12:00:00Z").getTime();

/** A play `atSeconds` into the session, of a track `duration` long. */
function play(id: string, atSeconds: number, duration: number, title = id) {
    return {
        id,
        trackId: `track-${id}`,
        playedAt: new Date(T0 + atSeconds * 1000),
        track: { title, duration },
    };
}

function given(rows: ReturnType<typeof play>[]) {
    prisma.play.findMany.mockResolvedValue(rows);
    prisma.play.deleteMany.mockImplementation(async ({ where }: never) => ({
        count: (where as { id: { in: string[] } }).id.in.length,
    }));
}

beforeEach(() => jest.clearAllMocks());

describe("analysePlayHistory", () => {
    it("calls a track a skip when the next play arrives too soon", async () => {
        // Three 200s tracks, each needing 100s, played 8 seconds apart. Nobody
        // listened to the first two: they were already onto something else.
        given([play("a", 0, 200), play("b", 8, 200), play("c", 16, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.provableSkips).toBe(2);
        expect(r.sample.map((s) => s.playId)).toEqual(["a", "b"]);
    });

    it("leaves a play alone when the gap proves nothing", async () => {
        // 220s apart, a 200s track needing 100s. Could be a full listen, could be
        // four seconds and a walk away. No evidence either way, so no deletion.
        given([play("a", 0, 200), play("b", 220, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.provableSkips).toBe(0);
        expect(r.unprovable).toBe(1);
    });

    it("never touches the last play of a session", async () => {
        // Nothing follows it, so there is no ceiling on how long it ran.
        given([play("a", 0, 200), play("b", 8, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.noFollowingPlay).toBe(1);
        expect(r.sample.map((s) => s.playId)).not.toContain("b");
    });

    it("treats a gap exactly at the threshold as unprovable, not a skip", async () => {
        // 100s gap, 100s required. The boundary belongs to the listener.
        given([play("a", 0, 200), play("b", 100, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.provableSkips).toBe(0);
    });

    it("removes a track too short to ever count, whatever the gap", async () => {
        // A 20s track cannot be scrobbled under the rule at any length of
        // listening, so its presence is an artefact of the old behaviour.
        given([play("a", 0, 20), play("b", 9999, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.provableSkips).toBe(1);
        expect(r.sample[0].playId).toBe("a");
    });

    it("uses the four-minute bound for a track of unknown length", async () => {
        // duration 0 means never scanned. It needs 240s, so a 100s gap is a skip.
        given([play("a", 0, 0), play("b", 100, 200)]);
        expect((await analysePlayHistory("u1")).provableSkips).toBe(1);
        given([play("a", 0, 0), play("b", 300, 200)]);
        expect((await analysePlayHistory("u1")).provableSkips).toBe(0);
    });

    it("reports the span it looked at", async () => {
        given([play("a", 0, 200), play("b", 600, 200)]);
        const r = await analysePlayHistory("u1");
        expect(r.totalPlays).toBe(2);
        expect(r.earliest).toEqual(new Date(T0));
        expect(r.latest).toEqual(new Date(T0 + 600_000));
    });

    it("survives an empty history without inventing anything", async () => {
        given([]);
        const r = await analysePlayHistory("u1");
        expect(r).toMatchObject({ totalPlays: 0, provableSkips: 0, earliest: null, latest: null });
    });
});

describe("repairPlayHistory", () => {
    it("deletes exactly the provable skips and keeps the rest", async () => {
        // An album skipped through, then one track genuinely played.
        given([
            play("s1", 0, 200),
            play("s2", 6, 200),
            play("s3", 12, 200),
            play("real", 18, 200),
            play("last", 500, 200),
        ]);
        const out = await repairPlayHistory("u1");
        expect(out).toEqual({ removed: 3, kept: 2 });

        const deleted = prisma.play.deleteMany.mock.calls[0][0].where.id.in;
        expect(deleted.sort()).toEqual(["s1", "s2", "s3"]);
        expect(deleted).not.toContain("real"); // 482s gap -- unprovable
        expect(deleted).not.toContain("last"); // nothing follows it
    });

    it("does nothing at all when there is nothing provable", async () => {
        given([play("a", 0, 200), play("b", 900, 200)]);
        const out = await repairPlayHistory("u1");
        expect(out).toEqual({ removed: 0, kept: 2 });
        expect(prisma.play.deleteMany).not.toHaveBeenCalled();
    });

    it("scopes the delete to the user, not just the ids", async () => {
        given([play("a", 0, 200), play("b", 5, 200), play("c", 10, 200)]);
        await repairPlayHistory("u1");
        expect(prisma.play.deleteMany.mock.calls[0][0].where).toMatchObject({ userId: "u1" });
    });
});
