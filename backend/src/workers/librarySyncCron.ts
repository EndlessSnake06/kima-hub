/**
 * Library Auto-Sync Cron
 *
 * When the "Auto sync library" setting is enabled, periodically enqueues a full
 * library scan so music added outside the download pipeline (manual file drops,
 * external tools) is picked up without a manual scan. Download-completion
 * webhooks already trigger scans; this is the fallback for everything else.
 *
 * Scans go through requestScan, which dedupes on the shared "scan:full"
 * key -- a tick while one is queued or running is a no-op.
 */

import { logger } from "../utils/logger";
import cron, { ScheduledTask } from "node-cron";
import { getSystemSettings } from "../utils/systemSettings";
import { requestScan } from "./scanRequest";

let cronTask: ScheduledTask | null = null;

export function startLibrarySyncCron() {
    // Every 6 hours. Cron format: minute hour day-of-month month day-of-week
    const schedule = "0 */6 * * *";
    logger.debug(`Scheduling library auto-sync: ${schedule} (every 6h)`);

    cronTask = cron.schedule(schedule, async () => {
        try {
            const settings = await getSystemSettings();
            if (!settings?.autoSync) {
                logger.debug("[LibrarySync] autoSync disabled, skipping");
                return;
            }

            // requestScan dedupes: if any full scan is already waiting,
            // delayed, or active, this tick is a no-op.
            const result = await requestScan({
                source: "auto-sync",
            });
            if (result.queued) {
                logger.debug("[LibrarySync] Enqueued automatic library scan");
            } else {
                logger.debug(`[LibrarySync] ${result.reason}, skipping`);
            }
        } catch (error: any) {
            logger.error("[LibrarySync] cron error:", error.message);
        }
    });

    logger.debug("Library auto-sync cron scheduler started");
}

export function stopLibrarySyncCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        logger.debug("Library auto-sync cron scheduler stopped");
    }
}
