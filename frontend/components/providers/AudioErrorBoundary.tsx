"use client";

import { ReactNode } from "react";
import { ErrorBoundary } from "@/components/providers/ErrorBoundary";

/** Catches errors in the audio providers so the rest of the app keeps running. */
export function AudioErrorBoundary({ children }: { children: ReactNode }) {
    return (
        <ErrorBoundary
            label="AudioErrorBoundary"
            renderFallback={() => (
                <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
                    <p className="text-[var(--text-secondary)]">Playback system error</p>
                    <button
                        onClick={() => window.location.reload()}
                        className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-black font-semibold transition-all"
                    >
                        Reload
                    </button>
                </div>
            )}
        >
            {children}
        </ErrorBoundary>
    );
}
