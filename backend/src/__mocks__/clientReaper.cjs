// Every test file's imports can build long-lived ioredis clients (the shared
// redisClient singleton, BullMQ queue connections, enrichmentState's pair) as
// a side effect of importing production code. Jest sandboxes globals per test
// file but shares Node's core module instances, so the registry lives on
// `net` — the one object every file's context sees. Each registered client is
// told to never reconnect (production clients retry forever, and a retry after
// teardown resurrects the socket with nobody left to close it), then quit or
// force-disconnected when the file that had it running finishes. No client
// outlives a file boundary, so the run can exit after the last one.
const net = require('net');
const { zeroDisconnectTimeout } = require('../utils/closeRedisClient');

// Tests install fake timers, which also fake setImmediate/setTimeout. The
// teardown below must run on the real clock even in a file that fakes time, so
// grab the originals at load time — the setup file runs before any test calls
// useFakeTimers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

const registry = net.__testRedisClients || (net.__testRedisClients = new Map());
let seq = net.__testRedisClientSeq || 0;

function register(client) {
    if (!client.__reapId) client.__reapId = ++seq;
    // A client that makes a fresh connection attempt after a reap pass
    // (duplicate(), late init) must be reapable again.
    delete client.__reaped;
    registry.set(client.__reapId, client);
}

try {
    const ioredis = require('ioredis');
    const Redis = ioredis.default || ioredis;
    if (!Redis.__testReaperPatched) {
        Redis.__testReaperPatched = true;

        // connect() is called synchronously by the constructor (unless
        // lazyConnect), so patching it registers every client the moment it is
        // built. Status events cannot be the registration point: ioredis emits
        // them via process.nextTick, and a file using fake timers defers them
        // into the fake clock — those clients would arrive in the registry too
        // late, or never.
        const origConnect = Redis.prototype.connect;
        Redis.prototype.connect = function (...args) {
            register(this);
            return origConnect.apply(this, args);
        };

        const origEmit = Redis.prototype.emit;
        Redis.prototype.emit = function (event, ...args) {
            if (event === 'connecting' || event === 'connect') {
                // Covers connections started without a public connect() call
                // (duplicates, internal retries) — belt for the patch above.
                register(this);
            } else if (event === 'end') {
                registry.delete(this.__reapId);
            }
            return origEmit.apply(this, [event, ...args]);
        };
    }
} catch (err) {
    // ioredis is not resolvable from this context; nothing to reap.
}

async function reap(client) {
    if (client.__reaped) return;
    client.__reaped = true;
    // First: forbid reconnection. ioredis stops retrying when retryStrategy
    // returns null, and reconnectOnError false covers the error path. Without
    // this, disconnect() below just starts an endless retry loop whose socket
    // and log events land after Jest has torn the test environment down.
    client.options.retryStrategy = () => null;
    client.options.reconnectOnError = false;
    if (client.status === 'ready') {
        // Give an in-flight quit a beat; a client mid-handshake would never
        // settle quit(), and disconnect() below covers that case. The guard
        // timer is unref'd so it can never itself keep the process alive once
        // quit() has won the race.
        let guard;
        await Promise.race([
            client.quit().catch(() => {}),
            new Promise((resolve) => {
                guard = realSetTimeout(resolve, 2000);
                guard.unref();
            }),
        ]);
        realClearTimeout(guard);
    }
    if (client.status !== 'end') {
        // disconnect() arms a 2s force-destroy timer on a half-open stream;
        // disarm it so the client dies inside the teardown, not after it.
        zeroDisconnectTimeout(client);
        client.disconnect();
    }
    // ioredis emits its closing status events on process.nextTick; flushing a
    // macrotask here keeps those events (and their logger calls) inside the
    // teardown instead of leaking past "tests are done".
    await new Promise((resolve) => realSetImmediate(resolve));
}

afterAll(async () => {
    // Two passes: a client mid-handshake only settles into 'end' after the
    // first disconnect, and it can re-register between the passes.
    for (let pass = 0; pass < 2; pass++) {
        const open = [...registry.values()];
        if (open.length === 0) break;
        await Promise.all(open.map(reap));
    }
});
