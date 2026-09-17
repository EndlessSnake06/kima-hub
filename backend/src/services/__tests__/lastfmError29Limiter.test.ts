/**
 * Verifies the Last.fm error-29 (rate-limit) path through the global rate
 * limiter (rateLimiter.ts).
 *
 * The real defect: Last.fm returns error 29 as HTTP 200 with an error body
 * `{ error: 29, message: "Rate Limit Exceeded ..." }`. In `lastfm.ts`
 * request() that error is thrown with the message
 * `"Last.fm API error 29: Rate Limit Exceeded ..."`.
 *
 * rateLimiter.ts's `isRateLimit` gate (execute() catch block) matches
 * `error.message?.toLowerCase().includes("rate limit")`, so error 29 DOES
 * engage the backoff / circuit-breaker path. This test verifies that
 * contract end-to-end by feeding the real error message through
 * rateLimiter.execute() and asserting the observable outcomes.
 */

import { rateLimiter } from '../rateLimiter';

/** Reset the lastfm service circuit breaker so each test starts deterministic. */
function resetLastfmCircuit(): void {
    const limiter = rateLimiter as unknown as { circuitBreakers: Map<string, any> };
    limiter.circuitBreakers.set('lastfm', {
        isOpen: false,
        openedAt: 0,
        consecutiveFailures: 0,
        resetAfterMs: 30000,
    });
}

describe('Last.fm error 29 routing through the rate limiter (backoff / circuit)', () => {
    beforeEach(() => {
        resetLastfmCircuit();
    });

    it(
        'treats the error-29 body message as a rate-limit error and retries up to maxRetries (4 invocations)',
        async () => {
            // Exact message shape thrown by the patched lastfm.ts request() for error 29.
            const rateLimitMessage =
                'Last.fm API error 29: Rate Limit Exceeded - This application has made too many requests';

            let calls = 0;
            const fn = jest.fn(() => {
                calls++;
                throw new Error(rateLimitMessage);
            });

            // lastfm config: maxRetries = 3. The callback is invoked initially + 3 retries
            // before the limiter gives up and re-throws.
            await expect(
                rateLimiter.execute('lastfm', fn)
            ).rejects.toThrow(rateLimitMessage);

            expect(calls).toBe(4);
        },
        10000
    );

    it(
        'engages exponential backoff between retries (total elapsed >= 6.5 s)',
        () => new Promise<void>(async (resolve, reject) => {
            const rateLimitMessage = 'Last.fm API error 29: Rate Limit Exceeded';

            let calls = 0;
            const fn = jest.fn(() => {
                calls++;
                throw new Error(rateLimitMessage);
            });

            const start = Date.now();
            try {
                await rateLimiter.execute('lastfm', fn);
                reject(new Error('expected execute to throw'));
            } catch (err) {
                const elapsed = Date.now() - start;

                // baseDelay = 1000ms, exponential 2^attempt (1s + 2s + 4s = 7s minimum)
                // plus jitter (0-1s per attempt). A backoff-less path would finish in ms.
                expect(elapsed).toBeGreaterThan(6500);
                expect(calls).toBe(4);
                resolve();
            }
        }),
        10000
    );

    it('does NOT engage backoff / circuit for a plain (non-rate-limit) error: fails on the first attempt', async () => {
        let calls = 0;
        const fn = jest.fn(() => {
            calls++;
            throw new Error('Some non-rate-limit API failure');
        });

        await expect(
            rateLimiter.execute('lastfm', fn)
        ).rejects.toThrow('Some non-rate-limit API failure');

        // Not rate-limited -> no retry, single invocation.
        expect(calls).toBe(1);
    });
});