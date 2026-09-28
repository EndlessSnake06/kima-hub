import type { Queue } from "bullmq";

/**
 * Close a queue without racing its connect handshake. Closing while the
 * connection is still initializing force-disconnects it, and BullMQ 5.x then
 * emits the aborted handshake's rejection on a just-emptied event emitter
 * (fixed upstream in 6.0) which crashes the process. Awaiting the handshake
 * first removes the race — and draining a ready connection is what a
 * deliberate close should do anyway.
 */
export async function closeQueue(queue: Queue): Promise<void> {
    await queue.waitUntilReady().catch(() => {});
    await queue.close().catch(() => {});
}
