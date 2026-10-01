"use client";

/**
 * The play-history audit. Plays recorded before 1.10.1 include tracks skipped
 * while loading. The only evidence is the gap to the next play, which proves a
 * skip when short and nothing when long, so only provable false starts are
 * raised. Remove deletes them; Ignore stops raising the track. Runs on demand.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface FalseStartTrack {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Listens that can be proven nobody stayed for. */
    skipped: number;
    /** Listens proven real by how long the records span. */
    heard: number;
    listens: number;
    rows: number;
    shortestRunSeconds: number | null;
    lastAt: string;
}

interface Audit {
    totalRows: number;
    totalListens: number;
    duplicateRows: number;
    /** Rows a merge would actually remove; fewer than `duplicateRows`. */
    collapsibleRows: number;
    heard: number;
    skipped: number;
    /** Listens of tracks too short to register a play, reported apart from `skipped`. */
    tooShort: number;
    unclear: number;
    earliest: string | null;
    tracks: FalseStartTrack[];
    ignored: Array<{ trackId: string; title: string; artist: string; ignoredAt: string }>;
}

const clock = (n: number) => {
    const m = Math.floor(n / 60);
    return `${m}:${String(Math.round(n % 60)).padStart(2, "0")}`;
};

export function FalseStarts() {
    const [audit, setAudit] = useState<Audit | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [arming, setArming] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showIgnored, setShowIgnored] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    // The audit routinely flags hundreds of tracks, so the list shows one
    // page at a time, as many rows as fit the space left under the figures.
    const [page, setPage] = useState(0);
    const listBox = useRef<HTMLDivElement>(null);
    const rows = useRowsThatFit(listBox);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        setElapsed(0);
        // No invented progress bar. The scan is one pass over an entire history
        // and there is no honest fraction to report, so it says what it is doing
        // and -- once the silence is long enough to worry about -- how long for.
        const started = Date.now();
        const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
        try {
            setAudit(await api.get<Audit>("/stats/false-starts"));
            setPicked(new Set());
            setPage(0);
            setArming(false);
        } catch {
            setError("Couldn't read your play history. Nothing changed.");
        } finally {
            clearInterval(tick);
            setBusy(false);
        }
    }, []);

    const act = async (path: string, ids: string[], said: (r: Record<string, number>) => string) => {
        setBusy(true);
        setError(null);
        try {
            const result = await api.post<Record<string, number>>(`/stats/false-starts/${path}`, {
                trackIds: ids,
            });
            setNote(said(result ?? {}));
            await load();
        } catch {
            setError("That didn't finish. Nothing was changed.");
            setBusy(false);
        }
    };

    if (!audit) {
        return (
            <div className="flex flex-col gap-4 items-start">
                <p className="t-body max-w-[52ch]">
                    Before the rule changed, a play was logged the moment a track started loading, so
                    clicking through an album counted every track you skipped past. This finds the
                    ones it can prove nobody listened to.
                </p>
                <button
                    onClick={load}
                    disabled={busy}
                    className="h-11 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white t-control flex items-center gap-2 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                >
                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                    Look for false starts
                </button>
                {busy && (
                    <p className="t-meta" aria-live="polite">
                        Reading every play and working out which belong to the same listen
                        {elapsed >= 3 && ` · ${elapsed}s`}
                    </p>
                )}
                {error && <p className="t-meta text-danger-light">{error}</p>}
            </div>
        );
    }

    /** Mirrors `MAX_TRACKS_PER_ACTION` in backend/src/routes/stats.ts, which rejects larger requests. */
    const MAX_PER_ACTION = 2000;
    const all = audit.tracks.map((t) => t.trackId);
    // Compare with what Select all can pick, so it flips to Select none past the cap.
    const selectable = Math.min(all.length, MAX_PER_ACTION);
    const allPicked = selectable > 0 && picked.size === selectable;
    const pickedStarts = audit.tracks
        .filter((t) => picked.has(t.trackId))
        .reduce((n, t) => n + t.skipped, 0);

    const listing = showIgnored ? audit.ignored.length : audit.tracks.length;
    const pages = Math.max(1, Math.ceil(listing / rows));
    const at = Math.min(page, pages - 1);
    const from = at * rows;
    const toggleIgnored = () => {
        setShowIgnored((v) => !v);
        setPage(0);
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-6">
            <div className="flex flex-wrap items-end gap-x-12 gap-y-4">
                <Figure n={audit.skipped} label="you didn't stay for" tone="brand" />
                <Figure n={audit.heard} label="proven you heard" />
                <Figure n={audit.unclear} label="can't tell, left alone" />
                {/* Listed whenever there are any: the figures add up to "times you
                    pressed play", and leaving this bucket out breaks that sum. */}
                {audit.tooShort > 0 && (
                    <Figure n={audit.tooShort} label="too short to ever count" />
                )}
                <Figure n={audit.totalListens} label="times you pressed play" />
            </div>

            {audit.collapsibleRows > 0 && (
                <div className="flex flex-col gap-3 items-start">
                    <p className="t-body max-w-[58ch]">
                        Your history holds{" "}
                        <span className="text-[var(--text-primary)]">
                            {audit.totalRows.toLocaleString()} records
                        </span>{" "}
                        for{" "}
                        <span className="text-[var(--text-primary)]">
                            {audit.totalListens.toLocaleString()} listens
                        </span>
                        . The extra {audit.duplicateRows.toLocaleString()} were written while a song
                        was still playing, so they describe listens already counted. Merging them
                        doesn&apos;t change a single play count, and it keeps the first and last
                        record of each listen so the evidence behind{" "}
                        <span className="text-[var(--text-primary)]">
                            {audit.heard.toLocaleString()} proven heard
                        </span>{" "}
                        survives it.
                    </p>
                    <button
                        onClick={() =>
                            act("collapse", [], (r) =>
                                `Merged ${(r.removed ?? 0).toLocaleString()} duplicate records.`,
                            )
                        }
                        disabled={busy}
                        className="h-11 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white t-control flex items-center gap-2 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                    >
                        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                        Merge {audit.collapsibleRows.toLocaleString()} duplicate records
                    </button>
                </div>
            )}

            {note && <p className="t-body text-[var(--text-primary)]">{note}</p>}

            {audit.tracks.length === 0 && !showIgnored && (
                <p className="t-body max-w-[52ch]">
                    Nothing left to judge. Every listen is either one the audit can&apos;t call or
                    one on a track you told it to leave alone.
                </p>
            )}

            {listing > 0 && (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/[0.08]">
                        {showIgnored ? (
                            <span className="t-meta">
                                {audit.ignored.length} {audit.ignored.length === 1 ? "track" : "tracks"} left alone
                            </span>
                        ) : (
                            <>
                                <button
                                    onClick={() => setPicked(allPicked ? new Set() : new Set(all.slice(0, MAX_PER_ACTION)))}
                                    className="t-control text-[var(--text-secondary)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                                >
                                    {allPicked ? "Select none" : `Select all ${selectable.toLocaleString()}`}
                                </button>
                                <span className="t-meta truncate">
                                    {picked.size > 0
                                        ? `${picked.size} selected · ${pickedStarts.toLocaleString()} listens would go`
                                        : `${all.length} tracks have listens we can prove nobody stayed for`}
                                </span>
                            </>
                        )}
                    </div>

                    <div ref={listBox} className="min-h-0 flex-1 overflow-hidden">
                        <ul className="divide-y divide-white/[0.05]">
                            {showIgnored
                                ? audit.ignored.slice(from, from + rows).map((t) => (
                                    <li key={t.trackId} className="flex items-center justify-between gap-4 py-3">
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm text-[var(--text-secondary)]">
                                                {t.title}
                                            </span>
                                            <span className="block truncate t-meta">{t.artist}</span>
                                        </span>
                                        <button
                                            onClick={() => act("restore", [t.trackId], () => "Back in the audit.")}
                                            disabled={busy}
                                            className="shrink-0 h-9 px-3 rounded-lg t-control text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                        >
                                            Put back
                                        </button>
                                    </li>
                                ))
                                : audit.tracks.slice(from, from + rows).map((t) => {
                                    const on = picked.has(t.trackId);
                                    const counts = `${t.skipped.toLocaleString()} skipped · ${t.listens.toLocaleString()} times you pressed play${t.heard > 0 ? ` · ${t.heard} proven heard` : ""}`;
                                    const rule = t.requiredSeconds == null
                                        ? `only ${clock(t.durationSeconds)} long, too short to ever count`
                                        : t.shortestRunSeconds == null
                                          ? `no run measured yet; needs ${clock(t.requiredSeconds)} to count`
                                          : `shortest ran ${Math.round(t.shortestRunSeconds)}s; needs ${clock(t.requiredSeconds)} to count`;
                                    return (
                                        <li key={t.trackId}>
                                            <label className="flex items-center gap-4 py-3 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    onChange={() =>
                                                        setPicked((s) => {
                                                            const n = new Set(s);
                                                            if (on) n.delete(t.trackId);
                                                            else n.add(t.trackId);
                                                            return n;
                                                        })
                                                    }
                                                    className="w-4 h-4 shrink-0 accent-[var(--color-brand)]"
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm text-[var(--text-primary)]">
                                                        {t.title}
                                                    </span>
                                                    <span className="block truncate t-meta">{t.artist}</span>
                                                </span>
                                                <span className="min-w-0 max-w-[55%] text-right" title={`${counts}. ${rule}`}>
                                                    <span className="block truncate t-meta text-[var(--text-muted)]">
                                                        <span className="text-brand">{t.skipped.toLocaleString()} skipped</span>
                                                        {` · ${t.listens.toLocaleString()} times you pressed play`}
                                                        {t.heard > 0 && ` · ${t.heard} proven heard`}
                                                    </span>
                                                    <span className="block truncate t-meta">{rule}</span>
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                        </ul>
                    </div>

                    <div className="flex items-center justify-between gap-4 border-t border-white/[0.08] pt-2">
                        {audit.ignored.length > 0 ? (
                            <button
                                onClick={toggleIgnored}
                                className="h-9 t-control text-[var(--text-muted)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                            >
                                {showIgnored
                                    ? "Back to the audit"
                                    : `Show ${audit.ignored.length} left alone`}
                            </button>
                        ) : <span />}
                        {pages > 1 && (
                            <div className="flex items-center gap-1">
                                <span className="t-meta mr-2">
                                    {(from + 1).toLocaleString()}–{Math.min(from + rows, listing).toLocaleString()} of {listing.toLocaleString()}
                                </span>
                                <PageButton label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)}>
                                    <ChevronLeft className="w-4 h-4" />
                                </PageButton>
                                <PageButton label="Next page" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                                    <ChevronRight className="w-4 h-4" />
                                </PageButton>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* The consequence is readable before the button is reachable, and the
                delete asks once more with the real number in it. */}
            {picked.size > 0 && !showIgnored && (
                <div className="flex flex-col gap-3">
                    <p className="t-body max-w-[62ch]">
                        <span className="text-[var(--text-primary)]">Removing can&apos;t be undone.</span>{" "}
                        It deletes only the listens the audit can prove nobody stayed for.
                        The rest of the track&apos;s history stays. Leaving alone deletes
                        nothing: it stops the track being raised again, and it goes on
                        counting normally. Neither option touches your music files.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            onClick={() =>
                                arming
                                    ? act("remove", [...picked], (r) =>
                                          `Removed ${(r.removed ?? 0).toLocaleString()} records from ${
                                              r.tracks ?? 0
                                          } tracks.`,
                                      )
                                    : setArming(true)
                            }
                            onBlur={() => setArming(false)}
                            disabled={busy}
                            className={[
                                "h-11 px-4 rounded-lg t-control flex items-center gap-2 transition-colors disabled:opacity-60",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]",
                                arming
                                    ? "bg-brand text-black"
                                    : "bg-white/[0.06] text-white hover:bg-white/[0.1]",
                            ].join(" ")}
                        >
                            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                            {arming
                                ? `Delete ${pickedStarts.toLocaleString()} listens?`
                                : `Remove from ${picked.size} ${picked.size === 1 ? "track" : "tracks"}`}
                        </button>

                        <button
                            onClick={() =>
                                act("ignore", [...picked], (r) =>
                                    `Ignoring ${r.ignored ?? 0} ${
                                        (r.ignored ?? 0) === 1 ? "track" : "tracks"
                                    }. Their counts are untouched.`,
                                )
                            }
                            disabled={busy}
                            className="h-11 px-4 rounded-lg t-control text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                        >
                            Leave alone
                        </button>
                    </div>
                </div>
            )}

            {error && <p className="t-meta text-danger-light">{error}</p>}
        </div>
    );
}

/** How many list rows fit the box, from the height of a rendered row. */
function useRowsThatFit(box: React.RefObject<HTMLDivElement | null>) {
    const [rows, setRows] = useState(6);
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const measure = () => {
            const row = el.querySelector("li");
            const rowHeight = row ? row.offsetHeight + 1 : 58;
            setRows(Math.max(1, Math.floor(el.clientHeight / rowHeight)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    });
    return rows;
}

function PageButton({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
            {children}
        </button>
    );
}

function Figure({ n, label, tone }: { n: number; label: string; tone?: "brand" }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span
                className={`t-figure text-[length:var(--stat-figure)] ${
                    tone === "brand" ? "text-brand" : ""
                }`}
            >
                {n.toLocaleString()}
            </span>
            <span className="t-label leading-snug">{label}</span>
        </div>
    );
}
