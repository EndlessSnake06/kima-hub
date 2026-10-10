/**
 * The weekly cron enqueues each user's discover job under the same lock as the
 * manual /generate path (`discover:generate:<userId>`), and removes a finished
 * job with the same id first, since BullMQ silently ignores a re-add. The cron
 * callback is captured from a node-cron mock and fired directly.
 */

// Capture the scheduled callback so the test can fire it deterministically.
let scheduledCallback: (() => Promise<void>) | null = null;
jest.mock('node-cron', () => ({
    __esModule: true,
    default: {
        schedule: jest.fn((_expr: string, cb: () => Promise<void>) => {
            scheduledCallback = cb;
            return { stop: jest.fn() };
        }),
    },
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        userDiscoverConfig: { findMany: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../queues', () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
    },
}));

// The lock is the contract under test: by default it passes through (runs the
// callback). A race/failure test overrides it to reject for a specific user.
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: {
        withLock: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    },
}));

import { startDiscoverWeeklyCron } from '../discoverCron';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../queues';
import { distributedLock } from '../../utils/distributedLock';

function fakeJob(state: string) {
    return {
        id: `job-${state}`,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
    };
}

/** Register the cron and return the captured tick callback. */
function tickCron(): () => Promise<void> {
    scheduledCallback = null;
    startDiscoverWeeklyCron();
    const cb = scheduledCallback;
    if (!cb) {
        throw new Error('cron.schedule callback was not captured');
    }
    return cb;
}

/** Tick the cron for one user whose job hash sits in `state`; return that job. */
async function tickWithStaleJob(state: string) {
    const stale = fakeJob(state);
    (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);
    (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
        { userId: 'user-a', playlistSize: 25 },
    ]);
    await tickCron()();
    return stale;
}

/** remove() must beat add(): a re-add on a live hash is a silent no-op. */
function expectRemoveBeforeAdd(stale: { remove: jest.Mock }) {
    const removeOrder = stale.remove.mock.invocationCallOrder[0];
    const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(addOrder);
}

describe('discoverCron enqueue -- lock + stale-hash guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (distributedLock.withLock as jest.Mock).mockImplementation(
            async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()
        );
        (discoverQueue.add as jest.Mock).mockResolvedValue({ id: 'new-job' });
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);
    });

    // The enqueue runs inside withLock under the manual path's key.
    it('takes distributedLock with the discover:generate:<userId> key around the enqueue', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        expect(distributedLock.withLock).toHaveBeenCalledTimes(1);
        const [key, ttl] = (distributedLock.withLock as jest.Mock).mock.calls[0];
        expect(key).toBe('discover:generate:user-a');
        expect(typeof ttl).toBe('number');

        // The enqueue must happen inside the lock: withLock is invoked before add.
        const lockOrder = (distributedLock.withLock as jest.Mock).mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(addOrder);
    });

    // A retained COMPLETED hash for this user's current week must be removed
    // before re-adding, otherwise add() is a no-op and the cron silently
    // skips the user.
    it('removes a stale completed job hash inside the lock before re-enqueuing', async () => {
        const stale = await tickWithStaleJob('completed');

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        expectRemoveBeforeAdd(stale);
    });

    // A non-terminal (active) hash means a generation is already running for
    // this user/week. The cron must NOT remove it (that would orphan a live
    // run). Terminal-only removal, same as the /generate side.
    it('does not remove a non-terminal (active) job hash', async () => {
        const live = await tickWithStaleJob('active');

        expect(live.remove).not.toHaveBeenCalled();
    });

    // A lock failure for one user skips only that user; the next is enqueued.
    it('a lock failure for one user does not block the others', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
            { userId: 'user-b', playlistSize: 25 },
        ]);
        (distributedLock.withLock as jest.Mock).mockImplementation(
            async (key: string, _t: number, fn: () => Promise<unknown>) => {
                if (key === 'discover:generate:user-a') {
                    throw new Error('Failed to acquire lock: discover:generate:user-a');
                }
                return fn();
            }
        );

        await tickCron()();

        const addedUserIds = (discoverQueue.add as jest.Mock).mock.calls.map(
            (c) => c[1]?.userId
        );
        expect(addedUserIds).not.toContain('user-a');
        expect(addedUserIds).toContain('user-b');
    });

    // The lock is taken before getJob and remove, not only around add.
    it('looks up and removes the old job inside the lock, not before it', async () => {
        const stale = await tickWithStaleJob('completed');

        const lockOrder = (distributedLock.withLock as jest.Mock).mock.invocationCallOrder[0];
        const getJobOrder = (discoverQueue.getJob as jest.Mock).mock.invocationCallOrder[0];
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(getJobOrder);
        expect(lockOrder).toBeLessThan(removeOrder);
    });

    // A failed job blocks a re-add just as a completed one does.
    it('removes a stale failed job before enqueuing again, inside the lock', async () => {
        const stale = await tickWithStaleJob('failed');

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        expectRemoveBeforeAdd(stale);
    });

    // getJob looks up the same id add() enqueues.
    it('looks the job up by the same id that add() enqueues', async () => {
        await tickWithStaleJob('completed');

        const lookedUpId = (discoverQueue.getJob as jest.Mock).mock.calls[0][0];
        const enqueuedId = (discoverQueue.add as jest.Mock).mock.calls[0][2].jobId;
        expect(lookedUpId).toBe(enqueuedId);
        expect(lookedUpId).toMatch(/^discover-weekly-user-a-\d{4}-\d{2}-\d{2}$/);
    });

    // Two enabled users, no stale hashes: each gets exactly one locked
    // enqueue with a week-keyed jobId.
    it('enqueues one locked job per enabled user with a week-keyed jobId', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
            { userId: 'user-b', playlistSize: 30 },
        ]);

        await tickCron()();

        expect(distributedLock.withLock).toHaveBeenCalledTimes(2);
        expect(discoverQueue.add).toHaveBeenCalledTimes(2);
        for (const call of (discoverQueue.add as jest.Mock).mock.calls) {
            expect(call[2].jobId).toMatch(/^discover-weekly-user-[ab]-\d{4}-\d{2}-\d{2}$/);
        }
    });
});
