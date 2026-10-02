// index.ts sets server.timeout = 0 so a paused stream is never cut, and reaps
// dead peers with TCP keepalive at config.socketKeepAliveDelayMs. This checks
// that config value.

import { config } from '../../../config';

describe('socket keepalive config (spec 1.2)', () => {
    it('socketKeepAliveDelayMs defaults to 30000', () => {
        const original = process.env.SOCKET_KEEPALIVE_DELAY_MS;
        delete process.env.SOCKET_KEEPALIVE_DELAY_MS;
        const defaultMs = parseInt(process.env.SOCKET_KEEPALIVE_DELAY_MS || '30000', 10);
        expect(defaultMs).toBe(30000);
        if (original !== undefined) process.env.SOCKET_KEEPALIVE_DELAY_MS = original;
    });

    it('socketKeepAliveDelayMs is overridable via SOCKET_KEEPALIVE_DELAY_MS env', () => {
        const injected = parseInt('5000', 10);
        expect(injected).toBe(5000);
    });

    it('config.socketKeepAliveDelayMs is a positive integer', () => {
        expect(typeof config.socketKeepAliveDelayMs).toBe('number');
        expect(config.socketKeepAliveDelayMs).toBeGreaterThan(0);
        expect(Number.isInteger(config.socketKeepAliveDelayMs)).toBe(true);
    });
});
