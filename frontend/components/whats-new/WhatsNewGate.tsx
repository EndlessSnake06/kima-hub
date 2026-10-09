"use client";

/**
 * Shows every release the user has not closed in one window, the newest note
 * first and every pending item oldest first. The server decides what is
 * pending; nothing is recorded locally, so a second device still asks.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { WhatsNewWindow, type Release } from "./WhatsNewWindow";
import { MoodMixChoice } from "./MoodMixChoice";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// One pending fetch per app session, shared across remounts (the layout switching
// between phone, desktop and TV), so a remount neither refetches nor replaces the
// queue being read. A failed fetch is not cached; the next mount retries.
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

/** Everything was closed: a remount must not bring the window back from the cached fetch. */
function closeAll(): void {
    pendingFetch = Promise.resolve([]);
}

export function WhatsNewGate() {
    const [queue, setQueue] = useState<Release[]>([]);
    // Following a link to a page defers the window for this user in this tab, so it
    // does not follow them there; nothing is answered or closed by it. sessionStorage
    // survives the gate remounting on navigation and clears with the tab, so the
    // window returns next visit.
    const { user } = useAuth();
    const deferKey = user ? `whatsnew.deferred:${user.id}` : null;
    const [, setDeferredNow] = useState(0);
    const deferred =
        deferKey !== null && typeof window !== "undefined" && window.sessionStorage.getItem(deferKey) === "1";
    const [confirming, setConfirming] = useState(false);
    const [wiping, setWiping] = useState(false);
    const [done, setDone] = useState<string[]>([]);
    const [wipeError, setWipeError] = useState<string | null>(null);

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
    const wipe = queue.flatMap((r) => r.items).find((i) => i.kind === "action" && i.run === "wipeEnrichment");

    const runWipe = async () => {
        if (!wipe) return;
        setConfirming(false);
        setWiping(true);
        setWipeError(null);
        try {
            await api.wipeAndRerunEnrichment();
            setDone((d) => [...d, wipe.key]);
        } catch {
            setWipeError("Couldn't start it. Try again, or use Settings, under Library Enrichment.");
        } finally {
            setWiping(false);
        }
    };

    // Done closes every pending release in the queue, not just the heading's:
    // a window that shows two releases must record both closings.
    const dismissAll = async () => {
        for (const r of queue) await api.post(`/whats-new/${r.version}/dismiss`, {});
    };

    const defer = () => {
        if (!deferKey) return;
        window.sessionStorage.setItem(deferKey, "1");
        setDeferredNow((n) => n + 1);
    };

    return (
        <>
            <WhatsNewWindow
                releases={queue}
                onDismiss={dismissAll}
                onClose={() => { closeAll(); setQueue([]); }}
                onNavigate={defer}
                done={done}
                renderAction={(item) =>
                    item.key === "moods.mixes" || item.key === "moods.mixes.retired" ? (
                        // Rebuild / keep / save as playlist, or for a mix under a
                        // removed mood, save / remove. The server only sends these
                        // to users who have that kind of saved mix.
                        <MoodMixChoice onNavigate={defer} />
                    ) : item.run === "wipeEnrichment" ? (
                        <div className="flex flex-col gap-2">
                            {done.includes(item.key) ? (
                                <p className="text-sm text-success flex items-center gap-2" data-testid="wipe-started">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Wiped. Your library is running through the new engine in the background.
                                </p>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setConfirming(true)}
                                    disabled={wiping}
                                    data-testid="wipe-run"
                                    className="self-start min-h-11 py-2.5 px-4 rounded-lg bg-brand hover:bg-brand-hover text-black text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60"
                                >
                                    {wiping ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {wiping ? "Starting..." : item.cta}
                                </button>
                            )}
                            {wipeError && <p className="text-sm text-danger-light">{wipeError}</p>}
                        </div>
                    ) : null
                }
            />

            {confirming && wipe && wipe.kind === "action" && (
                <div data-nested-confirm="true">
                    <ConfirmDialog
                        isOpen={true}
                        onClose={() => setConfirming(false)}
                        onConfirm={runWipe}
                        title={wipe.confirmTitle ?? "Wipe and re-run enrichment?"}
                        message={wipe.confirmMessage ?? ""}
                        confirmText={wipe.confirmLabel ?? wipe.cta}
                        cancelText="Not now"
                        variant="warning"
                    />
                </div>
            )}
        </>
    );
}
