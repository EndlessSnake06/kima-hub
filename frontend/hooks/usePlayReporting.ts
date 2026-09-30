"use client";

/**
 * Measures listening and reports it; the server decides whether it is a play
 * (Last.fm's rule: over 30 seconds, and half its length or four minutes).
 *
 * ## Why deltas, and why capped
 *
 * Listened time is accumulated as the difference between successive `timeupdate`
 * positions, and each delta is capped at a little over the tick interval. That
 * cap is doing two jobs:
 *
 * - **A drag to the end buys almost nothing.** Scrubbing produces one enormous
 *   position jump; capping it credits a fraction of a second rather than the
 *   whole track. Measuring `currentTime` directly, which is the obvious approach,
 *   would make the scrubber a scrobble button.
 * - **A throttled background tab undercounts rather than losing everything.** iOS
 *   and most browsers slow `timeupdate` when the tab is hidden. An uncapped delta
 *   would over-credit the gap; no delta at all would lose real listening. Capping
 *   takes the conservative side: audio that genuinely played is under-counted, and
 *   under-counting only ever delays a play, never invents one.
 *
 * Anything that is not forward progress inside one track — a seek, a track
 * change, a reload — resets rather than accumulates.
 */

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";

/**
 * The most a single tick may contribute. `timeupdate` fires about four times a
 * second while playing, so 1.5s absorbs ordinary jitter and a brief stall while
 * still making a scrub worth almost nothing.
 */
const MAX_CREDITED_DELTA_SECONDS = 1.5;

/** Mirrors the server's floor. Below this no request is worth making. */
const MIN_TRACK_DURATION_SECONDS = 30;
const MAX_REQUIRED_SECONDS = 240;

/** How much of this track has to be heard before it is worth reporting. */
export function requiredSecondsFor(durationSeconds: number | null | undefined): number | null {
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return MAX_REQUIRED_SECONDS;
    }
    if (durationSeconds <= MIN_TRACK_DURATION_SECONDS) return null;
    return Math.min(durationSeconds / 2, MAX_REQUIRED_SECONDS);
}

/**
 * The measurement, with no React in it.
 *
 * Kept separate from the hook so the rule that matters — a scrub is worth almost
 * nothing — can be tested without a DOM, a renderer or three extra dependencies.
 */
export class ListenMeter {
    private listened = 0;
    private lastPosition: number | null = null;
    private reported = false;

    constructor(private durationSeconds: number | null | undefined) {}

    get secondsListened(): number {
        return this.listened;
    }

    /** A new track, or a reload. Nothing carries over. */
    reset(durationSeconds?: number | null): void {
        this.listened = 0;
        this.lastPosition = null;
        this.reported = false;
        if (durationSeconds !== undefined) this.durationSeconds = durationSeconds;
    }

    /**
     * Learn the track's length without disturbing anything already counted.
     *
     * Durations often arrive after playback has begun. That is new information
     * about the same listen, not a new listen, so it must not clear the counter
     * or the already-reported flag.
     */
    setDuration(durationSeconds: number | null): void {
        this.durationSeconds = durationSeconds;
    }

    /** A seek breaks the chain of deltas rather than producing one enormous one. */
    breakChain(): void {
        this.lastPosition = null;
    }

    /**
     * Feed a position. Returns true exactly once — on the tick where the
     * listening first earns a report.
     */
    observe(time: number): boolean {
        if (typeof time !== "number" || !Number.isFinite(time)) return false;

        const previous = this.lastPosition;
        this.lastPosition = time;
        if (previous === null) return false;

        const delta = time - previous;
        // Backwards is a seek. Forwards beyond one tick is a seek too: credit the
        // tick and no more, so dragging the scrubber buys a fraction of a second.
        if (delta <= 0) return false;
        this.listened += Math.min(delta, MAX_CREDITED_DELTA_SECONDS);

        if (this.reported) return false;
        const required = requiredSecondsFor(this.durationSeconds);
        if (required === null || this.listened < required) return false;

        this.reported = true;
        return true;
    }
}

interface Controller {
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
}

export function usePlayReporting(
    controller: Controller | null,
    trackId: string | null | undefined,
    durationSeconds: number | null | undefined,
) {
    const meterRef = useRef<ListenMeter>(new ListenMeter(durationSeconds));
    const trackIdRef = useRef<string | null>(null);

    /**
     * Reset only on a song change: a late-arriving duration must not clear the
     * "already reported" flag, or one listen is counted twice.
     */
    useEffect(() => {
        if (trackIdRef.current === trackId) {
            meterRef.current.setDuration(durationSeconds ?? null);
            return;
        }
        trackIdRef.current = trackId ?? null;
        meterRef.current.reset(durationSeconds ?? null);
    }, [trackId, durationSeconds]);

    const report = useCallback(async (id: string, seconds: number) => {
        try {
            await api.post("/plays", { trackId: id, secondsListened: Math.round(seconds) });
        } catch {
            // A missed play is not worth surfacing to someone listening to music,
            // and not worth retrying -- the next track reports itself.
        }
    }, []);

    useEffect(() => {
        if (!controller) return;

        const onTimeUpdate = (data: unknown) => {
            const { time } = (data ?? {}) as { time?: number };
            if (typeof time !== "number") return;
            if (!meterRef.current.observe(time)) return;
            const id = trackIdRef.current;
            if (id) void report(id, meterRef.current.secondsListened);
        };
        const onSeeked = () => meterRef.current.breakChain();

        controller.on("timeupdate", onTimeUpdate);
        controller.on("seeked", onSeeked);
        controller.on("gapless-advance", onSeeked);
        return () => {
            controller.off("timeupdate", onTimeUpdate);
            controller.off("seeked", onSeeked);
            controller.off("gapless-advance", onSeeked);
        };
    }, [controller, report]);
}
