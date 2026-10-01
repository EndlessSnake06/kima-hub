"use client";

/**
 * Shows unclosed releases oldest first, one at a time. The server decides what
 * is pending; nothing is recorded locally, so a second device still asks.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { WhatsNewWindow } from "./WhatsNewWindow";
import { MoodMixChoice } from "./MoodMixChoice";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    items: Parameters<typeof WhatsNewWindow>[0]["release"]["items"];
}

// One pending fetch per app session, shared across the remounts every route
// change causes, so navigation neither refetches nor replaces the queue being
// read. A failed fetch is not cached; the next mount retries.
let pendingFetch: Promise<Release[]> | null = null;
let pendingFetchKey: string | null = null;
function fetchPending(): Promise<Release[]> {
    // Keyed to the session token: sign out and in as someone else without a
    // reload, and the new user must not inherit the old user's queue.
    const key = typeof window === "undefined" ? "ssr" : localStorage.getItem("auth_token") ?? "";
    if (!pendingFetch || pendingFetchKey !== key) {
        pendingFetchKey = key;
        pendingFetch = api
            .get<{ releases: Release[] }>("/whats-new/pending")
            .then((r) => r.releases)
            .catch((e) => {
                pendingFetch = null;
                throw e;
            });
    }
    return pendingFetch;
}

export function WhatsNewGate() {
    const [queue, setQueue] = useState<Release[]>([]);
    // "Take me to it" defers the remaining windows for this tab, so they don't
    // follow the user to the page. sessionStorage survives the gate remounting on
    // navigation and clears with the tab; the windows return next visit.
    const [deferred, setDeferred] = useState(() => {
        if (typeof window === "undefined") return false;
        return window.sessionStorage.getItem("whatsnew.deferred") === "1";
    });
    const [confirming, setConfirming] = useState(false);
    const [running, setRunning] = useState<string | null>(null);
    const [started, setStarted] = useState<string | null>(null);
    const [runError, setRunError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const releases = await fetchPending();
                if (!cancelled) setQueue(releases);
            } catch {
                // Never block the app on this. Someone who came to listen to
                // music should not be stopped by a changelog that failed to load;
                // it stays pending and appears next time.
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (queue.length === 0 || deferred) return null;
    const [current, ...rest] = queue;

    const reembed = current.items.find(
        (i): i is Extract<typeof current.items[number], { kind: "action"; runsFromWindow?: boolean }> =>
            i.kind === "action" && i.runsFromWindow === true,
    );

    const runReembed = async () => {
        if (!reembed) return;
        setConfirming(false);
        setRunning(reembed.key);
        setRunError(null);
        try {
            // Same endpoint the Settings "Re-run" for vibe embeddings calls.
            await api.resetVibeEmbeddings();
            setStarted(reembed.key);
        } catch {
            setRunError("Couldn't start the rebuild. It's still in Settings, under Library Enrichment.");
        } finally {
            setRunning(null);
        }
    };

    return (
        <>
            <WhatsNewWindow
                key={current.version}
                release={current}
                onClose={() => setQueue(rest)}
                renderAction={(item) =>
                item.key === "moods.mixes" || item.key === "moods.mixes.retired" ? (
                    // Rebuild / keep / save as playlist, or for a mix under a
                    // removed mood, save / remove. The server only sends these
                    // to users who have that kind of saved mix.
                    <MoodMixChoice />
                ) : item.key === "plays.repair" ? (
                    // The review lives on the stats page and stays there. A
                    // dialogue is a bad place to work through forty tracks, and
                    // a second copy of a destructive tool is worse.
                    <a
                        href="/stats#false-starts"
                        onClick={() => {
                            window.sessionStorage.setItem("whatsnew.deferred", "1");
                            setDeferred(true);
                            void api.post(`/whats-new/${current.version}/dismiss`, {});
                        }}
                        className="self-start h-11 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center transition-colors"
                    >
                        {item.cta}
                    </a>
                ) : item.runsFromWindow ? (
                    <div className="flex flex-col gap-2">
                        {started === item.key ? (
                            <p className="text-sm text-success flex items-center gap-2" data-testid="reembed-started">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Rebuild started. It runs in the background — you can close this and keep listening.
                            </p>
                        ) : runError && reembed?.key === item.key ? (
                            <p className="text-sm text-danger-light">{runError}</p>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirming(true)}
                                disabled={running !== null}
                                data-testid="reembed-run"
                                className="self-start h-11 px-4 rounded-lg bg-brand hover:bg-brand-hover text-black text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60"
                            >
                                {running === item.key ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                {running === item.key ? "Starting..." : (item.confirmLabel ?? item.cta)}
                            </button>
                        )}
                        <p className="text-xs text-[var(--text-muted)]">
                            Or do it later from Settings, under Library Enrichment.
                        </p>
                    </div>
                ) : null
            }
            />

        {confirming && reembed && (
            <div data-nested-confirm="true">
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setConfirming(false)}
                    onConfirm={runReembed}
                    title={reembed.confirmTitle ?? "Run this now?"}
                    message={reembed.confirmMessage ?? ""}
                    confirmText={reembed.confirmLabel ?? "Run it"}
                    cancelText="Not now"
                    variant="warning"
                />
            </div>
        )}
        </>
    );
}
