"use client";

import { useEffect, type PropsWithChildren } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";

/**
 * TrackDrawer -- the right-side selection overlay for the galaxy view.
 *
 * Mirrors the reference rig's select pattern (scene onSelect -> parent state
 * -> a page-level overlay), adapted for tracks. It shows the selected track's
 * own data straight from the MapTrack object (zero new fetches): title,
 * artist (linkable to the artist page), album cover, dominant mood + a mood
 * bar, and energy/valence. The actions re-use the page's existing handlers:
 * Play now, Match vibe, Find similar, Song path.
 *
 * Semantics: a background click or Esc dismisses; Tab focus is trapped inside
 * while open so keyboard users don't land on the field behind the backdrop.
 */
export interface TrackDrawerProps {
    visible: boolean;
    onClose: () => void;
    children: PropsWithChildren["children"];
}

export function TrackDrawer({ visible, onClose, children }: TrackDrawerProps) {
    useEffect(() => {
        if (!visible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        // Trap Tab focus while the drawer is open.
        const trap = (e: KeyboardEvent) => {
            if (e.key !== "Tab") return;
            const host = document.getElementById("kima-track-drawer-host");
            if (!host) return;
            const focusable = host.querySelectorAll<HTMLElement>(
                'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
            );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("keydown", trap);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("keydown", trap);
        };
    }, [visible, onClose]);

    return (
        <div
            id="kima-track-drawer-host"
            aria-label="Selected track details"
            className="fixed inset-0 z-(--z-drawer-backdrop) animate-fade-in"
            style={{ visibility: visible ? "visible" : "hidden" }}
            onClick={(e) => {
                // Only a genuine backdrop click dismisses, not a click on the
                // drawer panel itself.
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

            <aside
                role="presentation"
                className={cn(
                    "absolute top-0 right-0 h-full w-[min(22rem,90vw)] bg-[var(--bg-primary)] border-l border-white/10 shadow-[0_-2px_24px_rgba(0,0,0,0.5)] p-4 flex flex-col overflow-hidden",
                    "animate-slide-in",
                )}
            >
                <header className="flex items-center justify-between shrink-0 mb-3">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] font-semibold">
                        Track
                    </span>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>
                <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
            </aside>
        </div>
    );
}
