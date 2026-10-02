/**
 * requestScan builds job ids without ':', which BullMQ rejects in custom ids,
 * and dedupes repeated requests on that key.
 */

jest.mock('../queues', () => ({
    scanQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { scanDedupeKey, requestScan } from '../scanRequest';
import { scanQueue } from '../queues';

const mockedQueue = scanQueue as jest.Mocked<typeof scanQueue>;

/** Same rule BullMQ enforces at add() time. */
function assertValidJobId(id: string) {
    expect(id).not.toContain(':');
    expect(id).not.toBe('');
}

beforeEach(() => {
    mockedQueue.getJob.mockReset();
    mockedQueue.add.mockReset();
});

describe('scanDedupeKey', () => {
    test('full and scoped keys carry no colon — BullMQ would reject them', () => {
        const keys = [
            scanDedupeKey({ source: 'test' }),
            scanDedupeKey({ source: 'test', downloadId: 'dl_abc123' }),
            scanDedupeKey({ source: 'test', albumMbid: 'mbid-1' }),
            scanDedupeKey({ source: 'test', discoveryBatchId: 'batch7' }),
        ];
        for (const k of keys) assertValidJobId(k);
    });

    test('scopes map to distinct keys and the unscoped scan is stable', () => {
        expect(scanDedupeKey({ source: 'test' })).toBe(scanDedupeKey({ source: 'other' }));
        const scoped = new Set([
            scanDedupeKey({ source: 't', downloadId: 'dl1' }),
            scanDedupeKey({ source: 't', albumMbid: 'mb2' }),
            scanDedupeKey({ source: 't' }),
        ]);
        expect(scoped.size).toBe(3);
    });
});

describe('requestScan', () => {
    test('enqueues with a BullMQ-valid jobId (the throw this card fixes)', async () => {
        mockedQueue.getJob.mockResolvedValue(undefined as never);
        mockedQueue.add.mockResolvedValue({} as never);

        const res = await requestScan({ source: 'unit-test' });

        expect(res).toEqual({ queued: true, jobId: 'scan-full' });
        const call = mockedQueue.add.mock.calls[0];
        const jobId = call[2]?.jobId;
        expect(jobId).toBe('scan-full');
        assertValidJobId(jobId as string);
    });

    test('a live identical scan is a no-op naming the live job', async () => {
        const live = { getState: jest.fn().mockResolvedValue('active'), remove: jest.fn() };
        mockedQueue.getJob.mockResolvedValue(live as never);

        const res = await requestScan({ source: 'unit-test', discoveryBatchId: 'b1' });

        expect(res).toMatchObject({ queued: false, reason: 'identical scan already active' });
        expect(mockedQueue.add).not.toHaveBeenCalled();
        expect(live.remove).not.toHaveBeenCalled();
    });

    test('a stale terminal marker is replaced so the new request runs', async () => {
        const stale = { getState: jest.fn().mockResolvedValue('completed'), remove: jest.fn() };
        mockedQueue.getJob.mockResolvedValue(stale as never);
        mockedQueue.add.mockResolvedValue({} as never);

        const res = await requestScan({ source: 'unit-test', albumMbid: 'm1' });

        expect(stale.remove).toHaveBeenCalled();
        expect(res.queued).toBe(true);
        assertValidJobId((res as { jobId: string }).jobId);
    });
});
