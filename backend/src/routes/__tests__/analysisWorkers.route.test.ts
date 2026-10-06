/**
 * Worker sliders scale to the machine: the ceiling is the core count, not a
 * hard-coded 8, so a 16-core box can be driven by all 16 cores.
 */

jest.mock('../../utils/db', () => ({
    prisma: { systemSettings: { upsert: jest.fn() } },
}));
jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), publish: jest.fn().mockResolvedValue(0) },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock('../../middleware/auth', () => ({
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../services/eventBus', () => ({ eventBus: { publish: jest.fn() } }));
jest.mock('../../workers/unifiedEnrichment', () => ({
    triggerEnrichmentNow: jest.fn(),
    recordStageSuccess: jest.fn(),
    recordStageFailure: jest.fn(),
}));
jest.mock('../../services/umapProjection', () => ({ appendTrackToProjection: jest.fn() }));

import express from 'express';
import os from 'os';
import request from 'supertest';
import analysisRoutes from '../analysis';

describe('analysis worker sliders', () => {
    let app: express.Application;
    let cpusSpy: jest.SpyInstance;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/analysis', analysisRoutes);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        cpusSpy = jest.spyOn(os, 'cpus').mockReturnValue(
            Array.from({ length: 16 }, () => ({ model: 'x', speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })) as os.CpuInfo[]
        );
    });

    afterEach(() => cpusSpy.mockRestore());

    it('reports the machine core count as the ceiling', async () => {
        const res = await request(app).get('/analysis/workers');
        expect(res.status).toBe(200);
        expect(res.body.cpuCores).toBe(16);
        expect(res.body.recommended).toBe(8);
    });

    it('accepts every core on a 16-core machine, on both sliders', async () => {
        for (const path of ['/analysis/workers', '/analysis/clap-workers']) {
            const res = await request(app).put(path).send({ workers: 16 });
            expect(res.status).toBe(200);
            expect(res.body.workers).toBe(16);
        }
    });

    it('refuses more workers than cores, on both sliders', async () => {
        for (const path of ['/analysis/workers', '/analysis/clap-workers']) {
            const res = await request(app).put(path).send({ workers: 17 });
            expect(res.status).toBe(400);
        }
    });
});
