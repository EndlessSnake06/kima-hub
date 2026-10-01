/**
 * Every 2 minutes: recovers Lidarr events whose webhook never arrived, then
 * retries stored events that are still unprocessed. Each cycle reschedules
 * after it finishes, so cycles never overlap.
 */

import { logger } from "../utils/logger";
import { webhookEventStore } from "../services/webhookEventStore";
import { processStoredEvent } from "../services/webhookHandlers";
import { recoverMissedEvents } from "../services/lidarrHistoryRecovery";
import { getSystemSettings } from "../utils/systemSettings";

class WebhookReconciliationService {
    private isRunning = false;
    private cycleRunning = false;
    private timeoutId?: NodeJS.Timeout;
    private readonly RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
    private readonly MAX_RETRIES = 3;
    // The webhook route is still processing events younger than this.
    private readonly IN_FLIGHT_MS = 60 * 1000;

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

            const recovered = await recoverMissedEvents(settings.lidarrUrl, settings.lidarrApiKey);
            if (recovered > 0) {
                logger.info(`[WEBHOOK-RECONCILE] Recovered ${recovered} event(s) from Lidarr history`);
            }

            const unprocessedEvents = await webhookEventStore.getUnprocessedEvents(
                "lidarr",
                this.MAX_RETRIES,
                this.IN_FLIGHT_MS
            );
            for (const event of unprocessedEvents) {
                await processStoredEvent(event.id, event.eventType, event.payload);
            }
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
     * Manually trigger reconciliation (for testing)
     */
    async triggerReconciliation(): Promise<void> {
        await this.runReconciliation();
    }
}

export const webhookReconciliation = new WebhookReconciliationService();
