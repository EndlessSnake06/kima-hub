/**
 * GET /tracks ordering. A sort column that admits ties must be followed by a
 * unique tail, or offset paging can skip or repeat rows between fetches.
 */

jest.mock('../../../middleware/auth', () => ({
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/lrclib', () => ({ lrclibService: {} }));
jest.mock('../../../services/rateLimiter', () => ({ rateLimiter: {} }));

const mockTrackFindMany = jest.fn();
const mockTrackCount = jest.fn();

jest.mock('../../../utils/db', () => ({
    prisma: {
        track: { findMany: mockTrackFindMany, count: mockTrackCount },
    },
    Prisma: { SortOrder: { asc: 'asc', desc: 'desc' } },
}));

import express from 'express';
import request from 'supertest';
import router from '../tracks';
import { prisma } from '../../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockTrackFindMany.mockResolvedValue([]);
    mockTrackCount.mockResolvedValue(0);
});

describe('GET /tracks ordering', () => {
    it('pins a unique tail after the library title sort', async () => {
        await request(makeApp()).get('/tracks?sortBy=name').expect(200);

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: [{ title: 'asc' }, { id: 'asc' }] }),
        );
    });

    it('pins a unique tail after the per-album trackNo sort', async () => {
        await request(makeApp()).get('/tracks?albumId=al-1').expect(200);

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: [{ trackNo: 'asc' }, { id: 'asc' }] }),
        );
    });
});
