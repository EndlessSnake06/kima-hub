"use client";

/**
 * A claim about you, and the evidence for it.
 *
 * ## Why this exists at all
 *
 * The page was once organised by category — "How you listen", "The shelf",
 * "What it sounds like" — with a chart under each. A category names a drawer.
 * It tells the reader nothing and leaves the chart to do all the talking,
 * which is why nine of them in a row read as charts thrown together: there was
 * no argument running through the page, only filing.
 *
 * A finding states the thing in plain words and puts the graphic underneath as
 * proof. Read only the claims and you have the argument; read the evidence
 * when you doubt one.
 *
 * ## Why there are now three of these and not eight
 *
 * Because the form was applied to everything, including the six things that
 * were not arguments. A count of podcast subscriptions is a reading, not a
 * claim, and wrapping it in a sentence plus a supporting paragraph made the
 * page nine and a half screens long and gave every section the same silhouette.
 * Findings are for the three facts a reader would actually dispute; everything
 * else is a band or a column, and looks different because it is different.
 *
 * ## Why the claim and the note share a line
 *
 * They used to stack: a claim, then a paragraph of two or three sentences
 * under it, then a gap, then the chart. Three stacked blocks before any
 * evidence appeared. Setting the note at the far end of the claim's own line
 * puts both on one baseline and pulls the graphic up by roughly a hundred
 * pixels a section, and the rule beneath the pair is what marks where the
 * argument stops and the proof starts.
 *
 * The note is one sentence. If it needs two, the finding is doing more than
 * one job and should be split or dropped.
 */

import { Loader2, Play } from "lucide-react";
import { useReveal } from "../useReveal";
import { usePlaySlice } from "../usePlaySlice";

export function Finding({
    claim,
    note,
    evidence,
    anchor,
    scope,
}: {
    /** The thing being asserted, in plain words. The loudest element. */
    claim: React.ReactNode;
    /** One sentence of context. Never the number the claim already stated. */
    note?: React.ReactNode;
    /** The graphic that proves it. */
    evidence?: React.ReactNode;
    anchor?: string;
    /**
     * Set on findings the period control does not reach.
     *
     * The shelf sections are not made of listening events — how much of your
     * collection you have never touched does not become a different fact over
     * thirty days. Rather than let the control appear to apply and silently do
     * nothing, the section says which period it is actually about.
     */
    scope?: string;
}) {
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.1 });

    return (
        <section
            ref={ref}
            id={anchor}
            className={`scroll-mt-24 stats-settle flex flex-col gap-(--stat-gap-block) ${
                shown ? "animate-rise" : "opacity-0"
            }`}
        >
            <div className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-2 border-b border-white/[0.08] pb-4">
                <h2 className="text-[length:var(--stat-claim)] leading-[1.2] font-light tracking-[-0.02em] text-[var(--text-primary)] max-w-[26ch] text-balance">
                    {claim}
                    {scope && <span className="ml-3 t-meta align-middle">{scope}</span>}
                </h2>
                {note && <p className="t-body max-w-[42ch] lg:text-right">{note}</p>}
            </div>

            {evidence}
        </section>
    );
}

/**
 * Put the handful that make up half the listening on.
 *
 * An action belongs beside a figure when the figure names something you might
 * want to hear. "Sixty-four songs are half of everything you play" does; most
 * readings do not, and get no button.
 */
/**
 * The most a slice will ever hand back.
 *
 * `MAX_TRACKS` in `backend/src/services/stats/playable.ts`. The button printed
 * `count` unchecked, so a library where three hundred tracks make up half the
 * listening offered "Play those 300" and quietly queued a hundred. Held in step
 * by `scripts/verify-stats.ts`, which fails if the server's cap moves away from
 * this number.
 */
const SLICE_CAP = 100;

export function PlayCore({ count, period }: { count: number; period?: string }) {
    const { play, busy } = usePlaySlice();
    const willPlay = Math.min(count, SLICE_CAP);
    return (
        <button
            type="button"
            onClick={() => void play("core", { limit: willPlay, period })}
            disabled={busy === "core"}
            className="self-start h-10 px-3.5 -ml-3.5 rounded-lg t-control text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] flex items-center gap-2 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
        >
            {busy === "core" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {/* Says what will happen, not what was hoped for. */}
            {willPlay < count ? `Play ${willPlay} of them` : `Play those ${count}`}
        </button>
    );
}
