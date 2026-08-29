"use client";

/**
 * How hard the music gets, hour by hour, as a curve.
 *
 * Four bars for four parts of the day was the same form as five other things on
 * this page and threw away twenty of the twenty-four numbers. A curve is a shape
 * the eye reads as one gesture — where it dips, where it climbs — which is the
 * actual question being asked, and it is a form used nowhere else here.
 *
 * The band underneath is how much you played in that hour, so a wild swing over
 * an hour with four listens is visibly built on nothing.
 *
 * ## Nothing here is written out in a sentence
 *
 * It used to carry a line reading "hardest 6am · softest 1am · the band is how
 * much you played", which is three problems in eleven words: "hardest" is a
 * different word for the thing the taste plot already calls "frantic", "band"
 * names a shape the reader has never been told about, and the peak it reported
 * is the same peak the claim above the chart states.
 *
 * All three go away by labelling the axis instead of describing it — frantic,
 * calm and plays down the left edge, in the same vocabulary the taste plot
 * uses. The claim above says where the peak is; the labels let you read the
 * rest off the picture; nothing is said twice.
 */

import { useMemo } from "react";
import { useReveal } from "../useReveal";
import { hourLabel } from "../format";
import type { Signature } from "../types";

const W = 100, H = 34;

/** A smooth line through the points, using midpoints so it never overshoots. */
function smooth(points: Array<[number, number]>): string {
    if (points.length < 2) return "";
    let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        const mx = (x0 + x1) / 2;
        d += ` C ${mx.toFixed(2)} ${y0.toFixed(2)}, ${mx.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    return d;
}

export function EnergyCurve({ hourly }: { hourly: Signature["hourly"] }) {
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.35 });

    const { line, band, peak, trough } = useMemo(() => {
        const byHour = new Map(hourly.map((h) => [h.hour, h]));
        const rows = Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, plays: 0, energy: 0 });
        const withPlays = rows.filter((r) => r.plays > 0);
        if (withPlays.length < 3) return { line: "", band: "", peak: null, trough: null };

        const lo = Math.min(...withPlays.map((r) => r.energy));
        const hi = Math.max(...withPlays.map((r) => r.energy));
        // A floor on the span so a day whose energy barely moves is not
        // stretched into a dramatic one. That much was already right.
        //
        // What was wrong: with the span floored, `(e - lo) / span` is near zero
        // for every hour, so the whole line was drawn along the bottom of the
        // plot. A listener whose energy is simply steady got a chart that read
        // "you never play anything energetic" rather than "this does not vary".
        // Centring the real range inside the floored one puts a flat day
        // through the middle. When the real range is wider than the floor this
        // is exactly the mapping it was before.
        const range = hi - lo;
        const span = Math.max(0.08, range);
        const base = lo - (span - range) / 2;
        const maxPlays = Math.max(...rows.map((r) => r.plays));

        // Hours with nothing played carry the previous reading rather than
        // dropping to zero, which would draw a cliff that never happened.
        let last = withPlays[0].energy;
        const pts: Array<[number, number]> = rows.map((r) => {
            if (r.plays > 0) last = r.energy;
            const x = (r.hour / 23) * W;
            const y = H - ((last - base) / span) * (H - 4) - 2;
            return [x, y];
        });

        const bandPts = rows.map((r) => {
            const x = (r.hour / 23) * W;
            const h = (r.plays / maxPlays) * 11;
            return `${x.toFixed(2)},${(H + 11 - h).toFixed(2)}`;
        });

        return {
            line: smooth(pts),
            band: `M 0 ${H + 11} L ${bandPts.join(" L ")} L ${W} ${H + 11} Z`,
            peak: withPlays.reduce((a, b) => (b.energy > a.energy ? b : a)),
            trough: withPlays.reduce((a, b) => (b.energy < a.energy ? b : a)),
        };
    }, [hourly]);

    if (!line) return null;

    return (
        // Capped, and given a named axis. The viewBox is roughly two-to-one, so
        // left to fill a phone this drew a curve 280 pixels tall beside a key
        // wheel capped at 304 wide -- one graphic reading as a wall and the
        // other as a coin, when they are meant to be a pair.
        <figure
            ref={ref}
            className="m-0 grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 max-w-[34rem] xl:max-w-[44rem]"
        >
            {/* The axis, named down the left edge.
             *
             * This was explained in a sentence underneath instead -- "the band
             * is how much you played" -- which asks the reader to carry a
             * legend in their head while looking at the picture, and uses a
             * word ("band") for a shape they have no name for. The taste plot
             * higher up the page already labels this exact measure "frantic"
             * and "calm" down its own left edge. The words existed; this chart
             * just was not using them. */}
            <div className="flex flex-col items-end t-label">
                <div className="flex-[34] flex w-full flex-col items-end justify-between py-0.5">
                    <span>frantic</span>
                    <span>calm</span>
                </div>
                <div className="flex-[12] flex w-full items-center justify-end">
                    <span>plays</span>
                </div>
            </div>

            <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full" role="img"
                 aria-label={`The music you play is most frantic around ${hourLabel(peak!.hour)} and calmest around ${hourLabel(trough!.hour)}.`}>
                <path d={band} fill="var(--chart-ink-band)" />
                <path
                    d={line}
                    fill="none"
                    stroke="var(--color-brand)"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    pathLength={1}
                    style={{
                        strokeDasharray: 1,
                        strokeDashoffset: shown ? 0 : 1,
                        transition: "stroke-dashoffset 1100ms cubic-bezier(0.32,0.72,0,1)",
                    }}
                />
            </svg>

            <span aria-hidden />
            <div className="flex justify-between t-meta">
                <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
            </div>
        </figure>
    );
}
