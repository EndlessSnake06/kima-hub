import { DiscoveryAlbumLifecycle, DiscoveryAlbumInfo } from '../discoveryAlbumLifecycle';
import { prisma } from '../../../utils/db';
import { removeDiscoveryAlbum } from '../lidarrRemoval';
import { updateArtistCounts } from '../../artistCountsService';

jest.mock('../../../utils/db', () => ({
    prisma: {
        album: {
            findFirst: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        ownedAlbum: {
            upsert: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        track: {
            deleteMany: jest.fn(),
        },
        discoveryTrack: {
            deleteMany: jest.fn(),
        },
        unavailableAlbum: {
            deleteMany: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('../lidarrRemoval', () => ({ removeDiscoveryAlbum: jest.fn() }));
jest.mock('../../artistCountsService', () => ({
    updateArtistCounts: jest.fn(),
}));

const mockRemoveAlbum = removeDiscoveryAlbum as jest.Mock;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockUpdateArtistCounts = updateArtistCounts as jest.Mock;

describe('DiscoveryAlbumLifecycle', () => {
    let lifecycle: DiscoveryAlbumLifecycle;

    beforeEach(() => {
        jest.clearAllMocks();
        lifecycle = new DiscoveryAlbumLifecycle();
        (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
            cb(mockPrisma)
        );
        // deleteRejectedAlbum's read-only pre-check defaults to ACTIVE so the
        // destructive path runs; tests for the like-vs-cleanup race override this
        // to a non-ACTIVE status to assert the pre-check abort.
        (mockPrisma.discoveryAlbum.findUnique as jest.Mock).mockResolvedValue({
            status: 'ACTIVE',
        });
    });

    describe('moveLikedAlbumToLibrary', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };

        it('should update album location to LIBRARY', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.album.update).toHaveBeenCalledWith({
                where: { id: 'album-db-1' },
                data: { location: 'LIBRARY' },
            });
        });

        it('should create OwnedAlbum record', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.ownedAlbum.upsert).toHaveBeenCalledWith({
                where: {
                    artistId_rgMbid: {
                        artistId: 'artist-1',
                        rgMbid: 'rg-mbid-123',
                    },
                },
                create: {
                    artistId: 'artist-1',
                    rgMbid: 'rg-mbid-123',
                    source: 'discovery_liked',
                },
                update: {},
            });
        });

        it('should update artist counts after move', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockUpdateArtistCounts).toHaveBeenCalledWith('artist-1');
        });

        it('should mark discovery album as MOVED', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'MOVED' },
            });
        });

        it('should still mark as MOVED even if album not found in DB', async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'MOVED' },
            });
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
        });

        it('should throw error when operation fails', async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(lifecycle.moveLikedAlbumToLibrary(mockAlbum)).rejects.toThrow('DB Error');
        });
    });

    describe('deleteRejectedAlbum', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };


        it('removes the album from Lidarr through the identity check', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockRemoveAlbum).toHaveBeenCalledWith(456, 'rg-mbid-123');
        });

        it('should skip Lidarr deletion when album has no lidarrAlbumId', async () => {
            const albumWithoutLidarr: DiscoveryAlbumInfo = {
                ...mockAlbum,
                lidarrAlbumId: null,
            };
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumWithoutLidarr);

            expect(mockRemoveAlbum).not.toHaveBeenCalled();
        });

        it('still clears the rows when Lidarr keeps the files', async () => {
            mockRemoveAlbum.mockResolvedValue(false);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalled();
        });

        it('should delete tracks and album from database', async () => {
            const dbAlbum = { id: 'album-db-1' };
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.track.deleteMany).toHaveBeenCalledWith({
                where: { albumId: 'album-db-1' },
            });
            expect(mockPrisma.album.delete).toHaveBeenCalledWith({
                where: { id: 'album-db-1' },
            });
        });

        it('should delete discovery track records', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: 'discovery-album-1' },
            });
        });

        it('should mark discovery album as DELETED via the conditional claim', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1', status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
        });

        it('should throw error when database operation fails', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            // Claim succeeds so execution reaches the owned-album read inside the
            // transaction, where the DB error is raised and must propagate out.
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(lifecycle.deleteRejectedAlbum(mockAlbum)).rejects.toThrow('DB Error');
        });
    });

    describe('deleteRejectedAlbum - atomic claim-then-delete (Task 7)', () => {
        const albumFixture: DiscoveryAlbumInfo = {
            id: 'da-1',
            rgMbid: 'rg-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: null,
        };

        // FAILURE PATH: the race the task exists for. Cleanup snapshotted ACTIVE,
        // the user liked it (-> LIKED) before the delete ran. The conditional
        // claim updateMany({status:'ACTIVE'}) matches 0 rows -> count 0 -> abort.
        // Discriminator: NONE of the destructive writes may fire when count===0.
        // A green here can only come from the count===0 abort branch, because the
        // happy path (count 1) would call album.delete / track.deleteMany.
        it('aborts ALL destructive writes when liked concurrently (claim count 0)', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.album.delete).not.toHaveBeenCalled();
            expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
        });

        // DISCRIMINATOR: the claim must be a CONDITIONAL updateMany gated on
        // status:'ACTIVE', not the old unconditional update({where:{id}}).
        // This is what makes the race-claim atomic. Asserting the exact where/data
        // shape rules out the legacy bare update path passing this test.
        it('claims the row via conditional updateMany gated on status ACTIVE', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: 'da-1', status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
        });

        // DISCRIMINATOR: torn-state fix. The DB writes must run inside a single
        // $transaction. Asserting $transaction fired AND the claim ran on the tx
        // handle rules out the legacy four-bare-writes path (which never opens a tx).
        it('performs the claim and deletes inside a single $transaction', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
            // The claim must execute (the $transaction mock passes mockPrisma as tx,
            // so tx.discoveryAlbum.updateMany is this same spy).
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalled();
        });

        // ORDERING DISCRIMINATOR: claim-THEN-delete. The conditional claim must be
        // invoked before any file/row deletion, otherwise the race guard is moot
        // (we would have deleted before learning the row was liked). This rules out
        // a delete-first-then-mark ordering that could still satisfy the call-count
        // assertions above.
        it('invokes the claim before deleting album rows', async () => {
            const order: string[] = [];
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockImplementation(async () => {
                order.push('claim');
                return { count: 1 };
            });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.track.deleteMany as jest.Mock).mockImplementation(async () => {
                order.push('track.deleteMany');
                return {};
            });
            (mockPrisma.album.delete as jest.Mock).mockImplementation(async () => {
                order.push('album.delete');
                return {};
            });
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(order[0]).toBe('claim');
            expect(order.indexOf('claim')).toBeLessThan(order.indexOf('album.delete'));
        });

        // BOUNDARY: claim succeeds (count 1) but the album is not in the library DB
        // (findFirst -> null, e.g. sourced-from-library / never imported). Only the
        // DiscoveryTrack rows are removed; the Album/Track deletes must be skipped.
        it('claims and clears discovery tracks but skips album/track delete when no DB album', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.album.delete).not.toHaveBeenCalled();
            expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: 'da-1' },
            });
        });

        // HAPPY PATH (last): claim wins (count 1), DB album present -> full cascade.
        it('deletes files and rows when it claims the ACTIVE row (count 1)', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.track.deleteMany).toHaveBeenCalledWith({
                where: { albumId: 'alb-1' },
            });
            expect(mockPrisma.album.delete).toHaveBeenCalledWith({ where: { id: 'alb-1' } });
        });

        // GAP 1 (resurrection guard, count 0): the abort branch must NOT touch the
        // status row a second time. The legacy code path ended with an
        // unconditional discoveryAlbum.update({status:'DELETED'}). A broken impl
        // that adds the updateMany claim cosmetically but still falls through to
        // that bare update on count===0 would mark a just-LIKED row DELETED -- the
        // exact resurrection the task fights. updateMany returns count 0 (liked),
        // so the only legitimate write to the status row is the claim itself; the
        // bare update must never fire. Without this, an impl that keeps the old
        // update passes the existing count-0 test (which only checks deletes).
        it('does NOT call the bare discoveryAlbum.update when claim aborts (count 0)', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.discoveryAlbum.update).not.toHaveBeenCalled();
        });

        // GAP 1b (no double-write on happy path): the claim updateMany IS the
        // status transition to DELETED. The legacy bare update({status:'DELETED'})
        // must be gone entirely, not run in addition. An impl that performs both
        // writes the status twice (harmless-looking but signals the old path
        // survived and could resurrect on the abort branch). Forbid update on the
        // success path too so the only DELETED transition is the conditional claim.
        it('does NOT call the bare discoveryAlbum.update on the happy path (count 1)', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(mockPrisma.discoveryAlbum.update).not.toHaveBeenCalled();
            // And the claim is the sole status transition.
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledTimes(1);
        });

        // FILE-RACE GUARD: a read-only status pre-check must run BEFORE the
        // destructive Lidarr file delete. If the user liked the album after the
        // cleanup snapshot (status no longer ACTIVE at the pre-check), neither the
        // Lidarr deleteFiles call nor any DB write may fire -- otherwise the files
        // are destroyed for a row the user just chose to keep. The in-tx claim
        // alone cannot prevent this because Lidarr runs outside the transaction.
        it('pre-checks status and skips Lidarr file delete + all DB writes when no longer ACTIVE', async () => {
            const albumWithLidarr: DiscoveryAlbumInfo = { ...albumFixture, lidarrAlbumId: 99 };
            (mockPrisma.discoveryAlbum.findUnique as jest.Mock).mockResolvedValue({
                status: 'LIKED',
            });

            await lifecycle.deleteRejectedAlbum(albumWithLidarr);

            expect(mockRemoveAlbum).not.toHaveBeenCalled();
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryAlbum.updateMany).not.toHaveBeenCalled();
            expect(mockPrisma.album.delete).not.toHaveBeenCalled();
            expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
        });

        // ORDERING: the pre-check read must precede the Lidarr file delete (not
        // run after it), so a liked album never loses files. Pin the order.
        it('runs the status pre-check before the Lidarr file delete', async () => {
            const order: string[] = [];
            const albumWithLidarr: DiscoveryAlbumInfo = { ...albumFixture, lidarrAlbumId: 99 };
            (mockPrisma.discoveryAlbum.findUnique as jest.Mock).mockImplementation(async () => {
                order.push('pre-check');
                return { status: 'ACTIVE' };
            });
            mockRemoveAlbum.mockImplementation(async () => {
                order.push('lidarr.delete');
                return true;
            });
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumWithLidarr);

            expect(order[0]).toBe('pre-check');
            expect(order.indexOf('pre-check')).toBeLessThan(order.indexOf('lidarr.delete'));
        });

        // The Lidarr removal runs outside the transaction, so a failing transaction
        // cannot undo it and a Lidarr timeout cannot roll back the claim.
        it('issues the Lidarr delete OUTSIDE the transaction (still called when tx throws)', async () => {
            const albumWithLidarr: DiscoveryAlbumInfo = { ...albumFixture, lidarrAlbumId: 99 };
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('tx failed'));

            await expect(
                lifecycle.deleteRejectedAlbum(albumWithLidarr)
            ).rejects.toThrow('tx failed');

            expect(mockRemoveAlbum).toHaveBeenCalledWith(99, albumFixture.rgMbid);
        });

        // GAP 3 (claim-before-delete ordering, full cascade): the existing ordering
        // test only checks claim < album.delete. It does not pin claim before
        // track.deleteMany or discoveryTrack.deleteMany. A delete-first impl that
        // deletes tracks, then claims, then deletes the album would satisfy the
        // existing assertion (claim still precedes album.delete) while having
        // already destroyed track rows before learning the album was liked. Pin
        // the claim before EVERY destructive write.
        it('invokes the claim before any destructive write (tracks included)', async () => {
            const order: string[] = [];
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockImplementation(async () => {
                order.push('claim');
                return { count: 1 };
            });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.track.deleteMany as jest.Mock).mockImplementation(async () => {
                order.push('track.deleteMany');
                return {};
            });
            (mockPrisma.album.delete as jest.Mock).mockImplementation(async () => {
                order.push('album.delete');
                return {};
            });
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockImplementation(async () => {
                order.push('discoveryTrack.deleteMany');
                return {};
            });

            await lifecycle.deleteRejectedAlbum(albumFixture);

            expect(order[0]).toBe('claim');
            for (const op of ['track.deleteMany', 'album.delete', 'discoveryTrack.deleteMany']) {
                expect(order.indexOf('claim')).toBeLessThan(order.indexOf(op));
            }
        });

        // GAP 4 (count boundary): the guard is `claimed.count === 0` -> abort. A
        // broken impl using a truthiness guard (`if (!claimed.count)`) treats a
        // returned count of undefined/null (a malformed driver result) the same as
        // 0 and aborts -- but strict ===0 must PROCEED on a non-zero claim only.
        // Conversely an impl using `claimed.count > 0` and a positive count is the
        // happy path. We pin the contract: exactly count===0 aborts, count===1
        // proceeds. This nails the comparison operator so a `>= 0` (always true ->
        // always proceeds, race never guarded) or `> 0` typo is caught: feed a
        // count that is 0 and require abort.
        it('uses strict count===0 to abort: a count of 0 must abort, never proceed', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                id: 'alb-1',
                rgMbid: 'rg-123',
            });
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumFixture);

            // Every destructive DB write must be skipped on count 0.
            expect(mockPrisma.album.delete).not.toHaveBeenCalled();
            expect(mockPrisma.track.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryTrack.deleteMany).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryAlbum.update).not.toHaveBeenCalled();
        });
    });

    describe('processBeforeGeneration', () => {
        const userId = 'user-123';

        it('should return early when no discovery albums exist', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result).toEqual({ moved: 0, deleted: 0 });
            expect(mockPrisma.album.findFirst).not.toHaveBeenCalled();
        });

        it('should process liked albums and mark them as moved', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
            ];
            const dbAlbum = { id: 'album-1', artistId: 'artist-1', rgMbid: 'rg-1' };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.moved).toBe(1);
            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'da-1' },
                data: { status: 'MOVED' },
            });
        });

        it('should process active albums and delete them', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'ACTIVE',
                    lidarrAlbumId: 100,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.deleted).toBe(1);
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: 'da-1', status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
        });

        it('should clean up unavailable albums for user', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.processBeforeGeneration(userId);

            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: { userId },
            });
        });

        it('should continue processing even when individual album fails', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
                {
                    id: 'da-2',
                    rgMbid: 'rg-2',
                    artistName: 'Artist 2',
                    albumTitle: 'Album 2',
                    status: 'LIKED',
                    lidarrAlbumId: 101,
                },
            ];
            const dbAlbum = { id: 'album-2', artistId: 'artist-2', rgMbid: 'rg-2' };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.album.findFirst as jest.Mock)
                .mockRejectedValueOnce(new Error('DB Error'))
                .mockResolvedValueOnce(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.moved).toBe(1);
        });
    });
});
