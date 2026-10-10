/**
 * buildFinalPlaylist marks the batch failed when the playlist transaction
 * throws. The fixture returns a track so the build reaches the transaction.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { updateBatchStatus } from "../../discovery/optimisticBatchUpdate";
import { prisma } from "../../../utils/db";

jest.mock("../../discovery/optimisticBatchUpdate", () => ({
    updateBatchStatus: jest.fn().mockResolvedValue({ success: true, retries: 0 }),
}));

jest.mock("../../../utils/db", () => ({
    prisma: {
        discoveryBatch: { findUnique: jest.fn(), update: jest.fn() },
        downloadJob: { findMany: jest.fn().mockResolvedValue([]) },
        track: { findMany: jest.fn().mockResolvedValue([]) },
        // Read before the transaction; undefined makes the service use its default exclusion window.
        userDiscoverConfig: { findUnique: jest.fn() },
        $transaction: jest.fn(),
    },
}));

// getSeedArtists returns [] so only the popular fallback runs.
jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getSeedArtists: jest.fn().mockResolvedValue([]) },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));

// cleanupFailedArtists calls lidarrService.getDiscoveryArtists after the catch
// and cleanupOrphanedLidarrQueue calls getSystemSettings. Both run on every
// buildFinalPlaylist exit path, so stub them to no-op/empty.
jest.mock("../../lidarr", () => ({
    lidarrService: {
        getDiscoveryArtists: jest.fn().mockResolvedValue([]),
    },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

// eventBus.emit fires after the catch; stubbed to leave the real channel alone.
jest.mock("../../eventBus", () => ({
    eventBus: { emit: jest.fn() },
}));

// Import-time-only heavy deps (BullMQ queues instantiate at module load,
// the musicbrainz/acquisition chain pulls network clients). Stub so the module
// graph loads without opening Redis/HTTP handles.
jest.mock("../../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
    discoverQueue: { add: jest.fn() },
}));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../acquisitionService", () => ({ acquisitionService: {} }));
jest.mock("../../discoveryLogger", () => ({
    discoveryLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../artistCountsService", () => ({
    updateArtistCounts: jest.fn(),
}));

const statusCalls = (status: string) =>
    (updateBatchStatus as jest.Mock).mock.calls.filter(
        ([, data]) => data && data.status === status
    );

// The batch is `scanning`, so the already-completed/failed guard does not
// short-circuit; `jobs: []` keeps the cleanup after the catch from throwing. The
// completed job has the metadata the search criteria need, and the matching
// track lets the build reach the playlist transaction.
function arrangeBatchWithOneAlbum(batchId: string) {
    (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
        id: batchId,
        userId: "u1",
        status: "scanning",
        targetSongCount: 30,
        weekStart: new Date("2026-05-25T00:00:00.000Z"),
        jobs: [],
    });
    (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
        {
            id: `job-${batchId}`,
            discoveryBatchId: batchId,
            status: "completed",
            metadata: {
                artistName: "Test Artist",
                albumTitle: "Test Album",
                albumMbid: "mbid-123",
            },
        },
    ]);
    (prisma.track.findMany as jest.Mock).mockResolvedValue([
        {
            id: "t1",
            title: "T",
            filePath: "/m/t1.flac",
            album: {
                id: "alb-1",
                rgMbid: "mbid-123",
                title: "Test Album",
                artist: { name: "Test Artist" },
            },
        },
    ]);
}

describe("buildFinalPlaylist failure handling", () => {
    beforeEach(() => jest.clearAllMocks());

    it("marks the batch failed when the playlist transaction throws, not through the no-tracks exit", async () => {
        arrangeBatchWithOneAlbum("batch-1");
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-1");

        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-1",
            expect.objectContaining({
                status: "failed",
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );
        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-1",
            expect.objectContaining({
                errorMessage: "No tracks found after scan",
            })
        );
    });

    it("sets completedAt so the failed batch is a terminal state", async () => {
        arrangeBatchWithOneAlbum("batch-terminal");
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-terminal");

        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-terminal",
            expect.objectContaining({
                status: "failed",
                completedAt: expect.any(Date),
            })
        );
    });

    it("never marks the batch completed once the build transaction has thrown", async () => {
        arrangeBatchWithOneAlbum("batch-noresurrect");
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-noresurrect");

        expect(statusCalls("completed")).toEqual([]);
        expect(statusCalls("failed").length).toBeGreaterThanOrEqual(1);
    });

    it("marks the batch failed exactly once when the transaction throws", async () => {
        arrangeBatchWithOneAlbum("batch-once");
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-once");

        expect(statusCalls("failed")).toHaveLength(1);
    });

    it("includes the transaction's error message in the failure reason", async () => {
        arrangeBatchWithOneAlbum("batch-2");
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("P2002 unique constraint failed")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-2");

        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-2",
            expect.objectContaining({
                status: "failed",
                errorMessage: expect.stringContaining(
                    "P2002 unique constraint failed"
                ),
            })
        );
    });

    it("a batch with no tracks fails with its own message, not the transaction failure's", async () => {
        arrangeBatchWithOneAlbum("batch-3");
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

        await discoverWeeklyService.buildFinalPlaylist("batch-3");

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-3",
            expect.objectContaining({
                status: "failed",
                errorMessage: "No tracks found after scan",
            })
        );
        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-3",
            expect.objectContaining({
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );
    });

    it("does not mark the batch failed when the transaction succeeds", async () => {
        arrangeBatchWithOneAlbum("batch-4");
        (prisma.$transaction as jest.Mock).mockResolvedValue({
            albumCount: 1,
            trackCount: 1,
        });

        await discoverWeeklyService.buildFinalPlaylist("batch-4");

        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-4",
            expect.objectContaining({
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );
    });
});
