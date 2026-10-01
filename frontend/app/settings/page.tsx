"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SubsonicSection } from "@/features/settings/components/sections/SubsonicSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { ScrobblingSection } from "@/features/settings/components/sections/ScrobblingSection";
import { DownloadPreferencesSection } from "@/features/settings/components/sections/DownloadPreferencesSection";
import { LidarrSection } from "@/features/settings/components/sections/LidarrSection";
import { AudiobookshelfSection } from "@/features/settings/components/sections/AudiobookshelfSection";
import { SoulseekSection } from "@/features/settings/components/sections/SoulseekSection";
import { AIServicesSection } from "@/features/settings/components/sections/AIServicesSection";
import { StoragePathsSection } from "@/features/settings/components/sections/StoragePathsSection";
import { CacheSection } from "@/features/settings/components/sections/CacheSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";
import { CorruptTracksSection } from "@/features/settings/components/sections/CorruptTracksSection";
import { Button } from "@/components/ui/Button";

// Define sidebar items
const sidebarItems: SidebarItem[] = [
    { id: "account", label: "Account" },
    { id: "subsonic", label: "Native Apps" },
    { id: "playback", label: "Playback" },
    { id: "scrobbling", label: "Scrobbling" },
    { id: "download-preferences", label: "Download Preferences", adminOnly: true },
    { id: "lidarr", label: "Download Services", adminOnly: true },
    { id: "audiobookshelf", label: "Media Servers", adminOnly: true },
    { id: "soulseek", label: "P2P Networks", adminOnly: true },
    { id: "ai-services", label: "AI & Artwork", adminOnly: true },
    { id: "storage", label: "Storage", adminOnly: true },
    { id: "cache", label: "Library Enrichment", adminOnly: true },
    { id: "corrupt-tracks", label: "Corrupt Tracks", adminOnly: true },
    { id: "users", label: "Users", adminOnly: true },
];

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    // User settings hook
    const {
        settings: userSettings,
        isLoading: userLoading,
        loadError: userLoadError,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
        loadSettings: reloadUserSettings,
    } = useSettingsData();

    // System settings hook (only used if admin)
    const {
        systemSettings,
        isLoading: systemLoading,
        loadError: systemLoadError,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadSystemSettings,
    } = useSystemSettings();

    const loadError = userLoadError ?? (isAdmin ? systemLoadError : null);
    const isLoaded = !userLoading && (!isAdmin || !systemLoading);

    const retryLoad = useCallback(() => {
        reloadUserSettings();
        if (isAdmin) loadSystemSettings();
    }, [isAdmin, reloadUserSettings, loadSystemSettings]);

    // Handle initial hash for section scrolling
    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            if (hash) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 100);
            }
        }
    }, []);

    // Unified save function
    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;

        try {
            await saveUserSettings(userSettings);
        } catch (error) {
            console.error("Failed to save user settings:", error);
            hasError = true;
        }

        if (isAdmin) {
            try {
                await saveSystemSettings(systemSettings);
            } catch (error) {
                console.error("Failed to save system settings:", error);
                hasError = true;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError("Failed to save");
        } else {
            saveStatus.setSuccess("Saved");
        }
    }, [userSettings, systemSettings, isAdmin, saveUserSettings, saveSystemSettings, saveStatus]);

    // Test service wrapper
    const handleTestService = useCallback(async (service: string) => {
        setTestingServices(prev => ({ ...prev, [service]: true }));
        try {
            return await testService(service);
        } finally {
            setTestingServices(prev => ({ ...prev, [service]: false }));
        }
    }, [testService]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    if (loadError) {
        return (
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-6">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        Settings could not be loaded
                    </h2>
                    <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Settings stay hidden until they load, so nothing can be saved over them.
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{loadError}</p>
                    <Button
                        variant="primary"
                        onClick={retryLoad}
                        className="mt-4"
                    >
                        Try again
                    </Button>
                </div>
            </SettingsLayout>
        );
    }

    if (!isLoaded) {
        return (
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                <div className="flex justify-center py-24" aria-busy="true">
                    <GradientSpinner size="md" />
                </div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                {/* Account Section */}
            <div className="section-stack">
                <AccountSection />

                {/* Native Apps - Subsonic */}
                <SubsonicSection />

                {/* Playback Section */}
                <PlaybackSection
                    value={userSettings.playbackQuality}
                    onChange={(quality) => updateUserSettings({ playbackQuality: quality })}
                    // Server-wide, so the row only appears for an admin. Passing
                    // no handler is what hides it.
                    maxQueueLength={isAdmin ? systemSettings.maxQueueLength : undefined}
                    onMaxQueueLength={
                        isAdmin
                            ? (maxQueueLength) => updateSystemSettings({ maxQueueLength })
                            : undefined
                    }
                />

                {/* Per-user ListenBrainz scrobbling — each user's own optional token */}
                <ScrobblingSection
                    configured={!!userSettings.hasListenbrainzToken}
                    onSaved={reloadUserSettings}
                />

                {/* Admin-only sections */}
                {isAdmin && (
                    <>
                        {/* Download Preferences */}
                        <DownloadPreferencesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Download Services - Lidarr */}
                        <LidarrSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.lidarr || false}
                        />

                        {/* Media Servers - Audiobookshelf */}
                        <AudiobookshelfSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.audiobookshelf || false}
                        />

                        {/* P2P Networks - Soulseek */}
                        <SoulseekSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.soulseek || false}
                        />

                        {/* AI Services */}
                        <AIServicesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.openai || testingServices.fanart || false}
                        />

                        {/* Storage */}
                        <StoragePathsSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={false}
                        />

                        {/* Cache & Automation */}
                        <CacheSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Corrupt Tracks */}
                        <CorruptTracksSection />

                        {/* User Management */}
                        <UserManagementSection />
                    </>
                )}
            </div>

                {/* Save Button - Fixed at bottom */}
                <div className="sticky bottom-0 pt-8 pb-8 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a] to-[#0a0a0a]/80">
                    <div className="relative">
                        <Button
                            variant="primary"
                            size="lg"
                            onClick={handleSaveAll}
                            disabled={isSaving}
                            className="w-full"
                        >
                            {isSaving ? "Saving..." : "Save Changes"}
                        </Button>
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2">
                            <InlineStatus {...saveStatus.props} />
                        </div>
                    </div>
                </div>
        </SettingsLayout>
    );
}
