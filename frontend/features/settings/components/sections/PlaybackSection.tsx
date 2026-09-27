"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsSelect, SettingsInput } from "../ui";
import { UserSettings } from "../../types";
import { useTrackFormat } from "@/hooks/useTrackFormat";
import { formatTrackDisplay } from "@/lib/track-format";

interface PlaybackSectionProps {
    value: UserSettings["playbackQuality"];
    onChange: (quality: UserSettings["playbackQuality"]) => void;
    /** Server-wide, so only shown to an admin. */
    maxQueueLength?: number;
    onMaxQueueLength?: (value: number) => void;
}

/** The same bounds the server validates against (routes/systemSettings.ts), so the field cannot offer a value it will not keep. */
export const QUEUE_MIN = 100;
export const QUEUE_MAX = 100000;

const qualityOptions = [
    { value: "original", label: "Original (Lossless)" },
    { value: "high", label: "High (320 kbps)" },
    { value: "medium", label: "Medium (192 kbps)" },
    { value: "low", label: "Low (128 kbps)" },
];

const SAMPLE_TRACK = {
    title: "Midnight Rain",
    artist: "Taylor Swift",
    album: "Midnights",
    filename: "/music/Taylor Swift/Midnights/04 Midnight Rain.flac",
};

/**
 * The queue-limit box.
 *
 * It used to clamp on every keystroke, so typing 5000 went 5 -> 100 (clamped
 * up), then 1000, 10000, 100000: the box ended on twenty times what was typed.
 * Now what is typed stays as typed while the box has focus, and the clamp
 * happens once, when the box loses focus (which clicking Save always causes).
 * Every whole number typed is still passed up as it is typed, unclamped, so a
 * save that somehow skipped the blur sends what the admin actually typed and
 * the server's validation -- the authority -- rejects it if it is out of range.
 */
export function QueueLimitInput({
    value,
    onCommit,
}: {
    value: number | undefined;
    onCommit: (value: number) => void;
}) {
    // null while the box is not being edited: it then shows the saved value.
    const [draft, setDraft] = useState<string | null>(null);

    const commit = () => {
        if (draft === null) return;
        const n = Number(draft);
        if (draft.trim() !== "" && Number.isFinite(n)) {
            onCommit(Math.min(QUEUE_MAX, Math.max(QUEUE_MIN, Math.floor(n))));
        } else if (value !== undefined) {
            // Emptied or not a number: put back the value that is in effect.
            onCommit(value);
        }
        setDraft(null);
    };

    // React's onBlur bubbles, so the wrapper hears the input lose focus
    // without SettingsInput needing a blur prop of its own.
    return (
        <div className="contents" onBlur={commit}>
            <SettingsInput
                type="number"
                value={draft ?? String(value ?? "")}
                onChange={(v) => {
                    setDraft(v);
                    const n = Number(v);
                    if (v.trim() !== "" && Number.isInteger(n)) onCommit(n);
                }}
                placeholder="10000"
            />
        </div>
    );
}

export function PlaybackSection({ value, onChange, maxQueueLength, onMaxQueueLength }: PlaybackSectionProps) {
    const { format, setFormat } = useTrackFormat();
    const preview = formatTrackDisplay(SAMPLE_TRACK, format);

    return (
        <SettingsSection id="playback" title="Playback">
            <SettingsRow
                label="Streaming quality"
                description="Higher quality uses more bandwidth"
            >
                <SettingsSelect
                    value={value}
                    onChange={(v) => onChange(v as UserSettings["playbackQuality"])}
                    options={qualityOptions}
                />
            </SettingsRow>
            <SettingsRow
                label="Track title format"
                description="Foobar2000-style format string. Leave empty for default."
            >
                <div className="flex flex-col gap-1.5 w-full max-w-sm">
                    <SettingsInput
                        value={format}
                        onChange={setFormat}
                        placeholder="[%artist% - ]$if2(%title%,$filepart(%filename%))"
                    />
                    {format && (
                        <p className="text-micro text-[var(--text-muted)] tabular-nums truncate">
                            Preview: {preview}
                        </p>
                    )}
                </div>
            </SettingsRow>

            {/* Admin-only: it is one number for the whole server, not a taste.
                Hidden rather than disabled for anyone who cannot change it —
                a greyed field invites a question nobody can answer. */}
            {onMaxQueueLength && (
                <SettingsRow
                    label="Queue limit"
                    description={`How many tracks the play queue can hold. The queue is a list of references, so a long one costs a larger save rather than disk. ${QUEUE_MIN.toLocaleString()} to ${QUEUE_MAX.toLocaleString()}.`}
                >
                    <QueueLimitInput value={maxQueueLength} onCommit={onMaxQueueLength} />
                </SettingsRow>
            )}
        </SettingsSection>
    );
}
