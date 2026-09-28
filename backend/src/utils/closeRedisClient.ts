import type { Redis } from "ioredis";

/**
 * Close a client: graceful when it is actually connected (quit drains
 * pending replies), immediate otherwise. quit() on a client that is still
 * connecting never settles and strands its socket — with a slow Redis that
 * is how a teardown hangs the process it was supposed to release.
 *
 * A rejected quit means the connection died before draining — the client is
 * closed, which is the whole request, so the rejection is swallowed rather
 * than surfaced. Teardowns can race this with the harness reaper
 * (src/__mocks__/clientReaper.cjs); a double close must not fail the suite.
 */
export function closeClient(client: Redis): Promise<void> {
    if (client.status === "ready") {
        return client.quit().then(
            () => undefined,
            () => undefined
        );
    }
    zeroDisconnectTimeout(client);
    client.disconnect();
    return Promise.resolve();
}

/**
 * Disarm the cleanup timer that disconnect() arms. disconnect() ends the
 * stream but leaves a timer standing that force-destroys it after ioredis's
 * disconnectTimeout (2s) if the peer hasn't closed by then — that pending
 * timer outlives the teardown that created it, Jest sees a live handle at
 * process exit, and force-kills the worker. Zeroing the timeout makes the
 * stream die inside disconnect() instead. The connector is created once per
 * client and reads disconnectTimeout at disconnect time, so this applies to
 * every later disconnect. `connector` is an instance field of ioredis's Redis
 * (typed private); the field name is stable through the full v5 line.
 */
export function zeroDisconnectTimeout(client: Redis): void {
    const internals = client as unknown as {
        connector?: { disconnectTimeout?: number };
    };
    if (internals.connector) {
        internals.connector.disconnectTimeout = 0;
    }
}
