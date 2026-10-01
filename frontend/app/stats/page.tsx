"use client";

/**
 * Stats: the listener, then the server. Amber is only ever data, a figure is
 * stated once, and music time is an estimate that says "about".
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { ShapePlot } from "@/features/stats/components/ShapePlot";
import { ListeningClock } from "@/features/stats/components/ListeningClock";
import { Coverage } from "@/features/stats/components/Coverage";
import { Decades } from "@/features/stats/components/Decades";
import { SourceSplit } from "@/features/stats/components/SourceSplit";
import { SpokenWord } from "@/features/stats/components/SpokenWord";
import { SignatureSound, OwnedAgainstPlayed } from "@/features/stats/components/Signature";
import { ServerPanel } from "@/features/stats/components/ServerPanel";
import { FalseStarts } from "@/features/stats/components/FalseStarts";
import { Shortcuts, type Jump } from "@/features/stats/components/Shortcuts";
import { hourLabel, hoursValue, monthYear, percent, whenLabel } from "@/features/stats/format";
import { useReveal } from "@/features/stats/useReveal";
import { Finding, PlayCore } from "@/features/stats/components/Finding";
import { usePlaySlice } from "@/features/stats/usePlaySlice";
import Link from "next/link";
import { Play } from "lucide-react";
import { PERIODS, type Period, type ListeningStats, type StatsResponse } from "@/features/stats/types";
import { PageMessage } from "@/components/ui/PageMessage";

export default function StatsPage() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const [data, setData] = useState<StatsResponse | null>(null);
    const [failed, setFailed] = useState(false);
    // One period for the whole page, so every figure is comparable to the others.
    const [period, setPeriod] = useState<Period>("all");
    const [reloading, setReloading] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!isAuthenticated) return;
        let cancelled = false;
        (async () => {
            // Keep the old figures on screen while the new window loads. A page
            // that empties to skeletons on every toggle makes comparing two
            // windows impossible, which is the only reason to have the control.
            if (data) setReloading(true);
            try {
                // The hour-of-day grid is meaningless in UTC, so the server is
                // told which wall clock to bucket against.
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const res = await api.get<StatsResponse>(
                    `/stats?tz=${encodeURIComponent(tz)}&period=${period}`,
                );
                if (!cancelled) { setData(res); setFailed(false); }
            } catch {
                // Only `failed` is set. Writing `period` here would refire this
                // effect and the successful refetch would clear the warning; the
                // control is reconciled at render against the loaded window.
                if (!cancelled) setFailed(true);
            } finally {
                if (!cancelled) setReloading(false);
            }
        })();
        return () => { cancelled = true; };
        // `data` is deliberately not a dependency: it is read only to decide
        // whether this is a first load or a re-window.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, period, attempt]);

    if (authLoading || (!data && !failed)) return <Waiting />;

    // Error page only when there is nothing to show; a failed period switch
    // keeps the figures already on screen.
    if (!data) {
        return (
            <PageMessage
                title="Couldn't load your stats"
                description="Your listening history is fine; the page just couldn't read it."
                action={{ label: "Try again", onClick: () => { setFailed(false); setAttempt((n) => n + 1); } }}
            />
        );
    }

    const { listening, shelf, spoken, signature, system } = data;
    const hasPlays = listening.plays > 0;

    // The claim over the energy curve is read from the same numbers the curve
    // draws, rather than being a sentence somebody typed once and left.
    const played = signature.hourly.filter((h) => h.plays > 0);
    const frantic = played.length > 2
        ? played.reduce((a, b) => (b.energy > a.energy ? b : a))
        : null;

    // Only what actually rendered, so a digit never jumps to nothing.
    const jumps: Jump[] = [
        { anchor: "top", label: "Top" },
        ...(hasPlays ? [{ anchor: "played", label: "Most played" }] : []),
        // Each guard has to match the guard on the section it points at, or a
        // digit scrolls to nothing. `when` mirrors the peak check rather than
        // relying on "has plays implies has a peak", which is true today and is
        // not written down anywhere.
        ...(hasPlays && listening.peak ? [{ anchor: "when", label: "Your week" }] : []),
        ...(hasPlays && signature.key ? [{ anchor: "sound", label: "Keys and energy" }] : []),
        { anchor: "shelf", label: "The shelf" },
        { anchor: "strip", label: "Also true" },
        { anchor: "health", label: "The machine" },
    ];

    return (
        <Shell>
            {/* ── Part one: you ──────────────────────────────────────────── */}
            {hasPlays ? (
                <Ledger
                    listening={listening}
                    shelf={shelf}
                    signature={signature}
                    // What is on screen, not what was last asked for. After a
                    // failed switch these differ, and the control has to show
                    // the window whose figures are actually being displayed.
                    period={failed ? data.period : period}
                    onPeriod={setPeriod}
                    reloading={reloading}
                    stale={failed}
                />
            ) : (
                // The picker lives here too, and has to. Narrow to thirty days
                // on a library you have not touched this month and the page has
                // no plays to draw — without the control on the empty state
                // there is nothing to press to get back out of the window.
                <header className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-white/[0.08] pb-4">
                        <p className="t-eyebrow">Your listening</p>
                        <PeriodPicker value={period} onChange={setPeriod} busy={reloading} />
                    </div>
                    <h1 className="text-[length:var(--stat-hero)] leading-[1.02] font-light tracking-[-0.03em] text-[var(--text-primary)]">
                        {period === "all" ? "No plays yet" : "No plays in this period"}
                    </h1>
                    <p className="t-body leading-relaxed max-w-[48ch]">
                        {period === "all"
                            ? "This page fills in as you listen. A track counts once you've heard half of it, so clicking through an album won't pad it out."
                            : "You have not played anything in this period. Widen it above and the page fills back in."}
                    </p>
                </header>
            )}

            {/* Two dense lists and nothing else. These are the first thing
                anyone scrolls for, so they get no claim, no paragraph and no
                chart standing between the reader and the names. */}
            {hasPlays && (
                <Band
                    id="played"
                    title="Most played"
                    aside={PERIODS.find((p) => p.id === period)?.sentence || "all time"}
                >
                    <TopLists listening={listening} period={period} />
                </Band>
            )}

            {hasPlays && listening.peak && (
                <Finding
                    anchor="when"
                    claim={`Your week peaks on ${whenLabel(listening.peak.weekday, listening.peak.hour)}.`}
                    note="Every hour you have ever played anything, in your own timezone."
                    evidence={<ListeningClock listening={listening} period={period} />}
                />
            )}

            {hasPlays && signature.key && (
                <Finding
                    anchor="sound"
                    claim={
                        frantic
                            ? `The music you play is most frantic around ${hourLabel(frantic.hour)}.`
                            : "You reach for minor keys."
                    }
                    note={`Keys and energy are both read from the audio itself, across ${shelf.analysis.done.toLocaleString()} analysed tracks. Press a segment of the wheel to put that key on.`}
                    evidence={<SignatureSound signature={signature} period={period} />}
                />
            )}

            {/* The shelf and the strip carry `scope`: they describe what you
                own, which the period control does not change. */}
            <Finding
                anchor="shelf"
                claim={`${shelf.neverPlayed.toLocaleString()} tracks you have never once played.`}
                scope={period === "all" ? undefined : "all time"}
                note="That is not a failure. It is what owning a collection looks like."
                evidence={
                    <div className="flex flex-col gap-(--stat-gap-block)">
                        <Coverage shelf={shelf} />
                        {shelf.decades.length > 1 && <Decades decades={shelf.decades} />}
                    </div>
                }
            />

            {/* Everything that is a reading rather than an argument. Three
                columns, three labels, no sentences explaining what a column is
                for — the label does that, and the numbers do the rest. */}
            <Band id="strip" title="Also true" aside={period === "all" ? undefined : "all time"}>
                <div className="grid gap-x-12 gap-y-(--stat-gap-block) sm:grid-cols-2 lg:grid-cols-3">
                    {signature.ownedVsPlayed.length > 0 && (
                        <Column label="What you own against what you play">
                            <OwnedAgainstPlayed signature={signature} />
                        </Column>
                    )}
                    <Column label="Spoken word">
                        <SpokenWord spoken={spoken} />
                    </Column>
                    {hasPlays && (
                        <Column label="Where it came from">
                            <SourceSplit listening={listening} />
                        </Column>
                    )}
                </div>
            </Band>

            {/* ── Part two: the machine ──────────────────────────────────── */}
            <Divide id="health" label="The machine" />

            {system && (
                <Band id="server" title="How it's running" aside={`Kima ${system.version}`}>
                    <ServerPanel system={system} />
                </Band>
            )}

            <Band id="false-starts" title="False starts" aside="nothing runs until you ask">
                <FalseStarts />
            </Band>

            <Shortcuts jumps={jumps} />
        </Shell>
    );
}

/* ── The opening screen ──────────────────────────────────────────────────── */

/**
 * The opening screen: one sentence, a row of supporting figures, and value/gloss
 * lines beside the taste plot, so the page is read before any scrolling.
 */
function Ledger({
    listening,
    shelf,
    signature,
    period,
    onPeriod,
    reloading,
    stale,
}: {
    listening: ListeningStats;
    shelf: StatsResponse["shelf"];
    signature: StatsResponse["signature"];
    period: Period;
    onPeriod: (p: Period) => void;
    reloading: boolean;
    /** The last request failed and these figures are the previous window's. */
    stale: boolean;
}) {
    const heard = percent(shelf.tracks.heard, shelf.tracks.total);
    const window = PERIODS.find((p) => p.id === period)?.sentence ?? "";

    const facts: Array<{ value: string; note: string }> = [
        listening.peak && {
            value: whenLabel(listening.peak.weekday, listening.peak.hour),
            note: "your busiest hour, every week",
        },
        signature.concentration && {
            value: `${signature.concentration.forHalf} songs`,
            note: "are half of everything you play",
        },
        signature.key && {
            value: `${Math.round(signature.key.minorPct)}% minor`,
            note: `most often ${signature.key.top[0]?.key ?? "minor"}`,
        },
        signature.albumHabit && {
            value: `${Math.round(signature.albumHabit.inOrderPct)}% in order`,
            note: "you play albums, not songs",
        },
        signature.era && {
            value: String(signature.era.medianYear),
            note: "half of what you play is newer",
        },
    ].filter(Boolean) as Array<{ value: string; note: string }>;

    return (
        <header className="flex flex-col gap-(--stat-gap-block)">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-white/[0.08] pb-4">
                <p className="t-eyebrow">Your listening</p>
                <div className="flex items-baseline gap-4">
                    {/* "Since December 2025" is the period statement, so it only
                        belongs beside the window that actually starts there. */}
                    {period === "all" && listening.firstPlay && (
                        <p className="t-meta hidden sm:block">since {monthYear(listening.firstPlay)}</p>
                    )}
                    <PeriodPicker value={period} onChange={onPeriod} busy={reloading} />
                </div>
            </div>

            {/* Quiet, and only when it happened. Keeping the figures and saying
                nothing would leave the reader looking at a window they did not
                ask for with no way to tell. */}
            {stale && (
                <p className="t-meta text-[var(--text-secondary)]" role="status">
                    Couldn&apos;t load that period. These are still the figures for{" "}
                    {PERIODS.find((p) => p.id === period)?.label.toLowerCase() ?? "all time"}.
                </p>
            )}

            {/* Words and figures on the left, growing; the square plot on the
                right, stopping at 34rem. */}
            <div className="grid items-start gap-x-16 gap-y-(--stat-gap-block) lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
                <div className="stats-hero-figure flex flex-col gap-(--stat-gap-block)">
                    <h1
                        className="text-[length:var(--stat-hero)] leading-[1.02] font-light tracking-[-0.03em] text-[var(--text-primary)] text-balance"
                        aria-label={`About ${hoursValue(listening.estimatedSeconds)} hours of music ${window}`.trim()}
                    >
                        About{" "}
                        <span className="t-figure text-[length:var(--stat-hero)]">
                            {hoursValue(listening.estimatedSeconds)}
                        </span>{" "}
                        hours of music{window ? ` ${window}` : ""}.
                    </h1>

                    {/* One rank, four figures. The hours above are an estimate
                        and say so; these four are counts and are exact. */}
                    {/* Four across needs ~100px a column to keep labels on one
                        line, so phones under 480px get two. */}
                    <dl className="grid grid-cols-2 min-[480px]:grid-cols-4 gap-x-4 gap-y-6 sm:gap-x-8 lg:max-w-[42rem]">
                        <Reading value={listening.plays.toLocaleString()} label="listens" />
                        <Reading value={listening.distinctArtists.toLocaleString()} label="artists" />
                        <Reading value={listening.distinctAlbums.toLocaleString()} label="albums" />
                        <Reading value={`${heard}%`} label="of your shelf" />
                    </dl>

                    <div className="flex flex-col gap-5">
                        <dl className="flex flex-col lg:max-w-[42rem]">
                        {facts.map((f) => (
                            <div
                                key={f.value}
                                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-white/[0.05] py-2.5 last:border-0"
                            >
                                <dt className="t-figure text-[length:var(--stat-lead)] leading-tight">
                                    {f.value}
                                </dt>
                                <dd className="t-body">{f.note}</dd>
                            </div>
                        ))}
                    </dl>
                        {signature.concentration && (
                            <PlayCore count={signature.concentration.forHalf} period={period} />
                        )}
                    </div>
                </div>

                <div className="w-full max-w-[26rem] lg:max-w-none lg:justify-self-end">
                    <ShapePlot listening={listening} period={period} />
                </div>
            </div>
        </header>
    );
}

/**
 * The one period every listening figure is measured over. The live option is
 * underlined in the same amber the coverage figures use.
 */
function PeriodPicker({
    value,
    onChange,
    busy,
}: {
    value: Period;
    onChange: (p: Period) => void;
    busy: boolean;
}) {
    return (
        <div
            role="group"
            aria-label="Period"
            aria-busy={busy}
            className={`flex items-baseline gap-4 transition-opacity ${busy ? "opacity-50" : ""}`}
        >
            {PERIODS.map((p) => {
                const live = p.id === value;
                return (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => onChange(p.id)}
                        aria-pressed={live}
                        className={[
                            "t-control py-1 border-b-[1.5px] transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                            "focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]",
                            live
                                ? "text-[var(--text-primary)] border-brand"
                                : "text-[var(--text-muted)] border-transparent hover:text-[var(--text-secondary)]",
                        ].join(" ")}
                    >
                        {p.label}
                    </button>
                );
            })}
        </div>
    );
}

/** A count and what it counts. The count is heavy; the label is not. */
function Reading({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex flex-col gap-2">
            <dd className="t-figure text-[length:var(--stat-figure)]">{value}</dd>
            <dt className="t-label leading-snug">{label}</dt>
        </div>
    );
}

/* ── Structure ───────────────────────────────────────────────────────────── */

/**
 * A named block that reports rather than argues. Its rule sits on the heading's
 * baseline and ends in one fact about what follows.
 */
function Band({
    id,
    title,
    aside,
    children,
}: {
    id?: string;
    title: string;
    /** One fact about this band, set at the end of the rule. */
    aside?: string;
    children: React.ReactNode;
}) {
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.1 });

    return (
        <section
            ref={ref}
            id={id}
            className={`flex flex-col scroll-mt-24 stats-settle ${shown ? "animate-rise" : "opacity-0"}`}
        >
            <div className="flex items-baseline gap-5 mb-6">
                <h2 className="shrink-0 text-[length:var(--stat-head)] leading-none font-normal tracking-[-0.01em] text-[var(--text-primary)]">
                    {title}
                </h2>
                <div className="h-px flex-1 translate-y-[-0.35em] bg-white/[0.08]" />
                {aside && (
                    <span className="shrink-0 t-meta hidden sm:block max-w-[24ch] text-right">
                        {aside}
                    </span>
                )}
            </div>
            {children}
        </section>
    );
}

/** One column of the readings strip. */
function Column({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-4">
            <h3 className="t-label text-[var(--text-secondary)]">{label}</h3>
            {children}
        </div>
    );
}

/** Full-width break between listening figures and the server's health. */
function Divide({ id, label }: { id: string; label: string }) {
    return (
        <div id={id} className="flex items-center gap-6 scroll-mt-24 pt-2">
            <span className="t-eyebrow shrink-0">{label}</span>
            <span className="h-px flex-1 bg-white/[0.14]" />
        </div>
    );
}

/** Page gutters, and the measure the whole page is set to. */
function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="relative page-shell pb-28">
            {/* Scroll progress. Kept outside the gapped column so it adds no
             * section gap above the first content. */}
            <div aria-hidden className="sticky top-0 z-(--z-raised) -mx-5 sm:-mx-8 lg:-mx-12 h-px bg-white/[0.04]">
                <div className="stats-progress-rule h-full w-full bg-brand/50 origin-left scale-x-0" />
            </div>

            {/* The gap belongs between sections, not above the first one. */}
            <div className="flex flex-col gap-(--stat-gap-section) pt-6 sm:pt-8">
                {children}
            </div>
        </div>
    );
}

/* ── The lists ───────────────────────────────────────────────────────────── */

function TopLists({ listening, period }: { listening: ListeningStats; period: Period }) {
    return (
        <div className="grid gap-(--stat-gap-block) sm:grid-cols-2 sm:gap-x-16">
            <Ranked
                label="Artists"
                kind="artist"
                period={period}
                items={listening.topArtists.map((a) => ({
                    key: a.id,
                    id: a.id,
                    primary: a.name,
                    count: a.plays,
                }))}
            />
            <Ranked
                label="Tracks"
                kind="track"
                period={period}
                items={listening.topTracks.map((t) => ({
                    key: t.id,
                    id: t.id,
                    primary: t.title,
                    secondary: t.artist,
                    count: t.plays,
                }))}
            />
        </div>
    );
}

function Ranked({
    label,
    items,
    kind,
    period,
}: {
    label: string;
    items: Array<{ key: string; id?: string; primary: string; secondary?: string; count: number }>;
    /** Tracks play where they sit; artists go to their page. */
    kind: "track" | "artist";
    /** So pressing a row plays the window the list was drawn from. */
    period: Period;
}) {
    const { play, busy } = usePlaySlice();

    return (
        <div className="flex flex-col gap-3">
            <h3 className="t-label text-[var(--text-secondary)]">{label}</h3>
            <ol className="flex flex-col gap-1.5">
                {items.map((item, i) => {
                    const inner = (
                        <>
                            <span className="min-w-0 flex items-baseline gap-3">
                                <span className="t-meta w-3 shrink-0 text-right">{i + 1}</span>
                                <span className="min-w-0">
                                    <span
                                        className={`block truncate text-sm leading-tight text-[var(--text-primary)] ${
                                            i === 0 ? "font-semibold" : "font-normal"
                                        }`}
                                    >
                                        {item.primary}
                                    </span>
                                    {item.secondary && (
                                        <span className="block truncate t-meta">{item.secondary}</span>
                                    )}
                                </span>
                            </span>
                            <span className="flex items-center gap-2 shrink-0">
                                {kind === "track" && (
                                    <Play
                                        aria-hidden
                                        className="w-3.5 h-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                                    />
                                )}
                                <span className="t-figure text-xs text-[var(--text-secondary)]">
                                    {item.count.toLocaleString()}
                                </span>
                            </span>
                        </>
                    );
                    const shared =
                        "group t-touch-row w-full flex items-center justify-between gap-4 rounded px-2 -mx-2 py-1 -my-1 text-left " +
                        "transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 " +
                        "focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]";

                    return (
                        <li key={item.key}>
                            {kind === "artist" && item.id ? (
                                <Link href={`/artist/${item.id}`} className={shared}>
                                    {inner}
                                </Link>
                            ) : kind === "track" ? (
                                <button
                                    type="button"
                                    onClick={() => play("top", { limit: items.length, startIndex: i, token: item.key, period })}
                                    disabled={busy === item.key}
                                    aria-label={`Play ${item.primary}`}
                                    className={shared + (busy === item.key ? " opacity-60" : "")}
                                >
                                    {inner}
                                </button>
                            ) : (
                                <span className={shared.replace("hover:bg-white/[0.05]", "")}>{inner}</span>
                            )}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function Waiting() {
    return (
        <Shell>
            <div className="flex flex-col gap-(--stat-gap-block)" aria-busy="true" aria-label="Loading your stats">
                <div className="h-3 w-28 rounded bg-white/[0.05] animate-pulse" />
                <div className="h-12 w-80 max-w-full rounded bg-white/[0.04] animate-pulse" />
                <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="flex flex-col gap-2">
                            <div
                                className="h-8 w-20 rounded bg-white/[0.04] animate-pulse"
                                style={{ animationDelay: `${i * 90}ms` }}
                            />
                            <div className="h-2.5 w-14 rounded bg-white/[0.025] animate-pulse" />
                        </div>
                    ))}
                </div>
                <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                    <div className="flex flex-col gap-3">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <div
                                key={i}
                                className="h-4 w-full max-w-xs rounded bg-white/[0.03] animate-pulse"
                                style={{ animationDelay: `${120 + i * 70}ms` }}
                            />
                        ))}
                    </div>
                    {/* Square, because a square is what lands here. */}
                    <div className="aspect-square w-full rounded bg-white/[0.025] animate-pulse [animation-delay:200ms]" />
                </div>
            </div>
        </Shell>
    );
}
