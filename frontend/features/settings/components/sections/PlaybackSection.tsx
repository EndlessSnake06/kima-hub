"use client";

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

/** The same bounds the server clamps to, so the field cannot offer a value it will not keep. */
const QUEUE_MIN = 100;
const QUEUE_MAX = 100000;

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
                    <SettingsInput
                        type="number"
                        value={String(maxQueueLength ?? "")}
                        onChange={(v) => {
                            const n = Number(v);
                            // Clamped here as well as on the server, so the box
                            // cannot show a number that will not be kept.
                            if (Number.isFinite(n)) {
                                onMaxQueueLength(Math.min(QUEUE_MAX, Math.max(QUEUE_MIN, Math.floor(n))));
                            }
                        }}
                        placeholder="10000"
                    />
                </SettingsRow>
            )}
        </SettingsSection>
    );
}
