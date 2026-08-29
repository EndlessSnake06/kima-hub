"use client";

/**
 * Play an entrance when a thing actually comes into view.
 *
 * The first version staggered every section off a fixed delay at page load,
 * which is only ever right for the first screen. On a page this long it meant
 * six of the eight sections finished animating while nobody was looking, and
 * scrolling down revealed a set of already-arrived blocks. The motion was real
 * and entirely wasted.
 *
 * Watching instead means each section arrives as you reach it, which is the
 * only version where the motion says anything: it marks *your* progress down
 * the page rather than the page's own load order.
 *
 * ## Why it unhooks itself
 *
 * Entrances happen once. Leaving the observer attached would replay them every
 * time a section crossed the edge of the viewport, which turns a considered
 * arrival into a twitch every time you scroll up.
 *
 * Reduced motion needs no special handling here: the app zeroes every animation
 * duration globally, so a revealed element simply appears. The class still
 * lands, the motion just takes no time.
 */

import { useEffect, useRef, useState } from "react";

export function useReveal<T extends HTMLElement = HTMLDivElement>(options?: {
    /** How much of it has to be showing. A whole section is never fully on screen. */
    threshold?: number;
    /** Start a little before the edge, so it is already moving as it appears. */
    rootMargin?: string;
}) {
    const ref = useRef<T | null>(null);
    const [shown, setShown] = useState(false);

    /**
     * A browser with no observer, decided during render rather than by writing
     * state from an effect.
     *
     * The `typeof window` half is what keeps hydration quiet: on the server
     * there is no observer either, but answering "true" there would render
     * every section revealed while the client's first pass renders them hidden,
     * and the two would not match. On the server this stays false, which is
     * exactly what the client starts at.
     */
    const noObserver =
        typeof window !== "undefined" && typeof IntersectionObserver === "undefined";

    useEffect(() => {
        const node = ref.current;
        if (!node || shown) return;

        // No observer (old browser, a test renderer): nothing to subscribe to.
        // `noObserver` above already reports it as shown, so there is no state
        // to write here — a missing entrance is a non-event, but hidden content
        // is a broken page.
        if (noObserver) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setShown(true);
                    observer.disconnect();
                }
            },
            {
                threshold: options?.threshold ?? 0.12,
                rootMargin: options?.rootMargin ?? "0px 0px -8% 0px",
            },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [shown, noObserver, options?.threshold, options?.rootMargin]);

    // `|| noObserver` is load-bearing, not defensive. The effect no longer
    // writes state for a browser without an observer, so without this the
    // fallback would leave every section hidden forever instead of visible
    // immediately — a broken page rather than a missing entrance.
    return { ref, shown: shown || noObserver };
}
