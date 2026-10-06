/**
 * Download-job notifications: one per album, when the download completes or
 * fails for good. Discover and playlist-import jobs report as a batch instead.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

interface NotificationDecision {
    shouldNotify: boolean;
    reason: string;
    notificationType?: "download_complete" | "download_failed";
}

const DEFAULT_RETRY_WINDOW_MINUTES = 30;
// How many of the user's recent terminal jobs are checked for an earlier
// notification of the same album. Retries land close in time, so a bounded
// recent window suffices; a miss costs one extra notification.
const DUPLICATE_CHECK_WINDOW = 100;

class NotificationPolicyService {
    /**
     * Evaluate whether a notification should be sent for a download job.
     *
     * @param jobId - The download job ID
     * @param eventType - The type of event (complete, failed, retry)
     * @returns Decision on whether to send notification
     */
    async evaluateNotification(
        jobId: string,
        eventType: "complete" | "failed" | "retry"
    ): Promise<NotificationDecision> {
        logger.debug(
            `[NOTIFICATION-POLICY] Evaluating: ${jobId} (${eventType})`
        );

        // Fetch job with current state
        const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
        });

        if (!job) {
            return {
                shouldNotify: false,
                reason: "Job not found",
            };
        }

        const metadata = (job.metadata as any) || {};
        const downloadType = metadata.downloadType || "library";

        // Discovery and Spotify Import jobs never send individual notifications
        // (they send batch notifications instead)
        if (downloadType === "discovery" || metadata.spotifyImportJobId) {
            return {
                shouldNotify: false,
                reason: `${downloadType} download - batch notification only`,
            };
        }

        // Check if notification already sent for this job
        if (metadata.notificationSent === true) {
            return {
                shouldNotify: false,
                reason: "Notification already sent for this job",
            };
        }

        // Handle based on job status
        switch (job.status) {
            case "completed":
                return await this.evaluateCompletedJob(job, eventType);

            case "processing":
                return await this.evaluateProcessingJob(job, eventType);

            case "failed":
            case "exhausted":
                return await this.evaluateFailedJob(job, eventType);

            case "pending":
                return {
                    shouldNotify: false,
                    reason: "Job not started yet",
                };

            default:
                return {
                    shouldNotify: false,
                    reason: `Unknown status: ${job.status}`,
                };
        }
    }

    /**
     * Evaluate notification for completed job
     */
    private async evaluateCompletedJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        if (eventType !== "complete") {
            return {
                shouldNotify: false,
                reason: "Invalid event type for completed job",
            };
        }

        // Check if another job for same album already notified
        const hasOtherNotification = await this.hasAlreadyNotified(job);
        if (hasOtherNotification) {
            return {
                shouldNotify: false,
                reason: "Another job for same album already sent notification",
            };
        }

        return {
            shouldNotify: true,
            reason: "Download completed successfully",
            notificationType: "download_complete",
        };
    }

    /**
     * Evaluate notification for processing job
     */
    private async evaluateProcessingJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        // Processing jobs should never send notifications
        // They're still in active retry window
        if (eventType === "complete") {
            return {
                shouldNotify: false,
                reason: "Job still processing - wait for status update to completed",
            };
        }

        if (eventType === "failed" || eventType === "retry") {
            // Check if in retry window
            const inRetryWindow = await this.isInRetryWindow(job);
            if (inRetryWindow) {
                return {
                    shouldNotify: false,
                    reason: "Job in active retry window - suppressing notification",
                };
            }
            // Retry window expired but still processing - extend it
            return {
                shouldNotify: false,
                reason: "Retry window expired but job still processing - extending timeout",
            };
        }

        return {
            shouldNotify: false,
            reason: "Processing job - no notification needed",
        };
    }

    /**
     * Evaluate notification for failed/exhausted job
     */
    private async evaluateFailedJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        if (eventType !== "failed") {
            return {
                shouldNotify: false,
                reason: "Invalid event type for failed job",
            };
        }

        // Check if another job for same album already notified
        const hasOtherNotification = await this.hasAlreadyNotified(job);
        if (hasOtherNotification) {
            return {
                shouldNotify: false,
                reason: "Another job for same album already sent notification",
            };
        }

        return {
            shouldNotify: true,
            reason: "Download failed",
            notificationType: "download_failed",
        };
    }

    /**
     * Check if job is in active retry window
     * A job is in retry window if:
     * 1. Status is 'processing'
     * 2. Started within the last RETRY_WINDOW_MINUTES
     */
    private async isInRetryWindow(job: any): Promise<boolean> {
        if (job.status !== "processing") {
            return false;
        }

        const metadata = (job.metadata as any) || {};

        // Get retry window duration (configurable per job or use default)
        const retryWindowMinutes =
            metadata.retryWindowMinutes || DEFAULT_RETRY_WINDOW_MINUTES;

        // Get start time
        const startedAt = metadata.startedAt
            ? new Date(metadata.startedAt)
            : job.createdAt;

        // Calculate if window has expired
        const windowMs = retryWindowMinutes * 60 * 1000;
        const elapsed = Date.now() - startedAt.getTime();

        if (elapsed > windowMs) {
            logger.debug(
                `[NOTIFICATION-POLICY]   Retry window expired (${Math.round(
                    elapsed / 60000
                )}m > ${retryWindowMinutes}m)`
            );
            return false;
        }

        logger.debug(
            `[NOTIFICATION-POLICY]   In retry window (${Math.round(
                elapsed / 60000
            )}m < ${retryWindowMinutes}m)`
        );
        return true;
    }

    /**
     * Check if another job for the same artist+album has already sent a notification
     * Prevents duplicate notifications when multiple jobs exist for same album
     */
    private async hasAlreadyNotified(job: any): Promise<boolean> {
        const metadata = (job.metadata as any) || {};
        const artistName = metadata?.artistName?.toLowerCase().trim() || "";
        const albumTitle = metadata?.albumTitle?.toLowerCase().trim() || "";

        if (!artistName || !albumTitle) {
            return false;
        }

        // Recent terminal jobs, matched on artist+album in their JSON metadata (Prisma
        // cannot filter JSON portably). completedAt can be null and Postgres sorts
        // NULLS FIRST on DESC, so `nulls: "last"` keeps them from filling the window.
        const otherJobs = await prisma.downloadJob.findMany({
            where: {
                id: { not: job.id },
                userId: job.userId,
                status: { in: ["completed", "failed", "exhausted"] },
            },
            select: { id: true, metadata: true },
            orderBy: { completedAt: { sort: "desc", nulls: "last" } },
            take: DUPLICATE_CHECK_WINDOW,
        });

        for (const otherJob of otherJobs) {
            const otherMeta = (otherJob.metadata as any) || {};
            const otherArtist =
                otherMeta?.artistName?.toLowerCase().trim() || "";
            const otherAlbum =
                otherMeta?.albumTitle?.toLowerCase().trim() || "";

            if (
                otherArtist === artistName &&
                otherAlbum === albumTitle &&
                otherMeta?.notificationSent === true
            ) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Found duplicate notification in job ${otherJob.id}`
                );
                return true;
            }
        }

        return false;
    }
}

// Singleton instance
export const notificationPolicyService = new NotificationPolicyService();
