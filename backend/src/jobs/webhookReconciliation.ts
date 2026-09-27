/**
 * Webhook Reconciliation Job
 *
 * Self-reschedules every 5 minutes (next run is queued only after the
 * current one finishes, so a slow cycle can't overlap itself) to process
 * unprocessed webhook events (failed/missed webhooks) and retry them.
 *
 * This ensures failed webhook processing gets retried and no events are
 * permanently lost. Periodic Lidarr-snapshot reconciliation of DownloadJob
 * statuses is handled separately by workers/index.ts's runReconciliationCycle.
 */

import { logger } from "../utils/logger";
import { webhookEventStore } from "../services/webhookEventStore";
import { dispatchWebhookEvent } from "../services/webhookHandlers";
import { getSystemSettings } from "../utils/systemSettings";

class WebhookReconciliationService {
    private isRunning = false;
    private cycleRunning = false;
    private timeoutId?: NodeJS.Timeout;
    private readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_RETRIES = 3;

    /**
     * Start the reconciliation loop
     * Safe to call multiple times - won't create duplicate loops
     */
    start() {
        if (this.isRunning) {
            logger.debug("[WEBHOOK-RECONCILE] Already running");
            return;
        }

        this.isRunning = true;
        logger.info(
            `[WEBHOOK-RECONCILE] Started (runs every ${this.RECONCILE_INTERVAL_MS / 1000}s)`
        );

        this.runReconciliation();
    }

    /**
     * Stop the reconciliation loop
     */
    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.isRunning = false;
        logger.info("[WEBHOOK-RECONCILE] Stopped");
    }

    /**
     * Run a single reconciliation cycle
     */
    async runReconciliation() {
        // in-flight guard: a slow cycle (Lidarr latency, large event backlog) must not
        // overlap itself once rescheduled below - only one cycle runs at a time
        if (!this.isRunning || this.cycleRunning) return;
        this.cycleRunning = true;

        try {
            const settings = await getSystemSettings();

            if (!settings?.lidarrEnabled || !settings?.lidarrUrl || !settings?.lidarrApiKey) {
                logger.debug("[WEBHOOK-RECONCILE] Lidarr not configured, skipping");
                return;
            }

            logger.debug("[WEBHOOK-RECONCILE] Starting reconciliation cycle");

            const startTime = Date.now();
            let processedCount = 0;
            let failedCount = 0;

            const unprocessedEvents = await webhookEventStore.getUnprocessedEvents(
                "lidarr",
                this.MAX_RETRIES
            );

            if (unprocessedEvents.length === 0) {
                logger.debug("[WEBHOOK-RECONCILE] No unprocessed events");
            } else {
                logger.debug(
                    `[WEBHOOK-RECONCILE] Found ${unprocessedEvents.length} unprocessed events`
                );

                for (const event of unprocessedEvents) {
                    try {
                        const correlationId = await this.processEvent(event);
                        await webhookEventStore.markProcessed(event.id, correlationId);
                        processedCount++;
                    } catch (error: any) {
                        logger.error(
                            `[WEBHOOK-RECONCILE] Failed to process event ${event.id}:`,
                            error.message
                        );
                        await webhookEventStore.markFailed(event.id, error.message);
                        failedCount++;
                    }
                }
            }

            // Lidarr reconciliation (matching "processing" DownloadJob rows against a Lidarr
            // snapshot) is NOT done here: reconcileWithLidarr() needs a snapshot from
            // lidarrService.getReconciliationSnapshot() - a full artist + album fetch that
            // isn't cached - to do anything; calling it with no snapshot was a permanent
            // no-op. workers/index.ts's runReconciliationCycle already builds that snapshot
            // and reconciles the same rows every 2 minutes, so it's covered there rather
            // than duplicating the Lidarr fetch on this 5-minute loop too.
            const duration = Date.now() - startTime;
            logger.debug(
                `[WEBHOOK-RECONCILE] Cycle complete in ${duration}ms: ` +
                `${processedCount} events processed, ${failedCount} failed`
            );
        } catch (error: any) {
            logger.error("[WEBHOOK-RECONCILE] Reconciliation cycle failed:", error.message);
        } finally {
            this.cycleRunning = false;
            if (this.isRunning) {
                // Schedule next run AFTER this one completes (prevents pile-up)
                this.timeoutId = setTimeout(() => {
                    this.runReconciliation();
                }, this.RECONCILE_INTERVAL_MS);
            }
        }
    }

    /**
     * Process a single webhook event
     */
    private async processEvent(event: any): Promise<string | undefined> {
        const payload = event.payload;
        const eventType = event.eventType;

        logger.debug(
            `[WEBHOOK-RECONCILE] Processing ${eventType} event (retry ${event.retryCount})`
        );

        // Same handlers as the live route (services/webhookHandlers.ts) —
        // including the queueCleaner kick and the scan enqueue that the
        // old private copy dropped, which made replay produce a different
        // end state than live processing.
        return dispatchWebhookEvent(eventType, payload);
    }

    /**
     * Manually trigger reconciliation (for testing)
     */
    async triggerReconciliation(): Promise<void> {
        await this.runReconciliation();
    }
}

export const webhookReconciliation = new WebhookReconciliationService();
