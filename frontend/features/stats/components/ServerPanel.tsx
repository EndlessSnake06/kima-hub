"use client";

/**
 * The server half of the page, admins only (`system` is absent for everyone
 * else). Readings in columns. Each action calls the endpoint that owns it; the
 * two destructive ones confirm in place with a second click.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { bytes, uptime } from "../format";
import type { SystemStats } from "../types";

export function ServerPanel({ system }: { system: SystemStats }) {
    return (
        <div className="flex flex-col gap-7">
            <div className="grid gap-x-10 gap-y-5 grid-cols-2 sm:grid-cols-4">
                <Probe label="Database" ms={system.db} />
                <Probe label="Redis" ms={system.redis} />
                <Reading label="Uptime" value={uptime(system.uptimeSeconds)} />
                <Reading label="Version" value={system.version} mono />
            </div>

            <div className="grid gap-x-10 gap-y-5 grid-cols-2 sm:grid-cols-4">
                <Reading label="Tracks" value={system.library.tracks.toLocaleString()} />
                <Reading label="On disk" value={bytes(system.library.bytes)} />
                <Reading
                    label="Cached"
                    value={bytes((system.cache.downloadedMb + system.cache.transcodedMb) * 1048576)}
                />
                <Reading
                    label="Needs attention"
                    value={(system.corruptTracks + system.enrichmentFailures).toLocaleString()}
                    tone={system.corruptTracks + system.enrichmentFailures > 0 ? "warn" : undefined}
                />
            </div>

            {system.jobs.length > 0 && (
                <div className="flex flex-col gap-3">
                    <h3 className="t-label text-[var(--text-secondary)]">Download jobs</h3>
                    <div className="flex flex-wrap gap-x-8 gap-y-3">
                        {system.jobs.map((job) => (
                            <p key={job.status} className="flex items-baseline gap-2">
                                <span className="t-figure text-[length:var(--stat-lead)]">
                                    {job.count.toLocaleString()}
                                </span>
                                <span className="t-meta">{job.status.toLowerCase()}</span>
                            </p>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
                <Action<ClearCachesResult>
                    label="Clear caches"
                    confirmLabel="Clear them?"
                    path="/system-settings/clear-caches"
                    done={(r) => `Cleared ${(r.clearedKeys ?? 0).toLocaleString()} cache entries.`}
                />
                <Action<CleanupJobsResult>
                    label="Clear finished jobs"
                    confirmLabel="Clear them?"
                    path="/settings/cleanup-stale-jobs"
                    done={(r) => `Cleared ${(r.totalCleaned ?? 0).toLocaleString()} records.`}
                />
                <Action<RetryFailedResult>
                    label="Retry failed analysis"
                    path="/analysis/retry-failed"
                    done={(r) => `Requeued ${(r.reset ?? 0).toLocaleString()} tracks.`}
                />
            </div>
        </div>
    );
}

/** A live check. Amber when it answered, red when it did not. */
function Probe({ label, ms }: { label: string; ms: number | null }) {
    const ok = ms != null;
    return (
        <div className="flex flex-col gap-1.5">
            <span className="t-label">{label}</span>
            <span className="flex items-center gap-2">
                <span
                    aria-hidden
                    className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-brand" : "bg-red-400"}`}
                />
                <span
                    className={`t-figure text-[length:var(--stat-lead)] ${ok ? "" : "text-red-400"}`}
                >
                    {ok ? `${ms < 1 ? ms.toFixed(1) : Math.round(ms)}ms` : "no answer"}
                </span>
            </span>
        </div>
    );
}

function Reading({
    label,
    value,
    mono,
    tone,
}: {
    label: string;
    value: string;
    mono?: boolean;
    tone?: "warn";
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="t-label">{label}</span>
            <span
                className={[
                    mono ? "t-data text-base" : "t-figure text-[length:var(--stat-lead)]",
                    tone === "warn" ? "text-brand" : "text-[var(--text-primary)]",
                ].join(" ")}
            >
                {value}
            </span>
        </div>
    );
}

/** Response shapes of each maintenance endpoint, as its route returns them. */
interface ClearCachesResult { clearedKeys?: number }
interface CleanupJobsResult { totalCleaned?: number }
interface RetryFailedResult { reset?: number; failed?: number; permanentlyFailed?: number }

/**
 * One maintenance action. Idle, asking, running, done — and `done` keeps the
 * sentence on screen rather than flashing it, because the number it reports is
 * the only evidence the click did anything.
 */
function Action<TResult extends object>({
    label,
    confirmLabel,
    path,
    done,
}: {
    label: string;
    confirmLabel?: string;
    path: string;
    done: (result: TResult) => string;
}) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    const run = async () => {
        if (confirmLabel && !asking) {
            setAsking(true);
            return;
        }
        setAsking(false);
        setBusy(true);
        setResult(null);
        try {
            setResult(done((await api.post<TResult>(path, {})) ?? ({} as TResult)));
        } catch {
            setResult("That didn't run. Nothing changed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-1.5">
            <button
                onClick={run}
                onBlur={() => setAsking(false)}
                disabled={busy}
                className={[
                    "h-11 px-4 rounded-lg t-control flex items-center gap-2 transition-colors disabled:opacity-60",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]",
                    asking
                        ? "bg-brand text-black"
                        : "bg-white/[0.05] text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.09]",
                ].join(" ")}
            >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {asking ? confirmLabel : label}
            </button>
            {result && <p className="t-meta text-[var(--text-secondary)]">{result}</p>}
        </div>
    );
}
