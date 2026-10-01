import { useSyncExternalStore } from "react";

/**
 * Hook to check if a media query matches
 * Uses useSyncExternalStore for hydration-safe initial state
 */
export function useMediaQuery(query: string): boolean {
    // Use useSyncExternalStore for hydration-safe media query detection
    // This prevents the flash caused by useState(false) -> useEffect(true) pattern
    const matches = useSyncExternalStore(
        // Subscribe function
        (callback) => {
            if (typeof window === "undefined") return () => {};
            const media = window.matchMedia(query);
            media.addEventListener("change", callback);
            return () => media.removeEventListener("change", callback);
        },
        // Get client snapshot
        () => {
            if (typeof window === "undefined") return false;
            return window.matchMedia(query).matches;
        },
        // Get server snapshot (always false on server)
        () => false
    );

    return matches;
}

/** Reduced-motion preference, for JavaScript-driven animation the CSS media query cannot reach. */
export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

// Common breakpoints
export const useIsMobile = () => useMediaQuery("(max-width: 768px)");

/**
 * "Tablet" means bottom-nav chrome: 769-1024px, or up to 1366px when nothing can
 * hover, so an iPad keeps one layout in both orientations while a touchscreen
 * laptop with a trackpad keeps the sidebar.
 */
export const useIsTablet = () =>
    useMediaQuery(
        "(min-width: 769px) and (max-width: 1024px), " +
            "(min-width: 769px) and (max-width: 1366px) and (any-hover: none) and (pointer: coarse)"
    );
