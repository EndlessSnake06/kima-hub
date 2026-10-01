/**
 * Points Lidarr's "Kima" webhook connection at this server and gives it the
 * shared secret as a header. The secret is saved only once Lidarr has kept the
 * header, so Kima never starts requiring a secret Lidarr cannot send.
 */

import axios from "axios";
import crypto from "crypto";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { encryptSettings } from "../utils/encryptedFields";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";

export const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret";

const EVENTS = {
    onGrab: true,
    onReleaseImport: true,
    onAlbumDownload: true,
    onDownloadFailure: true,
    onImportFailure: true,
    onAlbumDelete: true,
    onRename: true,
    onHealthIssue: false,
    onApplicationUpdate: false,
    supportsOnGrab: true,
    supportsOnReleaseImport: true,
    supportsOnAlbumDownload: true,
    supportsOnDownloadFailure: true,
    supportsOnImportFailure: true,
    supportsOnAlbumDelete: true,
    supportsOnRename: true,
    supportsOnHealthIssue: true,
    supportsOnApplicationUpdate: true,
    includeHealthWarnings: false,
};

export async function configureLidarrWebhook(lidarrUrl: string, apiKey: string): Promise<void> {
    const lidarr = axios.create({
        baseURL: lidarrUrl,
        headers: { "X-Api-Key": apiKey },
        timeout: 10_000,
    });
    const callbackHost = process.env.KIMA_CALLBACK_URL || "http://backend:3006";
    const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

    const { data } = await lidarr.get("/api/v1/notification");
    const notifications = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(notifications)) {
        throw new Error("Unexpected response from /api/v1/notification; not creating a second webhook");
    }
    const existing = notifications.find(
        (n: any) =>
            n.implementation === "Webhook" &&
            (n.name === "Kima" ||
                n.fields?.some(
                    (f: any) =>
                        f.name === "url" &&
                        (f.value?.includes("webhooks/lidarr") || f.value?.includes("lidify"))
                ))
    );
    if (existing && !existing.id) {
        throw new Error(`Lidarr webhook "${existing.name}" has no id; not creating a second one`);
    }

    const storedSecret = (await getSystemSettings())?.lidarrWebhookSecret;
    const secret = storedSecret || crypto.randomBytes(32).toString("hex");
    const config = {
        ...EVENTS,
        name: "Kima",
        implementation: "Webhook",
        implementationName: "Webhook",
        configContract: "WebhookSettings",
        infoLink: "https://wiki.servarr.com/lidarr/supported#webhook",
        tags: [],
        fields: [
            { name: "url", value: webhookUrl },
            { name: "method", value: 1 },
            { name: "username", value: "" },
            { name: "password", value: "" },
            { name: "headers", value: [{ key: WEBHOOK_SECRET_HEADER, value: secret }] },
        ],
    };

    const { data: saved } = existing
        ? await lidarr.put(`/api/v1/notification/${existing.id}?forceSave=true`, { ...existing, ...config })
        : await lidarr.post("/api/v1/notification?forceSave=true", config);
    logger.debug(`[LIDARR] Webhook ${existing ? "updated" : "created"}: ${webhookUrl}`);

    const headers = saved?.fields?.find((f: any) => f.name === "headers")?.value;
    const kept =
        Array.isArray(headers) &&
        headers.some((h: any) => h.key === WEBHOOK_SECRET_HEADER && h.value === secret);
    if (!kept) {
        logger.warn(
            `[LIDARR] Lidarr did not keep the ${WEBHOOK_SECRET_HEADER} header (webhook headers need a newer Lidarr), so its webhooks stay rate-limited` +
                (storedSecret ? " and are refused until it sends the secret" : "")
        );
        return;
    }
    if (secret !== storedSecret) {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: encryptSettings({ lidarrWebhookSecret: secret }),
        });
        invalidateSystemSettingsCache();
    }
}
