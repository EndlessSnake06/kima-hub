/**
 * Public vibe surface — read-only door onto auth-walled features.
 *
 * The decisive logic in this feature is in publicVibeService:
 *   - join playback (trackId + queue) onto map coordinates
 *   - proxy `native:` cover refs into public cover URLs (never leak refs)
 *   - deterministically decimate the map to the public cap
 *   - null nowPlaying when idle (the normal case)
 *
 * Rather than asserting on re-implemented behavior, these tests drive the REAL
 * service functions against a mocked prisma layer whose rows stand in for the
 * cache + DB. They assert the observable contracts: coverage rewriting, the
 * idle-null contract, the decimate cap + reported count, and the queue
 * ordering/indices. A real DB (jest globalSetup, testbed) is OUT of reach from
 * this host, so this demonstrates the logic directly; the live-server steps in
 * the card body are recorded as not_verified with reason.
 */

// prisma is imported by the service directly, so mock it at that path.
jest.mock("../../utils/db", () => {
    const state = {
        playbackRow: null,
    };
    return {
        __esModule: true,
        prisma: {
            playbackState: {
                findUnique: jest.fn(async () => state.playbackRow),
            },
            $queryRaw: jest.fn(async () => []),
        },
        __state: state,
    };
});

import {
    getPublicLive,
    getPublicQueue,
    getPublicMap,
} from "../publicVibeService";
import { prisma } from "../../utils/db";

// A tiny fake map projection, shaped like what umapProjection returns (the
// service reads structural fields only). Includes a native: cover and a
// remote cover, plus a track that is NOT on the map (dropped from output).
function makeProjection() {
    return {
        tracks: [
            {
                id: "c_play_001",
                x: 0.42,
                y: 0.71,
                title: "Sunny Happy Day",
                artist: "Test Mood Artist",
                albumId: "album_seed_001",
                coverUrl: "native:album_seed_001.jpg",
            },
            {
                id: "c_play_002",
                x: 0.40,
                y: 0.69,
                title: "Melancholy Rain",
                artist: "Test Mood Artist",
                albumId: "album_seed_001",
                coverUrl: "native:album_seed_001_b.jpg",
            },
            {
                id: "c_remote_9",
                x: 0.1,
                y: 0.2,
                title: "Remote Cover",
                artist: "Others",
                albumId: "album_remote",
                coverUrl: "http://img.example/remote.jpg",
            },
        ],
        trackCount: 3,
        computedAt: new Date().toISOString(),
    };
}

// Force the service to read our projection instead of hitting Redis/UMAP.
const computeMapProjection = jest.fn();
jest.mock("../umapProjection", () => ({
    computeMapProjection: async (...args: any[]) =>
        computeMapProjection(...args),
}));

const projection = makeProjection();
const PUBLIC_USER = "public-user-id";

beforeEach(() => {
    jest.clearAllMocks();
    (computeMapProjection as unknown as jest.Mock).mockResolvedValue(
        JSON.parse(JSON.stringify(projection)),
    );
    (prisma.playbackState.findUnique as jest.Mock).mockReset();
    (prisma.playbackState.findUnique as jest.Mock).mockResolvedValue(null);
});

describe("getPublicLive — idle / null contract", () => {
    it("returns null nowPlaying when there is no PlaybackState (idle, normal)", async () => {
        const res = await getPublicLive(PUBLIC_USER);
        expect(res.nowPlaying).toBeNull();
        // Must not have bothered the map at all when idle.
        expect(computeMapProjection).not.toHaveBeenCalled();
    });

    it("returns null when the playing track is not on the map", async () => {
        (prisma.playbackState.findUnique as unknown as jest.Mock).mockResolvedValue(
            {
                playbackType: "track",
                trackId: "c_not_on_map",
                position: 123,
            },
        );
        const res = await getPublicLive(PUBLIC_USER);
        expect(res.nowPlaying).toBeNull();
    });

    it("joins the playing track to its map coordinates", async () => {
        (prisma.playbackState.findUnique as unknown as jest.Mock).mockResolvedValue(
            {
                playbackType: "track",
                trackId: "c_play_001",
                position: 84210,
            },
        );
        const res = await getPublicLive(PUBLIC_USER);
        expect(res.nowPlaying).not.toBeNull();
        expect(res.nowPlaying!.trackId).toBe("c_play_001");
        expect(res.nowPlaying!.x).toBe(0.42);
        expect(res.nowPlaying!.y).toBe(0.71);
        expect(res.nowPlaying!.title).toBe("Sunny Happy Day");
        expect(res.nowPlaying!.coverUrl).toBe(
            "/api/public/vibe/cover/c_play_001",
        );
    });
});

describe("coverUrl proxying", () => {
    it("rewrites native: references into the public cover route", async () => {
        (prisma.playbackState.findUnique as unknown as jest.Mock).mockResolvedValue(
            {
                playbackType: "track",
                trackId: "c_play_001",
            },
        );
        const { nowPlaying } = await getPublicLive(PUBLIC_USER);
        expect(nowPlaying!.coverUrl).toContain("/api/public/vibe/cover/");
        expect(nowPlaying!.coverUrl).not.toContain("native:");
    });

    it("passes a remote cover url straight through", async () => {
        // Point the playing track at the remote-cover row instead.
        computeMapProjection.mockResolvedValueOnce(
            JSON.parse(
                JSON.stringify({
                    tracks: [
                        {
                            id: "c_remote_9",
                            x: 0.1,
                            y: 0.2,
                            title: "Remote Cover",
                            artist: "Others",
                            albumId: "album_remote",
                            coverUrl: "http://img.example/remote.jpg",
                        },
                    ],
                }),
            ),
        );
        (prisma.playbackState.findUnique as unknown as jest.Mock).mockResolvedValue(
            {
                playbackType: "track",
                trackId: "c_remote_9",
            },
        );
        const { nowPlaying } = await getPublicLive(PUBLIC_USER);
        expect(nowPlaying!.coverUrl).toBe("http://img.example/remote.jpg");
    });
});

describe("getPublicQueue — join + index + ordering", () => {
    it("joins the queued tracks to map coords in playback order, indexed from 0", async () => {
        (prisma.playbackState.findUnique as unknown as jest.Mock).mockResolvedValue(
            {
                playbackType: "track",
                trackId: "c_play_001",
                queue: [
                    { id: "c_play_001", title: "A" },
                    { id: "c_play_002", title: "B" },
                    { id: "c_not_on_map", title: "ghost" },
                    { id: "c_remote_9", title: "R" },
                ],
                currentIndex: 0,
            },
        );
        const q = await getPublicQueue(PUBLIC_USER);
        // splitQueue() returns queue.slice(currentIndex + 1), so the now-playing
        // item at currentIndex 0 is excluded. "ghost" is not on the map so it is
        // dropped. That leaves c_play_002 and c_remote_9.
        expect(q).toHaveLength(2);
        expect(q[0]).toMatchObject({ index: 0, trackId: "c_play_002", x: 0.4, y: 0.69 });
        expect(q[1]).toMatchObject({ index: 1, trackId: "c_remote_9", x: 0.1, y: 0.2 });
        expect(q[1].coverUrl).toBe("http://img.example/remote.jpg");
        // every emitted item has coords
        for (const item of q) {
            expect(typeof item.x).toBe("number");
            expect(typeof item.y).toBe("number");
        }
    });

    it("returns [] when idle", async () => {
        const q = await getPublicQueue(PUBLIC_USER);
        expect(q).toEqual([]);
    });
});

describe("getPublicMap — cap + envelope", () => {
    it("caps to the public cap and documents the number in the envelope", async () => {
        const full: any[] = [];
        for (let i = 0; i < 40; i++) {
            full.push({
                id: `c_full_${i}`,
                x: i / 100,
                y: i / 100,
                title: `track ${i}`,
                artist: "A",
                albumId: `a_${i}`,
                coverUrl: `native:a_${i}.jpg`,
            });
        }
        computeMapProjection.mockResolvedValueOnce({
            tracks: full,
            trackCount: full.length,
            computedAt: new Date().toISOString(),
        });
        const map = await getPublicMap(10);
        expect(map.tracks.length).toBeLessThanOrEqual(10);
        expect(map.fullCount).toBe(full.length);
        expect(map.trackCount).toBeLessThan(full.length);
        expect(map.sampled).toBe(true);
        expect(map.sampledNote).toMatch(/Limited to/);
        expect(computeMapProjection).toHaveBeenCalledTimes(1);
    });

    it("passes the full map through un-sampled when under the cap", async () => {
        computeMapProjection.mockResolvedValueOnce({
            tracks: makeProjection().tracks.slice(0, 1),
            trackCount: 1,
            computedAt: new Date().toISOString(),
        });
        const map = await getPublicMap(5000);
        expect(map.tracks.length).toBe(1);
        expect(map.sampled).toBe(false);
    });
});
