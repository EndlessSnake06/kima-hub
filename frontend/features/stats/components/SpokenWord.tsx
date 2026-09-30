"use client";

/**
 * Audiobook and podcast hours, measured from real playback positions, so
 * unlike music time they are stated without "about".
 */

import { hoursValue } from "../format";
import type { SpokenStats } from "../types";

export function SpokenWord({ spoken }: { spoken: SpokenStats }) {
    const { audiobooks, podcasts } = spoken;

    if (audiobooks.seconds === 0 && podcasts.seconds === 0) {
        return (
            <p className="t-body max-w-[34ch]">
                Nothing here yet. Connect Audiobookshelf or subscribe to a podcast and this fills
                in.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {audiobooks.seconds > 0 && (
                <Entry
                    value={hoursValue(audiobooks.seconds)}
                    unit="hours of books"
                    lines={[
                        sentence([
                            audiobooks.finished > 0 &&
                                `${audiobooks.finished} finished`,
                            audiobooks.inProgress > 0 && `${audiobooks.inProgress} on the go`,
                            audiobooks.setAside > 0 && `${audiobooks.setAside} set aside`,
                        ]),
                        audiobooks.current &&
                            `${Math.round(audiobooks.current.percent * 100)}% through ${audiobooks.current.title}`,
                        audiobooks.topAuthors[0] && `mostly ${audiobooks.topAuthors[0].name}`,
                    ]}
                />
            )}

            {podcasts.seconds > 0 && (
                <Entry
                    value={hoursValue(podcasts.seconds)}
                    unit="hours of podcasts"
                    lines={[
                        sentence([
                            podcasts.subscriptions > 0 && `${podcasts.subscriptions} subscribed`,
                            podcasts.finished > 0 && `${podcasts.finished} episodes finished`,
                        ]),
                        podcasts.backlog > 0 &&
                            `${podcasts.backlog.toLocaleString()} waiting, never opened`,
                    ]}
                />
            )}
        </div>
    );
}

/** A measured figure and the two or three facts that qualify it. */
function Entry({
    value,
    unit,
    lines,
}: {
    value: string;
    unit: string;
    lines: Array<string | false | null | undefined>;
}) {
    const kept = lines.filter(Boolean) as string[];
    return (
        <div className="flex flex-col gap-1.5">
            <p className="flex items-baseline gap-2">
                <span className="t-figure text-[length:var(--stat-figure)]">{value}</span>
                <span className="t-label">{unit}</span>
            </p>
            {kept.map((line) => (
                <p key={line} className="t-meta max-w-[32ch]">
                    {line}
                </p>
            ))}
        </div>
    );
}

/** Join the parts that exist into one phrase, and skip the ones that don't. */
function sentence(parts: Array<string | false>): string {
    const kept = parts.filter(Boolean) as string[];
    if (kept.length === 0) return "just getting started";
    if (kept.length === 1) return kept[0];
    return `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
}
