import { apiLimiter } from '../rateLimiter';
import express from 'express';
import request from 'supertest';

// express-rate-limit does not expose its options, so the skip behaviour is
// checked through a throwaway express app: a skipped request carries no RateLimit-* headers.
function makeSkipApp() {
    const app = express();
    app.use(apiLimiter);
    app.get('*', (_req, res) => res.status(200).json({ ok: true }));
    return app;
}

describe('apiLimiter skip predicate', () => {
    let app: express.Application;

    beforeAll(() => { app = makeSkipApp(); });

    it('skips a podcast stream URL that includes a ?token= query string', async () => {
        const res = await request(app)
            .get('/api/podcasts/p1/episodes/e1/stream?token=eyJhbGci')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('skips a track stream URL', async () => {
        const res = await request(app)
            .get('/api/library/tracks/track-123/stream?token=abc')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('skips the health endpoint', async () => {
        const res = await request(app).get('/health').expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('does not skip a non-stream podcast path', async () => {
        const res = await request(app)
            .get('/api/podcasts/p1/episodes?token=abc')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeDefined();
    });
});

describe('createRateLimiter', () => {
    it('raises no proxy-trust warning behind the trusted proxy chain', async () => {
        const { createRateLimiter } = await import('../rateLimiter');
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const app = express();
        app.set('trust proxy', true);
        app.use(createRateLimiter({ windowMs: 60 * 1000, max: 10 }));
        app.get('*', (_req, res) => res.status(200).json({ ok: true }));

        await request(app).get('/rest/ping.view').set('X-Forwarded-For', '10.0.0.5').expect(200);

        const warned = errors.mock.calls.some((args) =>
            args.some((a) => String((a as Error)?.message ?? a).includes('ERR_ERL_PERMISSIVE_TRUST_PROXY') ||
                (a as { code?: string })?.code === 'ERR_ERL_PERMISSIVE_TRUST_PROXY'));
        errors.mockRestore();
        expect(warned).toBe(false);
    });
});
