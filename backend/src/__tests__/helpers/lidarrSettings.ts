/**
 * Point Kima at a Lidarr for a test the way the settings page does: the URL
 * and an encrypted key on the settings row, then the service reloads them.
 */
import { prisma } from "../../utils/db";
import { encryptField } from "../../utils/encryption";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { lidarrService } from "../../services/lidarr";

export async function useLidarr(url: string, extra: Record<string, unknown> = {}): Promise<void> {
    const data = {
        lidarrEnabled: true,
        lidarrUrl: url,
        lidarrApiKey: encryptField("recorded-scenario"),
        lidarrQualityProfileId: 3,
        lidarrMetadataProfileId: 1,
        lidarrRemoveJunk: true,
        ...extra,
    };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    invalidateSystemSettingsCache();
    lidarrService.reinitialize();
}
