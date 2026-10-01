"use client";

import React, { Component, ReactNode } from "react";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

/** Catches errors in the audio providers so the rest of the app keeps running. */
export class AudioErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        // Update state so the next render will show the fallback UI
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        // Log the error for debugging
        console.error("[AudioErrorBoundary] Audio system error:", error);
        console.error("[AudioErrorBoundary] Component stack:", errorInfo.componentStack);
    }

    render() {
        if (this.state.hasError) {
            return (
                this.props.fallback ?? (
                    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
                        <p className="text-[var(--text-secondary)]">Playback system error</p>
                        <button
                            onClick={() => window.location.reload()}
                            className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-black font-semibold transition-all"
                        >
                            Reload
                        </button>
                    </div>
                )
            );
        }

        return this.props.children;
    }
}

