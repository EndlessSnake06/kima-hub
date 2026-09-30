import type { Queue } from "bullmq";

/**
 * Close a queue after its connect handshake: closing mid-handshake makes
 * BullMQ 5.x emit a rejection with no listener, which crashes the process.
 */
export async function closeQueue(queue: Queue): Promise<void> {
    await queue.waitUntilReady().catch(() => {});
    await queue.close().catch(() => {});
}
