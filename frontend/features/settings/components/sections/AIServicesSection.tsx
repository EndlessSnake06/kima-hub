"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";

interface AIServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function AIServicesSection({ settings, onUpdate, onTest, isTesting }: AIServicesSectionProps) {
    const [fanartTestStatus, setFanartTestStatus] = useState<StatusType>("idle");
    const [fanartTestMessage, setFanartTestMessage] = useState("");

    const handleFanartTest = async () => {
        setFanartTestStatus("loading");
        setFanartTestMessage("Testing...");
        const result = await onTest("fanart");
        if (result.success) {
            setFanartTestStatus("success");
            setFanartTestMessage("Connected");
        } else {
            setFanartTestStatus("error");
            setFanartTestMessage(result.error || "Failed");
        }
    };

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
                                onClick={handleFanartTest}
                                disabled={isTesting || !settings.fanartApiKey}
                            >
                                {fanartTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </Button>
                            <InlineStatus
                                status={fanartTestStatus}
                                message={fanartTestMessage}
                                onClear={() => setFanartTestStatus("idle")}
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
