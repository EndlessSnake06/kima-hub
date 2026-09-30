import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { eventBus, SSEEvent, SSESubscriber } from "../services/eventBus";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

const router = Router();

/**
 * Drop a client once this much unsent data is buffered: a backgrounded tab or
 * dead connection never drains, and the buffer would grow without bound.
 */
const MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * Per-user connection cap. Nothing stopped a client opening streams in a loop;
 * each one held a Response object and a subscription for the life of the
 * process.
 */
const MAX_CONNECTIONS_PER_USER = 5;

/**
 * GET /api/events?ticket=<uuid>
 * SSE endpoint for real-time event streaming.
 * Auth via short-lived, one-time-use ticket obtained from POST /api/events/ticket.
 */
// asyncHandler routes a rejection (Redis down during the ticket lookup) to
// errorHandler: a 500 before the headers, a closed connection after.
router.get("/", asyncHandler(async (req: Request, res: Response) => {
    const ticket = req.query.ticket as string | undefined;
    if (!ticket) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }

    const userId = await redisClient.getdel(`sse:ticket:${ticket}`);
    if (!userId) {
        res.status(401).json({ error: "Invalid or expired ticket" });
        return;
    }

    if (eventBus.connectionCount(userId) >= MAX_CONNECTIONS_PER_USER) {
        logger.warn(
            `[SSE] Refusing connection: userId=${userId} already has ${MAX_CONNECTIONS_PER_USER}`
        );
        res.status(429).json({ error: "Too many event streams open" });
        return;
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });

    // Flush headers immediately to establish SSE connection
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    let closed = false;

    const write = (data: string): boolean => {
        if (closed || res.destroyed || res.writableEnded) return false;

        // Backpressure: if the client is not draining, stop feeding it and cut
        // the connection. It will reconnect; an unbounded buffer will not
        // recover on its own.
        if (res.writableLength > MAX_BUFFERED_BYTES) {
            logger.warn(
                `[SSE] Dropping stalled client: userId=${userId}, ${res.writableLength} bytes unsent`
            );
            teardown();
            return false;
        }

        try {
            res.write(data);
            // Flush through any compression middleware so events are not held
            // back waiting for a full chunk.
            if (typeof (res as any).flush === "function") {
                (res as any).flush();
            }
            return true;
        } catch {
            teardown();
            return false;
        }
    };

    const subscriber: SSESubscriber = {
        send(event: SSEEvent): boolean {
            // Flatten payload into top-level so the frontend can read
            // data.searchId etc. directly.
            const { userId: _uid, payload, ...rest } = event;
            return write(`data: ${JSON.stringify({ ...rest, ...payload })}\n\n`);
        },
    };

    const unsubscribe = eventBus.subscribe(userId, subscriber);

    const heartbeat = setInterval(() => {
        write(`: heartbeat\n\n`);
    }, 30_000);

    function teardown() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) {
            try {
                res.end();
            } catch {
                // already gone
            }
        }
        logger.debug(
            `[SSE] Client disconnected: userId=${userId} (${eventBus.totalConnections()} still open)`
        );
    }

    logger.debug(
        `[SSE] Client connected: userId=${userId} (${eventBus.totalConnections()} open)`
    );

    req.on("close", teardown);
    res.on("error", teardown);
}));

export default router;
