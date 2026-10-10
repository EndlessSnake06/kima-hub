"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";

interface AIServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function AIServicesSection({ settings, onUpdate, onTest, isTesting }: AIServicesSectionProps) {
    const fanartTest = useConnectionTest(() => onTest("fanart"), { connected: () => "Connected" });

    return (
        <SettingsSection
            id="ai-services"
            title="AI & Artwork"
            description="Enhance your library with high-quality artwork"
        >
            {/* Fanart.tv */}
            <SettingsRow
                label="Enable Fanart.tv"
                description="Enhanced artist and album artwork"
                htmlFor="fanart-enabled"
            >
                <SettingsToggle
                    id="fanart-enabled"
                    checked={settings.fanartEnabled}
                    onChange={(checked) => onUpdate({ fanartEnabled: checked })}
                />
            </SettingsRow>

            {settings.fanartEnabled && (
                <>
                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.fanartApiKey}
                            onChange={(v) => onUpdate({ fanartApiKey: v })}
                            placeholder="Enter Fanart.tv API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={fanartTest.test}
                                disabled={isTesting || !settings.fanartApiKey}
                            >
                                {fanartTest.status === "loading" ? "Testing..." : "Test Connection"}
                            </Button>
                            <InlineStatus
                                status={fanartTest.status}
                                message={fanartTest.message}
                                onClear={fanartTest.clear}
                            />
                        </div>
                    </div>
                </>
            )}

            {/* AcoustID */}
            <div className="mt-6 pt-6 border-t border-white/5">
                <div className="mb-4">
                    <p className="text-xs text-[var(--text-muted)]">
                        AcoustID identifies tracks by their audio fingerprint. Add your own API key for higher rate limits.
                    </p>
                </div>

                <SettingsRow label="AcoustID API Key (Optional)">
                    <SettingsInput
                        type="password"
                        value={settings.acoustidApiKey || ""}
                        onChange={(v) => onUpdate({ acoustidApiKey: v })}
                        placeholder="Optional: Your AcoustID API key"
                        className="w-64"
                    />
                </SettingsRow>
            </div>
        </SettingsSection>
    );
}
