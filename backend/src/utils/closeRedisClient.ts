import type { Redis } from "ioredis";

/**
 * Close a client: quit() when connected, so pending replies drain, else
 * disconnect() (quit on a connecting client never settles). A rejected quit
 * is swallowed: the client is closed either way, and teardown may race the
 * test reaper.
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
 * Zero ioredis's disconnectTimeout so disconnect() destroys the stream at once
 * instead of leaving a 2 s timer that keeps the process (and Jest) alive.
 * `connector` is a private field of ioredis v5's Redis.
 */
export function zeroDisconnectTimeout(client: Redis): void {
    const internals = client as unknown as {
        connector?: { disconnectTimeout?: number };
    };
    if (internals.connector) {
        internals.connector.disconnectTimeout = 0;
    }
}
