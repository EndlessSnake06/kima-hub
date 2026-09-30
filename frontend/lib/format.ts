/**
 * Format seconds into a human-readable time string
 * For durations under 1 hour: m:ss (e.g., 5:32)
 * For durations 1 hour or more: h:mm:ss (e.g., 1:05:32)
 */
export function formatTime(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, "0")}:${secs
            .toString()
            .padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format seconds into a human-readable duration string
 * Always shows full format for clarity (e.g., "2h 30m" or "45m")
 */
export function formatDuration(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0m";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        if (mins > 0) {
            return `${hours}h ${mins}m`;
        }
        return `${hours}h`;
    }
    return `${mins}m`;
}

/**
 * Clamp a time value to be within valid bounds
 * Ensures currentTime never exceeds duration
 */
export function clampTime(currentTime: number, duration: number): number {
    if (duration <= 0) return Math.max(0, currentTime);
    return Math.min(Math.max(0, currentTime), duration);
}

/** Remaining time as -m:ss or -h:mm:ss; nothing left reads as 0:00. */
export function formatTimeRemaining(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return "0:00";
    return `-${formatTime(seconds)}`;
}

export function formatNumber(num: number): string {
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
}

/** Listener counts in compact form ("5.1M listeners"); no count reads as "Artist". */
export function formatListeners(count: number | undefined): string {
    if (!count || count === 0) return "Artist";

    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M listeners`;
    }

    if (count >= 1000) {
        return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K listeners`;
    }

    return `${count.toLocaleString()} listeners`;
}
/** Recompose decomposed accents (e + U+0301) so they render as one glyph. */
export function normalizeNFC(str: string): string {
    return str.normalize("NFC");
}
