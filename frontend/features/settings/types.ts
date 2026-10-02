/**
 * Settings Types
 * Centralized type definitions for the settings feature
 */

export interface UserSettings {
    playbackQuality: "original" | "high" | "medium" | "low";
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
    /** True when the user saved an LB scrobble token; the value itself is never returned. */
    hasListenbrainzToken?: boolean;
    /** Whether the public live feed shows what this user is playing. */
    shareLiveListening?: boolean;
    /** True only for the user whose listening the server's public feed shares. */
    liveSharingAvailable?: boolean;
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    lidarrQualityProfileId: number | null;
    lidarrMetadataProfileId: number | null;
    // AI Services
    openaiEnabled: boolean;
    openaiApiKey: string;
    openaiModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    acoustidApiKey: string | null;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // Soulseek backend: "p2p" = built-in client, "slskd" = external slskd REST API
    soulseekMode: "p2p" | "slskd";
    slskdUrl: string | null;
    slskdApiKey: string | null;
    // Spotify (for playlist import)
    spotifyClientId: string;
    spotifyClientSecret: string;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    /** How many tracks the play queue may hold, per user. */
    maxQueueLength: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    autoEnrichMetadata: boolean;
    audioAnalyzerWorkers: number;
    soulseekConcurrentDownloads: number;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr";
    primaryFailureFallback: "none" | "lidarr" | "soulseek";
    // Server
    publicUrl: string;
}

export interface ApiKey {
    id: string;
    name: string;
    keyPreview?: string;
    createdAt: string;
    lastUsed?: string | null;
    lastUsedAt?: string | null;
}

