"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";

interface AudiobookshelfSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function AudiobookshelfSection({ settings, onUpdate, onTest, isTesting }: AudiobookshelfSectionProps) {
    const connection = useConnectionTest(() => onTest("audiobookshelf"));

    return (
        <SettingsSection
            id="audiobookshelf"
            title="Media Servers"
            description="Connect to external media servers for audiobooks and podcasts"
        >
            <SettingsRow
                label="Enable Audiobookshelf"
                description="Connect for audiobooks and podcasts"
                htmlFor="abs-enabled"
            >
                <SettingsToggle
                    id="abs-enabled"
                    checked={settings.audiobookshelfEnabled}
                    onChange={(checked) => onUpdate({ audiobookshelfEnabled: checked })}
                />
            </SettingsRow>

            {settings.audiobookshelfEnabled && (
                <>
                    <SettingsRow label="Server URL">
                        <SettingsInput
                            value={settings.audiobookshelfUrl}
                            onChange={(v) => onUpdate({ audiobookshelfUrl: v })}
                            placeholder="http://localhost:13378"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.audiobookshelfApiKey}
                            onChange={(v) => onUpdate({ audiobookshelfApiKey: v })}
                            placeholder="Enter API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={connection.test}
                                disabled={isTesting || !settings.audiobookshelfUrl || !settings.audiobookshelfApiKey}
                            >
                                {connection.status === "loading" ? "Testing..." : "Test Connection"}
                            </Button>
                            <InlineStatus
                                status={connection.status}
                                message={connection.message}
                                onClear={connection.clear}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
