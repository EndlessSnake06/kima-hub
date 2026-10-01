/**
 * The reconciliation snapshot is all-or-nothing: any failed Lidarr fetch yields null,
 * because a partial snapshot reads as downloads and albums that are missing.
 */

import { lidarrService } from "../lidarr";

type Handler = (url: string, params: any) => any;

function useClient(handler: Handler) {
    const svc = lidarrService as any;
    svc.initialized = true;
    svc.enabled = true;
    svc.artistCache = null;
    svc.client = {
        get: jest.fn(async (url: string, opts?: { params?: any }) => handler(url, opts?.params)),
    };
}

const healthy: Handler = (url) => {
    if (url === "/api/v1/artist") {
        return { data: [{ id: 1, artistName: "Artist 1" }, { id: 2, artistName: "Artist 2" }] };
    }
    if (url === "/api/v1/queue") {
        return { data: { records: [{ id: 9, downloadId: "dl-1", status: "downloading", title: "Q" }] } };
    }
    if (url === "/api/v1/album") {
        return {
            data: [1, 2, 3].map((n) => ({
                id: n * 10,
                artistId: n === 3 ? 1 : n,
                title: `Album ${n}`,
                foreignAlbumId: `mbid-${n}`,
                statistics: { percentOfTracks: n === 3 ? 0 : 100 },
            })),
        };
    }
    throw new Error(`unexpected ${url}`);
};

describe("getReconciliationSnapshot", () => {
    it("indexes the queue and every album with files when all fetches succeed", async () => {
        useClient(healthy);
        const snapshot = await lidarrService.getReconciliationSnapshot();

        expect(snapshot?.queue.has("dl-1")).toBe(true);
        expect([...snapshot!.albumsByMbid.keys()].sort()).toEqual(["mbid-1", "mbid-2"]);
        expect(snapshot!.albumsByTitle.get("artist 2|album 2")?.id).toBe(20);
    });

    it("loads every album in one request", async () => {
        useClient(healthy);
        await lidarrService.getReconciliationSnapshot();

        const albumCalls = (lidarrService as any).client.get.mock.calls.filter(
            ([url]: [string]) => url === "/api/v1/album"
        );
        expect(albumCalls).toEqual([["/api/v1/album"]]);
    });

    it("is null when the album list fails to load", async () => {
        useClient((url, params) => {
            if (url === "/api/v1/album") throw new Error("database is locked");
            return healthy(url, params);
        });
        expect(await lidarrService.getReconciliationSnapshot()).toBeNull();
    });

    it("is null when the queue fails to load", async () => {
        useClient((url, params) => {
            if (url === "/api/v1/queue") throw new Error("timeout");
            return healthy(url, params);
        });
        expect(await lidarrService.getReconciliationSnapshot()).toBeNull();
    });

    it("is null when the artist list fails to load", async () => {
        useClient((url, params) => {
            if (url === "/api/v1/artist") throw new Error("500");
            return healthy(url, params);
        });
        expect(await lidarrService.getReconciliationSnapshot()).toBeNull();
    });

    it("is null when Lidarr is off", async () => {
        useClient(healthy);
        (lidarrService as any).enabled = false;
        expect(await lidarrService.getReconciliationSnapshot()).toBeNull();
    });
});
