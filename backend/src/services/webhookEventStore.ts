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

        try {
            const event = await prisma.webhookEvent.create({
                data: {
                    eventId: generatedEventId,
                    source,
                    eventType,
                    payload,
                },
            });

            logger.debug(`[WEBHOOK-STORE] Stored ${source} event: ${eventType} (${event.id})`);
            return { event: event as StoredWebhookEvent, created: true };
        } catch (error: any) {
            if (error.code === 'P2002' && error.meta?.target?.includes('eventId')) {
                logger.debug(`[WEBHOOK-STORE] Duplicate event ignored: ${generatedEventId}`);
                const existing = await prisma.webhookEvent.findUnique({
                    where: { eventId: generatedEventId },
                });
                if (!existing) {
                    throw new Error('Duplicate event but not found in database');
                }
                return { event: existing as StoredWebhookEvent, created: false };
            }
            throw error;
        }
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
     * Get events by correlation ID (find all events for a download job)
     */
    async getEventsByCorrelationId(
        correlationId: string
    ): Promise<StoredWebhookEvent[]> {
        const events = await prisma.webhookEvent.findMany({
            where: { correlationId },
            orderBy: {
                createdAt: 'asc',
            },
        });

        return events as StoredWebhookEvent[];
    }

    /**
     * Get event by Lidarr-provided eventId (for deduplication checking)
     */
    async getEventByEventId(eventId: string): Promise<StoredWebhookEvent | null> {
        const event = await prisma.webhookEvent.findUnique({
            where: { eventId },
        });

        return event as StoredWebhookEvent | null;
    }

    /**
     * Generate a unique event ID from payload
     * Uses downloadId + eventType for Lidarr events
     */
    private generateEventId(source: string, payload: WebhookEventPayload): string {
        if (source === 'lidarr' && payload.downloadId) {
            return `${source}-${payload.eventType}-${payload.downloadId}`;
        }

        const payloadStr = JSON.stringify(payload);
        const hash = crypto.createHash('sha256').update(payloadStr).digest('hex');
        return `${source}-${hash.substring(0, 16)}`;
    }

    /**
     * Clean up old processed events (older than N days)
     */
    async cleanupOldEvents(daysToKeep: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const result = await prisma.webhookEvent.deleteMany({
            where: {
                processed: true,
                createdAt: {
                    lt: cutoffDate,
                },
            },
        });

        if (result.count > 0) {
            logger.info(`[WEBHOOK-STORE] Cleaned up ${result.count} old events`);
        }

        return result.count;
    }
}

export const webhookEventStore = new WebhookEventStore();
