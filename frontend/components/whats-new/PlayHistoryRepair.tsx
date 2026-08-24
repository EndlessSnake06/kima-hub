"use client";

/**
 * The play-history repair, as something you look at before you agree to it.
 *
 * Three states, in order: offer, findings, done. The delete is never one click
 * away from the offer — you ask it to look, you read what it found, and only
 * then does a button appear that removes anything. Nothing here is reversible,
 * so the reading step is the feature.
 *
 * The counts come from the server's own analysis, so what is described is
 * exactly what the repair will act on. It re-derives the verdicts server-side
 * when it runs, which means a long pause between reading and agreeing cannot
 * cause it to delete something the user never saw.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface RepairRow {
    playId: string;
    title: string;
    playedAt: string;
    durationSeconds: number;
    gapSeconds: number | null;
    requiredSeconds: number | null;
}

interface RepairReport {
    totalPlays: number;
    earliest: string | null;
    latest: string | null;
    provableSkips: number;
    unprovable: number;
    noFollowingPlay: number;
    sample: RepairRow[];
}

const secs = (n: number | null) => (n == null ? "—" : `${Math.round(n)}s`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

export function PlayHistoryRepair({ cta }: { cta: string }) {
    const [report, setReport] = useState<RepairReport | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<{ removed: number; kept: number } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const look = async () => {
        setBusy(true);
        setError(null);
        try {
            setReport(await api.get<RepairReport>("/whats-new/actions/play-history"));
        } catch {
            setError("Couldn't read your play counts. Nothing changed.");
        } finally {
            setBusy(false);
        }
    };

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            setDone(await api.post<{ removed: number; kept: number }>(
                "/whats-new/actions/play-history/repair",
                {},
            ));
        } catch {
            setError("That didn't finish. Your play counts are unchanged.");
        } finally {
            setBusy(false);
        }
    };

    if (done) {
        return (
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                Cleared <span className="text-white font-semibold">{done.removed.toLocaleString()}</span>{" "}
                {done.removed === 1 ? "play" : "plays"} you&apos;d skipped past. Kept{" "}
                <span className="text-white font-semibold">{done.kept.toLocaleString()}</span>.
            </p>
        );
    }

    if (!report) {
        return (
            <div className="flex flex-col gap-2 items-start">
                <button
                    onClick={look}
                    disabled={busy}
                    className="h-11 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-60"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    {cta}
                </button>
                {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
        );
    }

    if (report.totalPlays === 0) {
        return <p className="text-sm text-[var(--text-secondary)]">No play counts to clean up yet.</p>;
    }

    return (
        <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-3 gap-3">
                <Stat n={report.provableSkips} label="definitely skipped" tone="brand" />
                <Stat n={report.unprovable} label="not sure, kept" />
                <Stat n={report.totalPlays} label={`plays since ${day(report.earliest)}`} />
            </dl>

            {report.sample.length > 0 && (
                <div className="rounded-xl border border-white/10 overflow-hidden">
                    <div className="px-3 py-2 border-b border-white/10 text-[0.625rem] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                        Some of them
                    </div>
                    <ul className="divide-y divide-white/5">
                        {report.sample.slice(0, 5).map((r) => (
                            <li key={r.playId} className="px-3 py-2 flex items-baseline justify-between gap-3 text-xs">
                                <span className="truncate text-[var(--text-secondary)]">{r.title}</span>
                                <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                                    ran {secs(r.gapSeconds)} of {r.durationSeconds}s · needed {secs(r.requiredSeconds)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <p className="text-xs leading-relaxed text-[var(--text-muted)] max-w-prose">
                If a play is followed a few seconds later by another one, you weren&apos;t listening to it, and the gap says so.
                A long gap doesn&apos;t tell us anything either way, so those stay. This only clears Kima&apos;s play counts.
                It doesn&apos;t read, move or change any of your music files. You can&apos;t undo it.
            </p>

            <div className="flex flex-col gap-2 items-start">
                <button
                    onClick={run}
                    disabled={busy || report.provableSkips === 0}
                    className="h-11 px-4 rounded-lg bg-brand hover:bg-[#e69200] text-black text-sm font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    {report.provableSkips === 0
                        ? "Nothing to clear"
                        : `Clear ${report.provableSkips.toLocaleString()}`}
                </button>
                {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
        </div>
    );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "brand" }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dd className={`text-xl font-bold tabular-nums ${tone === "brand" ? "text-brand" : "text-white"}`}>
                {n.toLocaleString()}
            </dd>
            <dt className="text-[0.625rem] uppercase tracking-[0.1em] text-[var(--text-muted)] leading-snug">
                {label}
            </dt>
        </div>
    );
}
