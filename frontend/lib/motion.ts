import type { CSSProperties } from "react";

/**
 * The entrance cascade: items animate in sequence across a fixed window
 * instead of a fixed per-item delay, so a page of 12 and a page of 250 both
 * finish landing about the same moment. The last item's start delay equals
 * the window; total settle time is the window plus one 300ms rise.
 */
export const CASCADE_WINDOW_MS = 1200;

/**
 * Spread over the container element; `--i` stays on the leaf. Without a
 * defined `--stagger` the leaf's delay calc is invalid and falls back to
 * zero, so an un-styled container degrades to items arriving at once —
 * never to items stuck invisible behind `both` fill.
 */
export function cascadeStyle(count: number): CSSProperties {
    return {
        "--stagger": `${Math.round(CASCADE_WINDOW_MS / Math.max(count, 1))}ms`,
    } as CSSProperties;
}
