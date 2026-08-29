"use client";

/**
 * The play-history audit, kept rather than run once.
 *
 * Before 1.10.1 a play was recorded the moment a track started loading, so
 * clicking through an album logged one for every track skipped past. Those rows
 * are still in the history and still feeding the numbers above.
 *
 * ## What can and cannot be proven
 *
 * There is no record of how long anything was heard. The only signal is the gap
 * to the next play: if another play starts eight seconds later, the first one
 * ran for at most eight seconds. That bound is one-directional — a short gap
 * proves a skip, a long gap proves nothing at all — so the audit only ever
 * raises what it can demonstrate, and says out loud how much it is leaving
 * alone.
 *
 * ## Two answers, and only one of them deletes
 *
 * **Remove** deletes the provable false starts on a track and nothing else.
 * **Ignore** deletes nothing; it tells the audit to stop raising that track,
 * which keeps accumulating plays exactly as before. Ignore exists because "the
 * evidence is right and I don't care" is a real answer, and without somewhere
 * to put it the same rows come back every time and people stop opening the tool.
 *
 * ## Why it doesn't load with the page
 *
 * The audit reads the entire play history to compute gaps. Doing that on every
 * visit to a stats page would be rude, so nothing happens until asked.
 */

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
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
    /**
     * Listens of tracks too short to ever register a play.
     *
     * Reported apart from `skipped` since the audit stopped deleting them. Left
     * out of this type, the three figures shown against "times you pressed
     * play" silently stopped adding up for anyone with short tracks.
     */
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
    // The audit routinely flags five hundred tracks. Rendering every one put
    // hundreds of checkboxes into the tab order ahead of the buttons that act
    // on them, so reaching "remove" by keyboard meant pressing Tab five hundred
    // times. It is also more than anyone reviews in one sitting.
    const [showAll, setShowAll] = useState(false);

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
                {error && <p className="t-meta text-red-400">{error}</p>}
            </div>
        );
    }

    const FIRST_PAGE = 40;
    const listed = showAll ? audit.tracks : audit.tracks.slice(0, FIRST_PAGE);

    /**
     * The most track ids one request may name.
     *
     * `MAX_TRACKS_PER_ACTION` in `backend/src/routes/stats.ts`, which answers
     * 400 above it. "Select all" took no notice, so a history flagging more
     * than this built a request that was rejected whole and reported as "That
     * didn't finish" — with nothing to say the selection was the reason, and no
     * way to get under the limit except by unpicking rows by hand.
     */
    const MAX_PER_ACTION = 2000;
    const all = audit.tracks.map((t) => t.trackId);
    // Against what the button can actually select, not against everything
    // flagged. Comparing to `all.length` meant that past the per-request cap
    // "Select all" could never flip to "Select none" — it picked 2,000, the
    // sizes never matched, and the only way to clear was unticking two thousand
    // boxes by hand.
    const selectable = Math.min(all.length, MAX_PER_ACTION);
    const allPicked = selectable > 0 && picked.size === selectable;
    const pickedStarts = audit.tracks
        .filter((t) => picked.has(t.trackId))
        .reduce((n, t) => n + t.skipped, 0);

    return (
        <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end gap-x-12 gap-y-6">
                <Figure n={audit.skipped} label="you didn't stay for" tone="brand" />
                <Figure n={audit.heard} label="proven you heard" />
                <Figure n={audit.unclear} label="can't tell, left alone" />
                {/* Shown only when there are any, but shown when there are: the
                    four figures are read against "times you pressed play" and
                    have to add up to it. Leaving this bucket out silently broke
                    that sum for anybody with tracks under thirty seconds. */}
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

            {audit.tracks.length === 0 ? (
                <p className="t-body max-w-[52ch]">
                    Nothing left to judge. Every listen is either one the audit can&apos;t call or
                    one on a track you told it to leave alone.
                </p>
            ) : (
                <>
                    <div className="flex flex-col">
                        <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/[0.08]">
                            <button
                                onClick={() => setPicked(allPicked ? new Set() : new Set(all.slice(0, MAX_PER_ACTION)))}
                                className="t-control text-[var(--text-secondary)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                            >
                                {allPicked ? "Select none" : `Select all ${Math.min(all.length, MAX_PER_ACTION).toLocaleString()}`}
                            </button>
                            <span className="t-meta">
                                {picked.size > 0
                                    ? `${picked.size} selected · ${pickedStarts.toLocaleString()} listens would go`
                                    : `${all.length} tracks have listens we can prove nobody stayed for`}
                            </span>
                        </div>

                        <ul className="divide-y divide-white/[0.05]">
                            {listed.map((t) => {
                                const on = picked.has(t.trackId);
                                return (
                                    <li key={t.trackId}>
                                        <label className="flex items-center gap-4 py-3 cursor-pointer group">
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
                                            {/* "127 of 595 plays" was ambiguous, and the
                                                line under it used "of" to mean track
                                                length — the same word doing two jobs, one
                                                above the other. Both are now spelled out. */}
                                            <span className="shrink-0 text-right">
                                                <span className="block t-meta">
                                                    <span className="text-brand">
                                                        {t.skipped.toLocaleString()} skipped
                                                    </span>
                                                    <span className="text-[var(--text-muted)]">
                                                        {" · "}
                                                        {t.listens.toLocaleString()} times you pressed play
                                                        {t.heard > 0 && ` · ${t.heard} proven heard`}
                                                    </span>
                                                </span>
                                                <span className="block t-meta">
                                                    {t.requiredSeconds == null
                                                        ? `only ${clock(t.durationSeconds)} long, too short to ever count`
                                                        : t.shortestRunSeconds == null
                                                          ? `no run measured yet; needs ${clock(t.requiredSeconds)} to count`
                                                          : `shortest ran ${Math.round(t.shortestRunSeconds)}s; needs ${clock(t.requiredSeconds)} to count`}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>

                        {!showAll && audit.tracks.length > FIRST_PAGE && (
                            <button
                                onClick={() => setShowAll(true)}
                                className="mt-4 self-start h-11 px-4 -ml-4 rounded-lg t-control text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                            >
                                Show the other {(audit.tracks.length - FIRST_PAGE).toLocaleString()} tracks
                            </button>
                        )}
                    </div>

                    {/* Nothing destructive is on screen until something is chosen,
                        and the delete asks once more with the real number in it. */}
                    {/* The consequence has to be readable before the button is
                        reachable. A warning under a delete you have already
                        armed is not a warning, it is a receipt. */}
                    {picked.size > 0 && (
                        <p className="t-body max-w-[62ch] -mb-1">
                            <span className="text-[var(--text-primary)]">Removing can&apos;t be undone.</span>{" "}
                            It deletes only the listens the audit can prove nobody stayed for.
                            The rest of the track&apos;s history stays. Leaving alone deletes
                            nothing: it stops the track being raised again, and it goes on
                            counting normally. Neither option touches your music files.
                        </p>
                    )}

                    {picked.size > 0 && (
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
                    )}


                </>
            )}

            {audit.ignored.length > 0 && (
                <div className="flex flex-col gap-3 pt-2">
                    <button
                        onClick={() => setShowIgnored((v) => !v)}
                        className="t-control text-[var(--text-muted)] hover:text-white transition-colors self-start rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                    >
                        {showIgnored ? "Hide" : "Show"} {audit.ignored.length} ignored{" "}
                        {audit.ignored.length === 1 ? "track" : "tracks"}
                    </button>
                    {showIgnored && (
                        <ul className="flex flex-col divide-y divide-white/[0.05] border-t border-white/[0.05]">
                            {audit.ignored.map((t) => (
                                <li key={t.trackId} className="flex items-center justify-between gap-4 py-2.5">
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm text-[var(--text-secondary)]">
                                            {t.title}
                                        </span>
                                        <span className="block truncate t-meta">{t.artist}</span>
                                    </span>
                                    <button
                                        onClick={() =>
                                            act("restore", [t.trackId], () => "Back in the audit.")
                                        }
                                        disabled={busy}
                                        className="shrink-0 t-meta text-[var(--text-muted)] hover:text-white transition-colors disabled:opacity-60"
                                    >
                                        put back
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {error && <p className="t-meta text-red-400">{error}</p>}
        </div>
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
