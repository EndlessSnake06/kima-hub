/**
 * Webhook Route Tests
 *
 * Tests the Lidarr webhook endpoint (/webhooks/lidarr) using supertest.
 * Covers: Lidarr-disabled guard, webhook secret validation, accepted event
 * types, unknown event types, and missing fields.
 *
 * Event processing is asynchronous (fire-and-forget after the 200 response),
 * so we test the HTTP surface only and verify the downstream services are
 * called via mocks on the happy paths.
 */

// All mocks must be before imports
jest.mock('../../utils/db', () => ({
    prisma: {
        systemSettings: { findUnique: jest.fn() },
        webhookEvent: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
        downloadJob: { findUnique: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../workers/queues', () => ({
    scanQueue: { add: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../../services/simpleDownloadManager', () => ({
    simpleDownloadManager: {
        onDownloadGrabbed: jest.fn().mockResolvedValue({ matched: false }),
        onDownloadComplete: jest.fn().mockResolvedValue({ jobId: null }),
        onImportFailed: jest.fn().mockResolvedValue({ jobId: null }),
    },
}));

jest.mock('../../jobs/queueCleaner', () => ({
    queueCleaner: { start: jest.fn() },
}));

jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));

jest.mock('../../services/webhookEventStore', () => ({
    webhookEventStore: {
        storeEvent: jest.fn(),
        markProcessed: jest.fn(),
        markFailed: jest.fn(),
    },
}));

jest.mock('../../utils/metrics', () => ({
    webhookEventsTotal: { inc: jest.fn() },
    webhookProcessingDuration: { observe: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import webhookRoutes from '../../routes/webhooks';
import { getSystemSettings } from '../../utils/systemSettings';
import { webhookEventStore } from '../../services/webhookEventStore';
import { simpleDownloadManager } from '../../services/simpleDownloadManager';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/webhooks', webhookRoutes);
    return app;
}

const ENABLED_SETTINGS = {
    lidarrEnabled: true,
    lidarrUrl: 'http://lidarr:8686',
    lidarrApiKey: 'test-api-key',
    lidarrWebhookSecret: null,
};

const STORED_EVENT = {
    id: 'evt-id-1',
    eventId: 'hash-abc',
    source: 'lidarr',
    eventType: 'Grab',
    payload: {},
    processed: false,
    processedAt: null,
    correlationId: null,
    error: null,
    retryCount: 0,
    createdAt: new Date(),
};

describe('GET /webhooks/lidarr/verify', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });

    it('returns 200 with status ok', async () => {
        const res = await request(app).get('/webhooks/lidarr/verify');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.service).toBe('kima');
        expect(res.body.timestamp).toBeDefined();
    });
});

describe('POST /webhooks/lidarr -- Lidarr disabled', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 202 ignored when Lidarr is not enabled', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrEnabled: false,
            lidarrUrl: null,
            lidarrApiKey: null,
            lidarrWebhookSecret: null,
        });

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Grab' });

        expect(res.status).toBe(202);
        expect(res.body.ignored).toBe(true);
        expect(res.body.reason).toBe('lidarr-disabled');
    });

    it('returns 202 when settings are null', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(null);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Test' });

        expect(res.status).toBe(202);
    });
});

describe('POST /webhooks/lidarr -- webhook secret validation', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 401 when a webhook secret is configured and none is provided', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue({
            ...ENABLED_SETTINGS,
            lidarrWebhookSecret: 'my-super-secret',
        });

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Test' });

        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/Unauthorized/i);
    });

    it('returns 401 when the provided secret does not match', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue({
            ...ENABLED_SETTINGS,
            lidarrWebhookSecret: 'my-super-secret',
        });

        const res = await request(app)
            .post('/webhooks/lidarr')
            .set('x-webhook-secret', 'wrong-secret')
            .send({ eventType: 'Test' });

        expect(res.status).toBe(401);
    });

    it('accepts the request when the correct secret is provided', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue({
            ...ENABLED_SETTINGS,
            lidarrWebhookSecret: 'correct-secret',
        });
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: STORED_EVENT, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .set('x-webhook-secret', 'correct-secret')
            .send({ eventType: 'Test' });

        expect(res.status).toBe(200);
    });
});

describe('POST /webhooks/lidarr -- event handling', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('stores event and returns 200 with eventId for a Grab event', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: STORED_EVENT, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const payload = {
            eventType: 'Grab',
            downloadId: 'dl-abc-123',
            artist: { name: 'Radiohead' },
            albums: [{ id: 1, title: 'OK Computer', mbId: 'mbid-ok-computer' }],
        };

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.eventId).toBe('evt-id-1');
        expect(webhookEventStore.storeEvent).toHaveBeenCalledWith('lidarr', 'Grab', payload);
    });

    it('does not process an event Lidarr sent again', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: { ...STORED_EVENT, eventType: 'Download' }, created: false });

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Download', downloadId: 'dl-xyz', album: { id: 2, mbId: 'mbid-lateralus' } });
        await new Promise((resolve) => setImmediate(resolve));

        expect(res.status).toBe(200);
        expect(simpleDownloadManager.onDownloadComplete).not.toHaveBeenCalled();
    });

    it('stores and returns 200 for a Download event', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        const downloadEvent = { ...STORED_EVENT, eventType: 'Download' };
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: downloadEvent, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({
                eventType: 'Download',
                downloadId: 'dl-xyz',
                artist: { name: 'Tool' },
                album: { id: 2, title: 'Lateralus', mbId: 'mbid-lateralus' },
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('handles ImportFailure event without error', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        const failEvent = { ...STORED_EVENT, eventType: 'ImportFailure' };
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: failEvent, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({
                eventType: 'ImportFailure',
                downloadId: 'dl-fail-1',
                message: 'CRC check failed',
                album: { title: 'Some Album' },
            });

        expect(res.status).toBe(200);
        expect(simpleDownloadManager.onImportFailed).toHaveBeenCalled();
    });

    it('handles Health event (no-op) without error', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        const healthEvent = { ...STORED_EVENT, eventType: 'Health' };
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: healthEvent, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Health' });

        expect(res.status).toBe(200);
    });

    it('handles Test event (no-op) without error', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        const testEvent = { ...STORED_EVENT, eventType: 'Test' };
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: testEvent, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Test' });

        expect(res.status).toBe(200);
    });

    it('handles unknown event types gracefully (logs debug, no crash)', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        const unknownEvent = { ...STORED_EVENT, eventType: 'UnknownFutureEvent' };
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: unknownEvent, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'UnknownFutureEvent' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('handles missing downloadId in Grab gracefully', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: STORED_EVENT, created: true });
        (webhookEventStore.markProcessed as jest.Mock).mockResolvedValue(undefined);

        // No downloadId -- simpleDownloadManager should not be called
        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({
                eventType: 'Grab',
                artist: { name: 'Radiohead' },
                albums: [{ title: 'OK Computer' }],
                // downloadId intentionally absent
            });

        expect(res.status).toBe(200);
        expect(simpleDownloadManager.onDownloadGrabbed).not.toHaveBeenCalled();
    });

    it('returns 500 when storeEvent throws', async () => {
        (getSystemSettings as jest.Mock).mockResolvedValue(ENABLED_SETTINGS);
        (webhookEventStore.storeEvent as jest.Mock).mockRejectedValue(new Error('DB down'));

        const res = await request(app)
            .post('/webhooks/lidarr')
            .send({ eventType: 'Grab' });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Webhook processing failed');
    });
});

describe('POST /webhooks/lidarr -- rate limit', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (getSystemSettings as jest.Mock).mockResolvedValue({
            ...ENABLED_SETTINGS,
            lidarrWebhookSecret: 'correct-secret',
        });
        (webhookEventStore.storeEvent as jest.Mock).mockResolvedValue({ event: STORED_EVENT, created: true });
    });

    it('never limits requests carrying the secret, and limits the rest', async () => {
        for (let i = 0; i < 130; i++) {
            const res = await request(app)
                .post('/webhooks/lidarr')
                .set('x-webhook-secret', 'correct-secret')
                .send({ eventType: 'Test' });
            expect(res.status).toBe(200);
        }

        const statuses: number[] = [];
        for (let i = 0; i < 130; i++) {
            const res = await request(app)
                .post('/webhooks/lidarr')
                .set('x-webhook-secret', 'wrong-secret')
                .send({ eventType: 'Test' });
            statuses.push(res.status);
        }
        expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
        expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
    });
});
