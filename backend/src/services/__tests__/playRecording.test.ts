/**
 * The Last.fm rule, pinned.
 *
 * A play used to mean "the stream endpoint was hit", so skipping an album wrote
 * a play per track. These tests exist so that cannot come back quietly: each one
 * was watched to fail against a deliberate mutation of the rule before being
 * kept.
 */

import { ListenSource } from "@prisma/client";
import {
    MAX_REQUIRED_SECONDS,
    MIN_TRACK_DURATION_SECONDS,
    qualifiesAsPlay,
    recordPlay,
    requiredListenSeconds,
} from "../playRecording";

jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findUnique: jest.fn() },
        play: { findFirst: jest.fn(), create: jest.fn() },
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prisma } = require("../../utils/db");

const track = (duration: number) => ({ id: "t1", duration });

beforeEach(() => {
    jest.clearAllMocks();
    prisma.play.findFirst.mockResolvedValue(null);
    prisma.play.create.mockResolvedValue({ id: "p1" });
});

describe("requiredListenSeconds", () => {
    it("refuses a track at or under 30 seconds outright", () => {
        // Not "needs a lot of listening" -- can never qualify, at any amount.
        expect(requiredListenSeconds(30)).toBeNull();
        expect(requiredListenSeconds(12)).toBeNull();
    });

    it("asks for half the length just past the floor", () => {
        expect(requiredListenSeconds(31)).toBeCloseTo(15.5);
        expect(requiredListenSeconds(200)).toBe(100);
    });

    it("never asks for more than four minutes, however long the track", () => {
        expect(requiredListenSeconds(600)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(60 * 60)).toBe(MAX_REQUIRED_SECONDS);
    });

    it("demands the four-minute bound when the length is unknown", () => {
        // duration is a non-null Int, so an unscanned track arrives as 0. If that
        // were treated as "eligible immediately", never scanning a file would be
        // the cheapest way to log a play.
        expect(requiredListenSeconds(0)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(null)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(undefined)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(Number.NaN)).toBe(MAX_REQUIRED_SECONDS);
        expect(requiredListenSeconds(-5)).toBe(MAX_REQUIRED_SECONDS);
    });

    it("puts the floor on the track, not on the listening", () => {
        // A 40s track needs 20s. Clamping the requirement up to 30 would make
        // three quarters of a short track worth less than half a long one.
        expect(requiredListenSeconds(40)).toBe(20);
        expect(requiredListenSeconds(40)).toBeLessThan(MIN_TRACK_DURATION_SECONDS);
    });
});

describe("qualifiesAsPlay", () => {
    it("counts exactly the required amount", () => {
        expect(qualifiesAsPlay(100, 200)).toBe(true);
        expect(qualifiesAsPlay(99.9, 200)).toBe(false);
    });

    it("never counts a too-short track, even played end to end twice", () => {
        expect(qualifiesAsPlay(60, 25)).toBe(false);
    });

    it("rejects nonsense listening values instead of trusting them", () => {
        expect(qualifiesAsPlay(Number.NaN, 200)).toBe(false);
        expect(qualifiesAsPlay(-10, 200)).toBe(false);
    });
});

describe("recordPlay", () => {
    it("writes a row once the listening earns it", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 100 });
        expect(out).toEqual({ recorded: true, playId: "p1" });
        expect(prisma.play.create).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the track was barely played", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 5 });
        expect(out).toEqual({ recorded: false, reason: "not-enough-listened" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("writes nothing for a track under the 30-second floor", async () => {
        prisma.track.findUnique.mockResolvedValue(track(20));
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 20 });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("makes an unscanned track the hardest to scrobble, not the easiest", async () => {
        prisma.track.findUnique.mockResolvedValue(track(0));
        expect(await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 239 }))
            .toEqual({ recorded: false, reason: "not-enough-listened" });
        expect(await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 240 }))
            .toEqual({ recorded: true, playId: "p1" });
    });

    it("collapses a repeat inside the dedup window to one row", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        prisma.play.findFirst.mockResolvedValue({ id: "already" });
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("reads the duration from the database, never from the caller", async () => {
        // A client claiming a 3-second jingle is an hour long must not be able to
        // scrobble it on two seconds of audio.
        prisma.track.findUnique.mockResolvedValue(track(3));
        const out = await recordPlay({
            userId: "u1",
            trackId: "t1",
            secondsListened: 2,
            source: ListenSource.SUBSONIC,
        });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
    });

    it("reports an unknown track rather than inventing one", async () => {
        prisma.track.findUnique.mockResolvedValue(null);
        const out = await recordPlay({ userId: "u1", trackId: "nope", secondsListened: 999 });
        expect(out).toEqual({ recorded: false, reason: "unknown-track" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("carries the source through, so the cutover stays auditable", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        await recordPlay({
            userId: "u1",
            trackId: "t1",
            secondsListened: 150,
            source: ListenSource.SUBSONIC,
        });
        expect(prisma.play.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ source: ListenSource.SUBSONIC }),
            }),
        );
    });
});
