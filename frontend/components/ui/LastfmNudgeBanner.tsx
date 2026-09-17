/**
 * One-time visible nudge for the shared default Last.fm API key.
 *
 * When `useLastfmNudge` reports `ready` (the default key was rate-limited 3+
 * times in `lastfm.ts`), this banner tells the user to add their own free
 * Last.fm API key in Settings > AI Services.
 *
 * Dismissing sends a POST to /api/lastfm/nudge/ack, which creates a system
 * notification (for the notification bell) and resets the pending flag on
 * the backend so the banner does not return until the default key is rate-
 * limited 3 more times.
 */
"use client";

import { AlertCircle, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { useLastfmNudge } from "@/hooks/useLastfmNudge";

export function LastfmNudgeBanner() {
    const { ready, dismissed, loading, dismiss } = useLastfmNudge();

    if (loading || !ready || dismissed) {
        return null;
    }

    return (
        <div
            role="alert"
            aria-live="polite"
            className={cn(
                "fixed bottom-20 left-4 right-4 md:left-80 md:right-8 md:bottom-8 z-[90] max-w-xl",
                "bg-gradient-to-br from-[#1c1c1e] to-[#0f0f0f] border border-yellow-500/40 rounded-lg",
                "text-white shadow-lg shadow-black/50"
            )}
        >
            <div className="p-4">
                <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-yellow-500" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-yellow-400 mb-1">
                            Last.fm rate limit reached
                        </p>
                        <p className="text-micro text-[var(--text-muted)] leading-relaxed">
                            The shared default Last.fm API key is exhausted. Add
                            your own free API key in{" "}
                            <strong className="text-[var(--text-secondary)]">
                                Settings &gt; AI Services
                            </strong>{" "}
                            (registration is free at{" "}
                            <span className="underline decoration-yellow-500/50 cursor-pointer">
                                last.fm/api
                            </span>
                            ). Your key gives you a dedicated, higher rate
                            limit.
                        </p>
                    </div>
                    <button
                        onClick={dismiss}
                        className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors text-[var(--text-muted)] hover:text-white"
                        aria-label="Dismiss"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}