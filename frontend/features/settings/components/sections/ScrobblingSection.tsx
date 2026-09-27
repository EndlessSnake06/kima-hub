"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";

interface ScrobblingSectionProps {
    /** Whether a token is already saved (the value itself is never returned). */
    configured: boolean;
    /** Called after a save/clear so the parent refreshes `configured`. */
    onSaved: () => void;
}

/**
 * Per-user ListenBrainz scrobbling. Each user supplies their own optional
 * token — plays are mirrored only for the user who listened, and nobody
 * who leaves this empty pays anything (the path simply skips).
 */
export function ScrobblingSection({
    configured,
    onSaved,
}: ScrobblingSectionProps) {
    const [token, setToken] = useState("");
    const [clearRequested, setClearRequested] = useState(false);
    const [status, setStatus] = useState<StatusType>("idle");
    const [message, setMessage] = useState("");

    const dirty =
        (token.trim().length > 0 && !clearRequested) ||
        (clearRequested && configured);

    const handleSave = async () => {
        setStatus("loading");
        setMessage("Saving...");
        try {
            await api.updateSettings(
                clearRequested
                    ? { listenbrainzToken: null }
                    : { listenbrainzToken: token.trim() }
            );
            setStatus("success");
            setMessage(clearRequested ? "Token removed" : "Scrobbling on");
            setToken("");
            setClearRequested(false);
            onSaved();
        } catch {
            setStatus("error");
            setMessage("Failed to save");
        }
    };

    return (
        <SettingsSection
            id="scrobbling"
            title="ListenBrainz Scrobbling"
            description="Mirror your plays to your own ListenBrainz account (optional)"
        >
            <SettingsRow
                label="User token"
                description="Create one at listenbrainz.org → Settings → Reset token"
                htmlFor="lb-token"
            >
                <SettingsInput
                    type="password"
                    value={token}
                    onChange={setToken}
                    placeholder={configured ? "Token saved — type to replace" : "Paste your LB user token"}
                    className="w-64"
                />
            </SettingsRow>

            {configured && (
                <SettingsRow
                    label="Remove token"
                    description="Stop mirroring to ListenBrainz"
                    htmlFor="lb-token-clear"
                >
                    <input
                        id="lb-token-clear"
                        type="checkbox"
                        checked={clearRequested}
                        onChange={(e) => setClearRequested(e.target.checked)}
                        className="h-4 w-4"
                    />
                </SettingsRow>
            )}

            <div className="pt-2">
                <div className="inline-flex items-center gap-3">
                    <button
                        onClick={handleSave}
                        disabled={!dirty || status === "loading"}
                        className="px-4 py-1.5 text-xs tabular-nums bg-white/5 border border-white/10 text-[var(--text-secondary)] rounded-lg
                            hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        {status === "loading"
                            ? "Saving..."
                            : clearRequested
                              ? "Remove token"
                              : "Save token"}
                    </button>
                    <InlineStatus
                        status={status}
                        message={message}
                        onClear={() => setStatus("idle")}
                    />
                </div>
            </div>
        </SettingsSection>
    );
}
