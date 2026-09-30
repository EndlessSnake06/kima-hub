/**
 * Lidarr webhooks: each event is stored (deduplicated), answered 200 at once
 * and processed asynchronously, so events survive restarts and can be replayed.
 */

import { Router } from "express";
import { dispatchWebhookEvent } from "../services/webhookHandlers";
import { getSystemSettings } from "../utils/systemSettings";
import { logger } from "../utils/logger";
import crypto from "crypto";
import { webhookEventStore } from "../services/webhookEventStore";
import { webhookEventsTotal, webhookProcessingDuration } from "../utils/metrics";

const router = Router();
let webhookSecretWarned = false;

// GET /webhooks/lidarr/verify - Webhook verification endpoint
router.get("/lidarr/verify", (req, res) => {
    logger.debug("[WEBHOOK] Verification request received");
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "kima",
        version: process.env.npm_package_version || "unknown",
    });
});

// POST /webhooks/lidarr - Handle Lidarr webhooks
router.post("/lidarr", async (req, res) => {
    try {
        // Check if Lidarr is enabled before processing any webhooks
        const settings = await getSystemSettings();
        if (
            !settings?.lidarrEnabled ||
            !settings?.lidarrUrl ||
            !settings?.lidarrApiKey
        ) {
            logger.debug(
                `[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.`
            );
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        // The secret is optional and Lidarr sends none by default, so without one the
        // request is accepted (warned once); the webhook rate limiter bounds abuse.
        if (settings.lidarrWebhookSecret) {
            const providedSecret = req.headers["x-webhook-secret"] as string;

            if (
                !providedSecret ||
                providedSecret.length !== settings.lidarrWebhookSecret.length ||
                !crypto.timingSafeEqual(
                    Buffer.from(providedSecret),
                    Buffer.from(settings.lidarrWebhookSecret)
                )
            ) {
                logger.debug(
                    `[WEBHOOK] Lidarr webhook received with invalid or missing secret`
                );
                return res.status(401).json({
                    error: "Unauthorized - Invalid webhook secret",
                });
            }
        } else if (!webhookSecretWarned) {
            logger.warn(
                "[WEBHOOK] Lidarr webhooks accepted without a lidarrWebhookSecret configured (rate-limited). Set lidarrWebhookSecret in settings to require authentication."
            );
            webhookSecretWarned = true;
        }

        const eventType = req.body.eventType;
        logger.debug(`[WEBHOOK] Lidarr event: ${eventType}`);

        // Log payload in debug mode only
        if (process.env.DEBUG_WEBHOOKS === "true") {
            logger.debug(`   Payload:`, JSON.stringify(req.body, null, 2));
        }

        // STEP 1: Store webhook event immediately (with deduplication)
        const storedEvent = await webhookEventStore.storeEvent(
            "lidarr",
            eventType,
            req.body
        );

        // STEP 2: Respond immediately (don't wait for processing)
        res.json({ success: true, eventId: storedEvent.id });

        // STEP 3: Process event asynchronously
        processWebhookEvent(storedEvent.id, eventType, req.body).catch((error) => {
            logger.error(`[WEBHOOK] Failed to process event ${storedEvent.id}:`, error.message);
        });
    } catch (error: any) {
        logger.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

/**
 * Process webhook event asynchronously through the one shared handler
 * (services/webhookHandlers.ts); this file only does store bookkeeping.
 */
async function processWebhookEvent(
    eventId: string,
    eventType: string,
    payload: any
): Promise<void> {
    const startTime = Date.now();
    let status = 'success';

    try {
        const correlationId = await dispatchWebhookEvent(eventType, payload);
        await webhookEventStore.markProcessed(eventId, correlationId);
    } catch (error: any) {
        status = 'failed';
        logger.error(`[WEBHOOK] Event processing failed:`, error.message);
        await webhookEventStore.markFailed(eventId, error.message);
    } finally {
        const duration = (Date.now() - startTime) / 1000;
        webhookEventsTotal.inc({ event_type: eventType, status });
        webhookProcessingDuration.observe({ event_type: eventType }, duration);
    }
}

export default router;
