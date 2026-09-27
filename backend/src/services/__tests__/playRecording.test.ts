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

jest.mock("../../utils/db", () => {
    // Typed as a bag of functions on purpose: `prisma` appears inside its own
    // initializer (the transaction stub hands the callback the same object),
    // which TS refuses to infer a type for otherwise.
    const prisma: Record<string, any> = {
        track: { findUnique: jest.fn() },
        play: { findFirst: jest.fn(), create: jest.fn() },
        // `recordPlay` does the duplicate check and the insert inside one
        // transaction, behind a per-(user, track) advisory lock. Run the
        // callback against this same object so the per-test `findFirst` /
        // `create` stubs are the ones that answer, and resolve the lock
        // query — there is no Postgres behind a mock to take it.
        $transaction: jest.fn((fn: any) => fn(prisma)),
        $executeRaw: jest.fn(async () => 1),
    };
    return { prisma };
});

// The ListenBrainz mirror must never hit the network from tests. Pin the
// service; each test decides whether it resolves or rejects.
jest.mock("../listenBrainz", () => ({
    listenBrainzService: {
        submitListens: jest.fn(),
        getUserToken: jest.fn(),
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prisma } = require("../../utils/db");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listenBrainzService } = require("../listenBrainz");

const track = (duration: number) => ({ id: "t1", duration });

beforeEach(() => {
    jest.clearAllMocks();
    prisma.play.findFirst.mockResolvedValue(null);
    prisma.play.create.mockResolvedValue({ id: "p1" });
    // Default: no token configured — the real service skips and resolves
    // false. Individual tests override when they want a submit to happen.
    listenBrainzService.submitListens.mockResolvedValue(false);
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

    it("pins the duplicate window to ±one duration around the reported play", async () => {
        // The window used to be one-sided — `playedAt > anchor − window` —
        // so anything NEWER than the play being recorded vetoed it and every
        // late-synced scrobble came back "duplicate". Both edges, or a play
        // from yesterday never gets stored at all.
        prisma.track.findUnique.mockResolvedValue(track(200));
        const at = new Date("2026-09-25T12:00:00.000Z");

        await recordPlay({
            userId: "u1",
            trackId: "t1",
            playedAt: at,
            clientAttestedComplete: true,
        });

        expect(prisma.play.findFirst).toHaveBeenCalledWith({
            where: {
                userId: "u1",
                trackId: "t1",
                playedAt: {
                    gt: new Date(at.getTime() - 200_000),
                    lt: new Date(at.getTime() + 200_000),
                },
            },
            select: { id: true },
        });
    });

    it("takes no isolation level, because REPEATABLE READ would restore the race", async () => {
        // The check and the insert run on the database's default READ
        // COMMITTED. Pinning the argument count is the cheap guard: an
        // `isolationLevel` option would put the second writer back on a
        // snapshot taken before the first one inserted, and the duplicate
        // would come back silently — no error, two rows.
        prisma.track.findUnique.mockResolvedValue(track(200));

        await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction.mock.calls[0]).toHaveLength(1);
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

describe("recordPlay with a client-attested play (Subsonic scrobble)", () => {
    it("records a scrobble the client says was played, with no seconds reported", async () => {
        // The old call passed Infinity as the seconds, which the finite-number
        // guard threw away: every Subsonic scrobble was silently dropped.
        prisma.track.findUnique.mockResolvedValue(track(200));
        const out = await recordPlay({
            userId: "u1",
            trackId: "t1",
            clientAttestedComplete: true,
            source: ListenSource.SUBSONIC,
        });
        expect(out).toEqual({ recorded: true, playId: "p1" });
        expect(prisma.play.create).toHaveBeenCalledTimes(1);
    });

    it("still refuses a track under the 30-second floor, whatever the client claims", async () => {
        prisma.track.findUnique.mockResolvedValue(track(20));
        const out = await recordPlay({ userId: "u1", trackId: "t1", clientAttestedComplete: true });
        expect(out).toEqual({ recorded: false, reason: "too-short" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("still collapses a repeat inside the dedup window", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        prisma.play.findFirst.mockResolvedValue({ id: "already" });
        const out = await recordPlay({ userId: "u1", trackId: "t1", clientAttestedComplete: true });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it("does not let a measured caller pass Infinity to skip the listening rule", async () => {
        prisma.track.findUnique.mockResolvedValue(track(200));
        const out = await recordPlay({
            userId: "u1",
            trackId: "t1",
            secondsListened: Number.POSITIVE_INFINITY,
        });
        expect(out).toEqual({ recorded: false, reason: "not-enough-listened" });
    });
});

describe("ListenBrainz mirror", () => {
    const fullTrack = {
        id: "t1",
        duration: 200,
        title: "Windowless Pane",
        album: { title: "Glass Works", artist: { name: "The Glazier" } },
    };

    /** Let the fire-and-forget submit settle before asserting. */
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("records the play even when no token is configured (submit self-skips)", async () => {
        // The service's documented no-token path: resolves false, never
        // throws. The play log must not care either way.
        prisma.track.findUnique.mockResolvedValue(fullTrack);
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out).toEqual({ recorded: true, playId: "p1" });
        await flush();
    });

    it("mirrors a recorded play with artist, track and release", async () => {
        prisma.track.findUnique.mockResolvedValue(fullTrack);
        listenBrainzService.submitListens.mockResolvedValue(true);
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush();
        expect(listenBrainzService.submitListens).toHaveBeenCalledTimes(1);
        expect(listenBrainzService.submitListens).toHaveBeenCalledWith([
            expect.objectContaining({
                artist: "The Glazier",
                track: "Windowless Pane",
                release: "Glass Works",
            }),
        ]);
    });

    it("a dead or rejecting ListenBrainz never fails the play", async () => {
        prisma.track.findUnique.mockResolvedValue(fullTrack);
        listenBrainzService.submitListens.mockRejectedValue(new Error("LB down"));
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out).toEqual({ recorded: true, playId: "p1" });
        await flush(); // let the rejection land in the swallow, not in jest
    });

    it("does not mirror a play that was not recorded", async () => {
        prisma.track.findUnique.mockResolvedValue(fullTrack);
        prisma.play.findFirst.mockResolvedValue({ id: "already" });
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out).toEqual({ recorded: false, reason: "duplicate" });
        await flush();
        expect(listenBrainzService.submitListens).not.toHaveBeenCalled();
    });

    it("does not mirror when the track row carries no usable metadata", async () => {
        // Half-enriched library rows (and the older mocks in this file)
        // have no title/album — the mirror skips, the play still counts.
        prisma.track.findUnique.mockResolvedValue({ id: "t1", duration: 200 });
        const out = await recordPlay({ userId: "u1", trackId: "t1", secondsListened: 150 });
        expect(out.recorded).toBe(true);
        await flush();
        expect(listenBrainzService.submitListens).not.toHaveBeenCalled();
    });
});
