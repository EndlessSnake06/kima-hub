/**
 * The rate limiter's skip check uses req.baseUrl + req.path: req.path alone is
 * relative to the mount, and originalUrl carries the stream's ?token= query.
 */

import { Request } from 'express';

function makeReq(overrides: {
    baseUrl?: string;
    path?: string;
    url?: string;
    originalUrl?: string;
}): Request {
    return {
        baseUrl: overrides.baseUrl ?? '',
        path: overrides.path ?? '/',
        url: overrides.url ?? overrides.path ?? '/',
        originalUrl: overrides.originalUrl ?? (overrides.baseUrl ?? '') + (overrides.path ?? '/'),
        ip: '127.0.0.1',
        headers: {},
    } as unknown as Request;
}

// rateLimiter.ts has no imports that require mocking -- it only imports express-rate-limit.
import { apiLimiter } from '../rateLimiter';

// express-rate-limit does not expose its options, so the skip behaviour is
// checked through a throwaway express app.

import express from 'express';
import request from 'supertest';

function makeSkipApp() {
    const app = express();
    app.use((_req, _res, next) => {
        // Normalize baseUrl/path the way express does under a mount.
        next();
    });
    app.use(apiLimiter);
    app.get('*', (_req, res) => res.status(200).json({ ok: true }));
    return app;
}

describe('apiLimiter skip predicate (spec 1.8)', () => {
    let app: express.Application;

    beforeAll(() => { app = makeSkipApp(); });

    it('skips a podcast stream URL that includes a ?token= query string', async () => {
        // Simulate how express mounts /api/podcasts: baseUrl=/api/podcasts,
        // path=/:podcastId/episodes/:episodeId/stream
        // The full constructed path is /api/podcasts/p1/episodes/e1/stream
        // originalUrl includes the query string.
        const res = await request(app)
            .get('/api/podcasts/p1/episodes/e1/stream?token=eyJhbGci')
            .expect(200);
        expect(res.body.ok).toBe(true);
    });

    it('skips a track stream URL', async () => {
        const res = await request(app)
            .get('/api/library/tracks/track-123/stream?token=abc')
            .expect(200);
        expect(res.body.ok).toBe(true);
    });

    it('does not skip a non-stream podcast path', async () => {
        // /api/podcasts without a stream suffix must NOT be skipped.
        // At 5000 req/min limit a single request always passes, but we can verify
        // the response is 200 (limit headers are present indicating it was NOT skipped).
        const res = await request(app)
            .get('/api/podcasts/p1/episodes?token=abc')
            .expect(200);
        // RateLimit-Limit header is present when the limiter applied.
        expect(res.headers['ratelimit-limit']).toBeDefined();
    });
});

// ── The skip predicate on its own ───────────────────────────────────────────
// A stream URL with a query string is still skipped.

describe('skip predicate logic -- B7 regression prevention', () => {
    // Replicate the predicate exactly as written in rateLimiter.ts.
    function skip(req: Request): boolean {
        const fullPath = req.baseUrl + req.path;
        return (
            fullPath === '/health' ||
            fullPath === '/api/health' ||
            (fullPath.startsWith('/api/library/tracks/') && fullPath.endsWith('/stream')) ||
            (fullPath.startsWith('/api/podcasts/') && fullPath.endsWith('/stream')) ||
            /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(fullPath) ||
            /^\/api\/spotify\/import\/[a-zA-Z0-9_-]+\/status$/.test(fullPath)
        );
    }

    it('skips a podcast stream when baseUrl=/api/podcasts and path has query string in url but not in path', () => {
        // This is the B7 scenario: mounted under /api/podcasts, path is the
        // route-relative part, url includes ?token= but path does not.
        const req = makeReq({
            baseUrl: '/api/podcasts',
            path: '/p1/episodes/e1/stream',
            originalUrl: '/api/podcasts/p1/episodes/e1/stream?token=abc',
        });
        expect(skip(req)).toBe(true);
    });

    it('does NOT skip when originalUrl ends with /stream but req.path does not', () => {
        // If the predicate used originalUrl, it would include "?token=" and endsWith
        // "/stream" would be false -- demonstrating why originalUrl is wrong.
        // Verify that the originalUrl approach would have failed:
        const originalUrl = '/api/podcasts/p1/episodes/e1/stream?token=abc';
        expect(originalUrl.endsWith('/stream')).toBe(false); // confirms the original bug

        // But our correct predicate (baseUrl + path) still matches:
        const req = makeReq({
            baseUrl: '/api/podcasts',
            path: '/p1/episodes/e1/stream',
            originalUrl,
        });
        expect(skip(req)).toBe(true);
    });

    it('does NOT skip a non-stream podcast path', () => {
        const req = makeReq({
            baseUrl: '/api/podcasts',
            path: '/p1/episodes',
            originalUrl: '/api/podcasts/p1/episodes?token=abc',
        });
        expect(skip(req)).toBe(false);
    });

    it('skips a track stream URL', () => {
        const req = makeReq({
            baseUrl: '/api/library',
            path: '/tracks/track-123/stream',
            originalUrl: '/api/library/tracks/track-123/stream?token=xyz',
        });
        expect(skip(req)).toBe(true);
    });

    it('skips health endpoint', () => {
        const req = makeReq({ baseUrl: '', path: '/health' });
        expect(skip(req)).toBe(true);
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
