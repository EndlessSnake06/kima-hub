/**
 * scrobble.view records a play, through the real route and real recordPlay.
 * Only Prisma is mocked.
 */

jest.mock('../../../utils/db', () => {
    const prisma = {
        track: { findUnique: jest.fn() },
        play: { findFirst: jest.fn(), create: jest.fn() },
        // recordPlay runs the check and the insert in one transaction behind
        // an advisory lock; run the callback against this same mock and
        // resolve the lock query, since a mock has no Postgres to take it.
        $transaction: (fn: any) => fn(prisma),
        $executeRaw: async () => 1,
    };
    return { prisma };
});

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/liveListening', () => ({
    publicUserId: jest.fn().mockResolvedValue('user-1'),
    getLiveState: jest.fn().mockReturnValue({ status: 'stopped', trackId: null, position: 0 }),
    reportLive: jest.fn(),
}));

jest.mock('../../../services/listenBrainz', () => ({
    listenBrainzService: { submitListens: jest.fn().mockResolvedValue(false) },
}));

import express from 'express';
import request from 'supertest';
import { ListenSource } from '@prisma/client';
import { playbackRouter } from '../playback';
import { prisma } from '../../../utils/db';
import { config } from '../../../config';
import { getLiveState, reportLive } from '../../../services/liveListening';

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    });
    app.use('/rest', playbackRouter);
    return app;
}

describe('scrobble.view records plays', () => {
    const app = makeApp();

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({ id: 'tr-1', duration: 200 });
        (prisma.play.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.play.create as jest.Mock).mockResolvedValue({ id: 'p1' });
    });

    it('writes a SUBSONIC play for submission=true, at the client timestamp', async () => {
        const res = await request(app).get('/rest/scrobble.view?id=tr-1&submission=true&time=1700000000000');
        expect(res.status).toBe(200);
        expect(prisma.play.create).toHaveBeenCalledTimes(1);
        expect(prisma.play.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: 'user-1',
                    trackId: 'tr-1',
                    source: ListenSource.SUBSONIC,
                    playedAt: new Date(1700000000000),
                }),
            }),
        );
    });

    it('writes nothing for a now-playing notification (submission=false)', async () => {
        const res = await request(app).get('/rest/scrobble.view?id=tr-1&submission=false');
        expect(res.status).toBe(200);
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it('keeps the dedupe: a repeat inside the window writes nothing', async () => {
        (prisma.play.findFirst as jest.Mock).mockResolvedValue({ id: 'already' });
        const res = await request(app).get('/rest/scrobble.view?id=tr-1&submission=true');
        expect(res.status).toBe(200);
        expect(prisma.play.create).not.toHaveBeenCalled();
    });
});

describe('scrobble.view now-playing and the public live trip', () => {
    const app = makeApp();
    const original = config.publicVibe;

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({ duration: 200 });
        (getLiveState as jest.Mock).mockReturnValue({ status: 'stopped', trackId: null, position: 0 });
        config.publicVibe = { token: 'x'.repeat(32), username: 'tester' };
    });

    afterAll(() => {
        config.publicVibe = original;
    });

    it('starts the trip at the top of the track for the public user', async () => {
        await request(app).get('/rest/scrobble.view?id=tr-1&submission=false');
        expect(reportLive).toHaveBeenCalledWith({ status: 'playing', trackId: 'tr-1', position: 0, duration: 200_000 });
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it('keeps the position when the same track is announced again', async () => {
        (getLiveState as jest.Mock).mockReturnValue({ status: 'paused', trackId: 'tr-1', position: 42_000 });
        await request(app).get('/rest/scrobble.view?id=tr-1&submission=false');
        expect(reportLive).toHaveBeenCalledWith({ status: 'playing', trackId: 'tr-1', position: 42_000, duration: 200_000 });
    });

    it('reports nothing when the public routes are off', async () => {
        config.publicVibe = null;
        await request(app).get('/rest/scrobble.view?id=tr-1&submission=false');
        expect(reportLive).not.toHaveBeenCalled();
    });

    it('reports nothing for a completed play', async () => {
        await request(app).get('/rest/scrobble.view?id=tr-1&submission=true');
        expect(reportLive).not.toHaveBeenCalled();
    });
});
