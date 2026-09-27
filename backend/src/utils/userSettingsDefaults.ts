import type { Prisma } from "@prisma/client";

// Canonical UserSettings defaults, mirroring the column defaults in
// schema.prisma. Every creation site must use this: previously a row lazily
// created via GET /settings got "medium"/5120 while onboarding, user
// creation, and Subsonic provisioning granted "original"/10240.
export const DEFAULT_USER_SETTINGS = {
    playbackQuality: "original",
    wifiOnly: false,
    offlineEnabled: false,
    maxCacheSizeMb: 10240, // 10 GB
};

export function defaultUserSettingsFor(
    userId: string
): Prisma.UserSettingsUncheckedCreateInput {
    return { userId, ...DEFAULT_USER_SETTINGS };
}
