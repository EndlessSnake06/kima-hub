"use client";

/**
 * Shows any release the user has not closed yet.
 *
 * Oldest first, one at a time. Someone who has been away for three versions
 * reads them in the order they happened and answers the older consent questions
 * before the newer ones that may depend on them.
 *
 * The server decides what is pending; this only asks. It deliberately holds no
 * local record of what has been seen — a client-side "dismissed" flag is how a
 * consent prompt ends up never being shown on a second device.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { WhatsNewWindow } from "./WhatsNewWindow";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    items: Parameters<typeof WhatsNewWindow>[0]["release"]["items"];
}

export function WhatsNewGate() {
    const [queue, setQueue] = useState<Release[]>([]);
    const [confirming, setConfirming] = useState(false);
    const [running, setRunning] = useState<string | null>(null);
    const [started, setStarted] = useState<string | null>(null);
    const [runError, setRunError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { releases } = await api.get<{ releases: Release[] }>("/whats-new/pending");
                if (!cancelled) setQueue(releases);
            } catch {
                // Never block the app on this. Someone who came to listen to
                // music should not be stopped by a changelog that failed to load;
                // it stays pending and appears next time.
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (queue.length === 0) return null;
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
            await enrichmentApi.resetVibeEmbeddings();
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
                release={current}
                onClose={() => setQueue(rest)}
                renderAction={(item) =>
                item.key === "plays.repair" ? (
                    // The review lives on the stats page and stays there. A
                    // dialogue is a bad place to work through forty tracks, and
                    // a second copy of a destructive tool is worse.
                    <a
                        href="/stats#false-starts"
                        className="self-start h-11 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center transition-colors"
                    >
                        {item.cta}
                    </a>
                ) : item.runsFromWindow ? (
                    <div className="flex flex-col gap-2">
                        {started === item.key ? (
                            <p className="text-sm text-green-400 flex items-center gap-2" data-testid="reembed-started">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Rebuild started. It runs in the background — you can close this and keep listening.
                            </p>
                        ) : runError && reembed?.key === item.key ? (
                            <p className="text-sm text-red-400">{runError}</p>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirming(true)}
                                disabled={running !== null}
                                data-testid="reembed-run"
                                className="self-start h-11 px-4 rounded-lg bg-brand hover:bg-[#e69200] text-black text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60"
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
