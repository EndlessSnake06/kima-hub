// index.ts sets server.timeout = 0 so a paused stream is never cut, and reaps
// dead peers with TCP keepalive at config.socketKeepAliveDelayMs.

import { config } from '../../../config';

describe('socket keepalive config', () => {
    it('config.socketKeepAliveDelayMs is a positive integer', () => {
        expect(typeof config.socketKeepAliveDelayMs).toBe('number');
        expect(config.socketKeepAliveDelayMs).toBeGreaterThan(0);
        expect(Number.isInteger(config.socketKeepAliveDelayMs)).toBe(true);
    });
});
