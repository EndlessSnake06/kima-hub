"use client";

/**
 * The shelf along a timeline, not as another column chart.
 *
 * This was a row of columns sitting two sections away from the album-position
 * curve, which is also a row of columns. Two bar charts on one page about
 * unrelated things read as one texture and the second one stops being looked
 * at.
 *
 * A timeline is the shape decades already have. Each decade is a disc on the
 * line, sized by how many albums you own from it, filled by how many you have
 * opened. Two facts per mark, no axis needed, and a form used nowhere else here.
 */

import type { ShelfStats } from "../types";
import { useReveal } from "../useReveal";

export function Decades({ decades }: { decades: ShelfStats["decades"] }) {
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.35 });
    if (decades.length < 2) return null;

    const max = decades.reduce((m, d) => Math.max(m, d.albums), 0);
    if (max === 0) return null;

    const biggest = decades.reduce((a, b) => (b.albums > a.albums ? b : a));
    // A decade with one or two albums is not evidence of neglect, so those are
    // excluded from the running. They were not: `reduce` was seeded with
    // `decades[0]`, which sits outside the filter and stays in the comparison
    // regardless — so the oldest decade could be named "the one you've left
    // alone" on the strength of a single unplayed record, which is exactly the
    // claim the filter exists to prevent. Reducing over the filtered list with
    // no seed keeps the filter meaningful, and an empty list yields nothing to
    // say rather than a decade that was excluded.
    const judged = decades.filter((d) => d.albums >= 3);
    const coldest = judged.length
        ? judged.reduce((a, b) => (b.heard / b.albums < a.heard / a.albums ? b : a))
        : null;

    const W = 100;
    const gaps = Math.max(1, decades.length - 1);

    // The biggest disc must still fit its own slot. Sizing to the data alone
    // let the busy decades swallow their neighbours and run off the edge —
    // three discs merged into one blob and the last one covered the caption.
    // Insetting the ends by a radius shrinks the spacing, so a cap based on the
    // un-inset step is still too generous — the two busiest decades touched.
    // Solving 2R <= (W - 2R) / gaps gives the largest radius that cannot
    // collide, and a little is taken off for daylight between them.
    const maxR = Math.min(9.5, (W / (2 * (gaps + 1))) * 0.92);
    const minR = Math.min(2.6, maxR * 0.32);

    // Area carries the count, because a disc twice as wide reads as four times
    // as much and would make the busy decades lie.
    //
    // Getting that right means solving for the radius, not scaling one. The
    // previous line was `minR + sqrt(a/max) * (maxR - minR)` — an affine
    // function of sqrt(a), whose area expands to
    // `pi*(minR^2 + 2*minR*d*sqrt(a/max) + d^2*a/max)`. The squared and cross
    // terms mean area was never proportional to the count; a decade with a
    // tenth of the maximum was drawn far larger than a tenth of the area.
    // Interpolating between the two areas instead and taking the root gives a
    // radius that still lands on minR at zero and maxR at the top, but where
    // the difference in ink between two decades is the difference in albums.
    const radius = (albums: number) =>
        Math.sqrt(minR * minR + (albums / max) * (maxR * maxR - minR * minR));

    const H = maxR * 2 + 4;
    // Inset the ends by a full radius so the first and last are not clipped.
    const step = (W - maxR * 2) / gaps;
    const at = (i: number) => maxR + i * step;

    return (
        <figure ref={ref} className="m-0 grid items-center gap-x-12 gap-y-8 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
                     aria-label={`Albums you own by decade. Most are from the ${String(biggest.decade).slice(2)}s.`}>
                    <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--chart-ink-rule)" strokeWidth="0.3" />
                    {decades.map((d, i) => {
                        const cx = at(i);
                        const r = radius(d.albums);
                        const heard = d.albums > 0 ? d.heard / d.albums : 0;
                        return (
                            <g key={d.decade}>
                                <circle
                                    cx={cx} cy={H / 2} r={r}
                                    /* The outline is what makes a disc a disc.
                                       At 12% white and a third of a viewBox
                                       unit it came out under two pixels of
                                       near-black, so a shelf that is only 8%
                                       heard drew a line with nothing on it. */
                                    fill="var(--chart-ink-empty)"
                                    stroke="var(--chart-ink-edge)" strokeWidth="0.4"
                                    style={{
                                        transform: `scale(${shown ? 1 : 0})`,
                                        transformOrigin: `${cx}px ${H / 2}px`,
                                        transition: "transform 560ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${i * 70}ms`,
                                    }}
                                />
                                {/* The opened share fills from the bottom, so the
                                    disc reads as a vessel rather than a pie. */}
                                <clipPath id={`fill-${d.decade}`}>
                                    <rect x={cx - r} y={H / 2 + r - 2 * r * heard} width={2 * r} height={2 * r * heard} />
                                </clipPath>
                                <circle
                                    cx={cx} cy={H / 2} r={r}
                                    fill="var(--color-brand)"
                                    clipPath={`url(#fill-${d.decade})`}
                                    style={{
                                        transform: `scale(${shown ? 1 : 0})`,
                                        transformOrigin: `${cx}px ${H / 2}px`,
                                        transition: "transform 560ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${i * 70 + 110}ms`,
                                    }}
                                />
                                <title>{`${d.decade}s: ${d.heard} of ${d.albums} albums opened`}</title>
                            </g>
                        );
                    })}
                </svg>
                {/* Labels sit under their own disc rather than spreading edge to
                    edge, which put them a full slot away from what they name. */}
                <div className="relative h-4">
                    {decades.map((d, i) => (
                        <span
                            key={d.decade}
                            className="absolute t-meta tabular-nums -translate-x-1/2"
                            style={{ left: `${at(i)}%` }}
                        >
                            {String(d.decade).slice(2)}
                        </span>
                    ))}
                </div>
            </div>

            {/* The legend used to be a full sentence set at body size, sitting
                above a second full sentence. Two paragraphs to explain a chart
                with two variables. It is a legend: it goes at meta size, on one
                line, under the sentence that actually says something. */}
            <figcaption className="flex flex-col gap-2 max-w-[30ch]">
                <p className="t-body">
                    Most of your shelf is the{" "}
                    <span className="t-figure text-sm">{String(biggest.decade).slice(2)}s</span>
                    {coldest && coldest.decade !== biggest.decade && (
                        <>
                            , and the{" "}
                            <span className="t-figure text-sm">
                                {String(coldest.decade).slice(2)}s
                            </span>{" "}
                            is the one you&apos;ve left alone
                        </>
                    )}
                    .
                </p>
                <p className="t-meta">size is what you own · amber is what you&apos;ve opened</p>
            </figcaption>
        </figure>
    );
}
