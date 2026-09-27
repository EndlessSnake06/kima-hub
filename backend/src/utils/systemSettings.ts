import { prisma } from "./db";
import { resolveEncryptedSettings } from "./encryptedFields";

const CACHE_TTL_MS = 60 * 1000;

async function buildSettings() {
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
    });
    if (!settings) return null;
    return resolveEncryptedSettings(settings);
}

let cachedSettings: Awaited<ReturnType<typeof buildSettings>> | null = null;
let cacheExpiry = 0;

export function invalidateSystemSettingsCache() {
    cachedSettings = null;
    cacheExpiry = 0;
}

export async function getSystemSettings(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedSettings && cacheExpiry > now) {
        return { ...cachedSettings };
    }

    const resolved = await buildSettings();
    if (!resolved) {
        cachedSettings = null;
        cacheExpiry = 0;
        return null;
    }

    cachedSettings = resolved;
    cacheExpiry = now + CACHE_TTL_MS;
    return { ...resolved };
}
