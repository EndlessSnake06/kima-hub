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
import { api } from "@/lib/api";
import { WhatsNewWindow } from "./WhatsNewWindow";

interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    items: Parameters<typeof WhatsNewWindow>[0]["release"]["items"];
}

export function WhatsNewGate() {
    const [queue, setQueue] = useState<Release[]>([]);

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

    return (
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
                ) : null
            }
        />
    );
}
