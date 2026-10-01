/**
 * Recovers Lidarr events whose webhook never arrived. Each history record is
 * stored as the webhook payload Lidarr would have sent, under the same event id,
 * so an event is handled once whichever way it reached Kima.
 */

import { prisma } from "../utils/db";
import { getHistorySince } from "./lidarr";
import { webhookEventStore } from "./webhookEventStore";
import { processStoredEvent } from "./webhookHandlers";
import type { LidarrHistoryRecord } from "../types/lidarr";

const LOOKBACK_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;

// Lidarr's EntityHistoryEventType and the webhook event it sends for it.
const HISTORY_EVENTS = [
    { historyType: 1, eventType: "Grab" },
    { historyType: 8, eventType: "Download" },
    { historyType: 4, eventType: "DownloadFailure" },
    { historyType: 7, eventType: "ImportFailure" },
];

export function toWebhookPayload(eventType: string, record: LidarrHistoryRecord) {
    const album = record.album && {
        id: record.album.id,
        mbId: record.album.foreignAlbumId,
        title: record.album.title,
    };
    const base = {
        eventType,
        downloadId: record.downloadId,
        artist: record.artist && { name: record.artist.artistName },
    };
    if (eventType === "Grab") {
        return { ...base, albums: album ? [album] : [], release: { releaseTitle: record.sourceTitle } };
    }
    return { ...base, album, ...(record.data?.message && { message: record.data.message }) };
}

/**
 * Reads history from 10 minutes before the newest stored Lidarr event (at most
 * 7 days back) and handles each record not seen yet. Returns how many were new.
 */
export async function recoverMissedEvents(lidarrUrl: string, apiKey: string): Promise<number> {
    const now = Date.now();
    const newest = await prisma.webhookEvent.findFirst({
        where: { source: "lidarr" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
    });
    const floor = now - LOOKBACK_FLOOR_MS;
    const since = new Date(Math.max(floor, (newest?.createdAt.getTime() ?? floor) - OVERLAP_MS));

    let recovered = 0;
    for (const { historyType, eventType } of HISTORY_EVENTS) {
        const records = await getHistorySince(lidarrUrl, apiKey, since, historyType);
        for (const record of records) {
            if (!record.downloadId) continue;
            const payload = toWebhookPayload(eventType, record);
            const { event, created } = await webhookEventStore.storeEvent("lidarr", eventType, payload);
            if (!created) continue;
            recovered++;
            await processStoredEvent(event.id, eventType, payload);
        }
    }
    return recovered;
}
