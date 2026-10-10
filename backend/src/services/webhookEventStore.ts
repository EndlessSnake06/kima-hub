/**
 * Lidarr webhook events, stored before processing so they survive restarts and
 * can be replayed.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import * as crypto from "crypto";

interface WebhookEventPayload {
    eventType: string;
    [key: string]: any;
}

interface StoredWebhookEvent {
    id: string;
    eventId: string;
    source: string;
    eventType: string;
    payload: WebhookEventPayload;
    processed: boolean;
    processedAt: Date | null;
    correlationId: string | null;
    error: string | null;
    retryCount: number;
    createdAt: Date;
}

class WebhookEventStore {
    /**
     * Stores an event once per eventId. `created` is false when the event was
     * already stored, so only its first arrival is processed.
     */
    async storeEvent(
        source: string,
        eventType: string,
        payload: WebhookEventPayload,
        eventId?: string
    ): Promise<{ event: StoredWebhookEvent; created: boolean }> {
        const generatedEventId = eventId || this.generateEventId(source, payload);

        const { count } = await prisma.webhookEvent.createMany({
            data: [{ eventId: generatedEventId, source, eventType, payload }],
            skipDuplicates: true,
        });
        const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: generatedEventId } });
        if (count === 0) {
            logger.debug(`[WEBHOOK-STORE] Duplicate event ignored: ${generatedEventId}`);
            return { event: event as StoredWebhookEvent, created: false };
        }
        logger.debug(`[WEBHOOK-STORE] Stored ${source} event: ${eventType} (${event.id})`);
        return { event: event as StoredWebhookEvent, created: true };
    }

    /** Whether an event is already stored, under the id `storeEvent` would give it. */
    async isStored(source: string, payload: WebhookEventPayload): Promise<boolean> {
        const eventId = this.generateEventId(source, payload);
        return (await prisma.webhookEvent.count({ where: { eventId } })) > 0;
    }

    /**
     * Mark an event as processed successfully
     */
    async markProcessed(
        eventId: string,
        correlationId?: string
    ): Promise<void> {
        await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
                processed: true,
                processedAt: new Date(),
                correlationId: correlationId || undefined,
            },
        });

        logger.debug(`[WEBHOOK-STORE] Marked processed: ${eventId}`);
    }

    /**
     * Mark an event as failed (stores error and increments retry count)
     */
    async markFailed(
        eventId: string,
        error: string
    ): Promise<void> {
        await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
                error,
                retryCount: {
                    increment: 1,
                },
            },
        });

        logger.debug(`[WEBHOOK-STORE] Marked failed: ${eventId} - ${error}`);
    }

    /**
     * Unprocessed events under the retry cap, skipping those stored in the
     * last `minAgeMs` (still being processed by the route that stored them).
     */
    async getUnprocessedEvents(
        source?: string,
        maxRetries: number = 3,
        minAgeMs: number = 0
    ): Promise<StoredWebhookEvent[]> {
        const events = await prisma.webhookEvent.findMany({
            where: {
                processed: false,
                retryCount: {
                    lt: maxRetries,
                },
                createdAt: { lte: new Date(Date.now() - minAgeMs) },
                ...(source && { source }),
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        return events as StoredWebhookEvent[];
    }

    /**
     * The event's id: for Lidarr its type and download id, plus the album for an
     * import event, since Lidarr sends one per album a download carries (a bundle
     * carries several); anything else by a hash of its payload.
     */
    private generateEventId(source: string, payload: WebhookEventPayload): string {
        if (source === 'lidarr' && payload.downloadId) {
            const album = payload.eventType === "Download" || payload.eventType === "ImportFailure" ? payload.album?.id : undefined;
            return `${source}-${payload.eventType}-${payload.downloadId}${album ? `-${album}` : ""}`;
        }

        const payloadStr = JSON.stringify(payload);
        const hash = crypto.createHash('sha256').update(payloadStr).digest('hex');
        return `${source}-${hash.substring(0, 16)}`;
    }

    /**
     * Delete events older than `daysToKeep`, including those that ran out of
     * retries: by then the download sweeps have settled their jobs.
     */
    async cleanupOldEvents(daysToKeep: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const result = await prisma.webhookEvent.deleteMany({
            where: { createdAt: { lt: cutoffDate } },
        });

        if (result.count > 0) {
            logger.info(`[WEBHOOK-STORE] Cleaned up ${result.count} old events`);
        }

        return result.count;
    }
}

export const webhookEventStore = new WebhookEventStore();
