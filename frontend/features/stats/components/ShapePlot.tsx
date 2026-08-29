"use client";

/**
 * Your taste as a place, and the path you have walked through it.
 *
 * Two axes the analysis pass already measures for every track: how bright a
 * piece of music sounds across, and how hard it drives up. Every cell you have
 * played is a dot, sized and lit by how often. The result is a cloud that is
 * different for every person, which is the whole reason it sits at the top of
 * the page.
 *
 * The line through it is the same data cut by month. Drawn faint at the
 * beginning and bright at the end, so the direction reads without a legend.
 *
 * ## Why one graphic instead of two
 *
 * The cloud alone says what you like. The path alone says how you have changed.
 * Drawn apart they are two charts a person compares from memory; drawn together
 * the change is a shape you can see at a glance, sitting inside the thing it
 * changed relative to.
 *
 * ## The month strip
 *
 * Under the plot is one tick per month, its height the number of plays. It is a
 * volume chart and a control at once: point at a month and the ring walks back
 * to where you were standing then, and the reading rewrites itself. That turns
 * a picture you look at once into something you can ask questions of, which is
 * the difference between a poster and an instrument.
 *
 * ## Amber means data
 *
 * Every amber pixel on this page is a number. The grid, the axis rules and the
 * labels are all grey. That is what keeps the accent meaning something.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useReveal } from "../useReveal";
import { monthLabel, monthLong } from "../format";
import type { ListeningStats } from "../types";

const BUCKETS = 24;

/** The largest dot drawn, in viewBox units. */
const MAX_DOT_RADIUS = 2.8;

/**
 * The largest painted radius of anything in the plot.
 *
 * Not the largest dot: the ring marking the current month is r=3 with a 2-wide
 * stroke, so it paints four units out from its centre. Insetting by the dot
 * radius alone left the ring's outline hanging over the frame — eleven circles
 * escaping by up to three and a half pixels, which is invisible in a
 * downscaled screenshot and obvious on a real display.
 */
const MAX_PAINTED_RADIUS = 4.2;

/**
 * Bucket 1..24 to a point inside the frame.
 *
 * Inset by the largest radius at both ends. Mapping straight onto 0..100 puts
 * the centre of an edge cell on the border itself, so half of every extreme dot
 * hangs outside the rule meant to contain it — visible as a scatter of loose
 * circles along the top and left.
 */
const PAD = MAX_PAINTED_RADIUS;
const cellCentre = (bucket: number) =>
    PAD + (((bucket - 0.5) / BUCKETS) * (100 - PAD * 2));

/** A 0..1 measure onto the same inset scale, so the path shares the frame. */
const onScale = (v: number) => PAD + v * (100 - PAD * 2);

/** The inverse of `cellCentre`: a point in the box back to a bucket. */
const bucketAt = (pos: number) =>
    Math.min(BUCKETS, Math.max(1, Math.round(((pos - PAD) / (100 - PAD * 2)) * BUCKETS + 0.5)));

interface Region {
    x: number; y: number; listens: number;
    tracks: Array<{ title: string; artist: string; listens: number }>;
    energy: number | null; valence: number | null; bpm: number | null;
}

const brightness = (v: number) =>
    v < 0.4 ? "sombre" : v > 0.6 ? "bright" : "neither bright nor sombre";
const drive = (e: number) => (e < 0.4 ? "calm" : e > 0.6 ? "driving" : "steady");

export function ShapePlot({ listening, period }: { listening: ListeningStats; period?: string }) {
    const { shape, drift } = listening;
    const [at, setAt] = useState<number | null>(null);
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.25 });

    /* Pointing at the cloud asks what is actually there.
     *
     * A scatter can say "this is your shape" and can never say what the shape
     * is made of. The answer is one small query away and the question gets
     * asked the moment anybody looks at it properly, so it is worth answering.
     *
     * Debounced, because sweeping across the plot would otherwise fire a
     * request per pixel, and ticketed, so a slow answer for somewhere the
     * pointer has already left never lands. */
    const [probe, setProbe] = useState<{ x: number; y: number } | null>(null);
    // The answer and the point it answers for, kept together. Storing the
    // region alone meant clearing it needed a state write from the effect, and
    // it also let the previous point's answer sit under the new point for as
    // long as the next request took.
    const [answered, setAnswered] = useState<{ x: number; y: number; region: Region | null } | null>(null);
    const ticket = useRef(0);

    useEffect(() => {
        if (!probe) return;
        const mine = ++ticket.current;
        const timer = setTimeout(async () => {
            try {
                const res = await api.get<Region>(
                    `/stats/region?x=${probe.x}&y=${probe.y}${period ? `&period=${period}` : ""}`,
                );
                if (ticket.current === mine) setAnswered({ x: probe.x, y: probe.y, region: res });
            } catch {
                if (ticket.current === mine) setAnswered({ x: probe.x, y: probe.y, region: null });
            }
        }, 180);
        return () => clearTimeout(timer);
        // Same reason as the hour panel: the URL carries the window, so the
        // window has to invalidate the fetch.
    }, [probe, period]);

    // Derived, so pointing somewhere new shows nothing rather than the last
    // place's answer, and letting go clears it without a state write.
    const region =
        probe && answered && answered.x === probe.x && answered.y === probe.y
            ? answered.region
            : null;

    const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        const vx = ((e.clientX - box.left) / box.width) * 100;
        const vy = ((e.clientY - box.top) / box.height) * 100;
        const next = { x: bucketAt(vx), y: bucketAt(100 - vy) };
        setProbe((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    }, []);

    const cloud = useMemo(() => {
        const max = shape.reduce((m, p) => Math.max(m, p.plays), 0);
        if (max === 0) return [];
        return shape.map((p) => {
            const weight = Math.sqrt(p.plays / max);
            return {
                key: `${p.x}-${p.y}`,
                cx: cellCentre(p.x),
                cy: 100 - cellCentre(p.y),
                r: 0.7 + weight * (MAX_DOT_RADIUS - 0.7),
                opacity: 0.2 + weight * 0.7,
            };
        });
    }, [shape]);

    // Months with no analysed plays have nothing to place, so they drop out
    // rather than collapsing the line into a corner.
    const path = useMemo(
        () =>
            drift
                .filter((d) => d.energy != null && d.valence != null)
                .map((d) => ({
                    month: d.month,
                    plays: d.plays,
                    energy: d.energy!,
                    valence: d.valence!,
                    bpm: d.bpm,
                    x: onScale(d.valence!),
                    y: 100 - onScale(d.energy!),
                })),
        [drift],
    );

    const active = at != null && path[at] ? at : path.length - 1;
    const maxMonth = path.reduce((m, p) => Math.max(m, p.plays), 0) || 1;
    const here = path[active];
    const latest = path[path.length - 1];

    /**
     * The centre of the whole cloud, for the sentence that speaks for all of it.
     *
     * The idle caption reads "Most of what you play is …" and used to take its
     * adjectives from `here`, which with nothing hovered is the LAST MONTH. So a
     * sentence claiming to describe every listen was computed from the newest
     * one twelfth of them — and the newest month is usually still in progress.
     *
     * On the library this was found against, the two happened to agree, which
     * is why it survived: August averaged 0.724 energy and all time averaged
     * 0.662, and both land in "driving". They do not always agree. Loading the
     * page in December would have read "Most of what you play is steady" off 63
     * listens while all 4,107 said "driving", and in January it would have
     * claimed "bright" for a year that is not.
     *
     * `shape` is the full histogram — every analysed listen, not one month — so
     * the play-weighted centre of its cells is the figure the sentence is
     * actually about. Bucket centres, so the resolution is one 24th of an axis.
     */
    const overall = useMemo(() => {
        let n = 0, valence = 0, energy = 0;
        for (const cell of shape) {
            n += cell.plays;
            valence += cell.plays * ((cell.x - 0.5) / BUCKETS);
            energy += cell.plays * ((cell.y - 0.5) / BUCKETS);
        }
        return n > 0 ? { valence: valence / n, energy: energy / n } : null;
    }, [shape]);

    /**
     * The corner you never visit.
     *
     * A large empty region reads as a chart that failed to draw, not as a fact
     * about the person looking at it. Naming it converts the hole into the most
     * interesting thing on the plot: not "here is what you play" but "here is
     * what you never reach for". Only said when the corner is genuinely bare —
     * below one play in twenty — because "you rarely" is not worth a sentence.
     */
    const barestCorner = useMemo(() => {
        const total = shape.reduce((n, c) => n + c.plays, 0);
        if (total === 0) return null;
        const mid = BUCKETS / 2;
        const quadrants = [
            { name: "sombre and calm",    plays: 0, test: (c: typeof shape[0]) => c.x <= mid && c.y <= mid },
            { name: "bright and calm",    plays: 0, test: (c: typeof shape[0]) => c.x > mid && c.y <= mid },
            { name: "sombre and driving", plays: 0, test: (c: typeof shape[0]) => c.x <= mid && c.y > mid },
            { name: "bright and driving", plays: 0, test: (c: typeof shape[0]) => c.x > mid && c.y > mid },
        ];
        for (const cell of shape) {
            const q = quadrants.find((q) => q.test(cell));
            if (q) q.plays += cell.plays;
        }
        const bare = quadrants.reduce((a, b) => (b.plays < a.plays ? b : a));
        const share = bare.plays / total;
        return share < 0.05 ? { name: bare.name, percent: Math.round(share * 100) } : null;
    }, [shape]);

    const movement = useMemo(() => {
        if (path.length < 3) return null;
        const first = path[0];
        const dE = latest.energy - first.energy;
        const dV = latest.valence - first.valence;
        const parts: string[] = [];
        if (Math.abs(dE) > 0.02) parts.push(dE > 0 ? "harder" : "calmer");
        if (Math.abs(dV) > 0.02) parts.push(dV > 0 ? "brighter" : "darker");
        if (parts.length === 0) return "You've held roughly the same ground throughout.";
        return `Since ${monthLong(first.month)} you've drifted ${parts.join(" and ")}.`;
    }, [path, latest]);

    if (cloud.length === 0) {
        return (
            <p className="t-body max-w-[46ch]">
                Your shape appears once the audio analysis has run. It reads every track for
                brightness and drive, then plots what you actually play.
            </p>
        );
    }

    return (
        <figure
            ref={ref}
            className="m-0 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2"
        >
            <>
                <div className="flex flex-col justify-between items-end t-label py-0.5">
                    <span>frantic</span>
                    <span>calm</span>
                </div>

                <svg
                    viewBox="0 0 100 100"
                    className="w-full aspect-square touch-none"
                    onPointerMove={onMove}
                    onPointerLeave={() => setProbe(null)}
                    role="img"
                    aria-label={
                        overall
                            ? `Your listening centres on music that is ${brightness(overall.valence)} and ${drive(overall.energy)}.`
                            : "Your listening by brightness and drive."
                    }
                >
                    <g stroke="var(--chart-ink-empty)" strokeWidth="0.3">
                        {[25, 50, 75].map((v) => (
                            <line key={`v${v}`} x1={v} y1="0" x2={v} y2="100" />
                        ))}
                        {[25, 50, 75].map((h) => (
                            <line key={`h${h}`} x1="0" y1={h} x2="100" y2={h} />
                        ))}
                    </g>
                    <rect
                        x="0" y="0" width="100" height="100"
                        fill="none" stroke="var(--chart-ink-rule)" strokeWidth="0.3"
                    />

                    <g>
                        {cloud.map((d) => (
                            <circle
                                key={d.key}
                                cx={d.cx} cy={d.cy} r={d.r}
                                fill="var(--color-brand)"
                                opacity={shown ? d.opacity : 0}
                                style={{
                                    transition: "opacity 520ms cubic-bezier(0.25,1,0.5,1)",
                                    // Densest cells first: the shape resolves out
                                    // of its own centre rather than all at once.
                                    transitionDelay: `${Math.round((1 - d.r / MAX_DOT_RADIUS) * 420)}ms`,
                                }}
                            />
                        ))}
                    </g>

                    {probe && (
                        <rect
                            x={cellCentre(probe.x - 1) - (100 - PAD * 2) / BUCKETS / 2}
                            y={100 - cellCentre(probe.y + 1) - (100 - PAD * 2) / BUCKETS / 2}
                            width={(3 * (100 - PAD * 2)) / BUCKETS}
                            height={(3 * (100 - PAD * 2)) / BUCKETS}
                            fill="none"
                            stroke="rgba(255,255,255,0.55)"
                            strokeWidth="0.4"
                            rx="1"
                            pointerEvents="none"
                        />
                    )}

                    {path.length > 1 && (
                        <g>
                            {/* No connecting line.
                                A centre of gravity moves very little month to
                                month, so joining the points draws a tangle that
                                crosses itself four or five times and reads as
                                noise rather than a journey. Only visible at full
                                size — at thumbnail scale it looked like a path.
                                The months are marked instead: bigger where you
                                listened more, brighter as they approach now. The
                                drift is legible as a gradient across the cloud,
                                which is what it actually is. */}
                            {path.map((p, i) => {
                                const age = i / Math.max(1, path.length - 1);
                                const weight = Math.sqrt(p.plays / maxMonth);
                                return i === active ? null : (
                                    <g key={`m-${p.month}`}>
                                        <circle
                                            cx={p.x} cy={p.y} r={1 + weight * 1.6}
                                            fill="none" stroke="#0a0a0a" strokeWidth="1.6"
                                            opacity={shown ? 0.85 : 0}
                                            style={{
                                                transition: "opacity 260ms ease-out",
                                                transitionDelay: `${560 + i * 80}ms`,
                                            }}
                                        />
                                        <circle
                                            cx={p.x} cy={p.y} r={1 + weight * 1.6}
                                            fill="#f5f5f5"
                                            opacity={shown ? 0.2 + 0.62 * age : 0}
                                            style={{
                                                transition: "opacity 260ms ease-out",
                                                transitionDelay: `${560 + i * 80}ms`,
                                            }}
                                        />
                                    </g>
                                );
                            })}

                            {/* Where you are now, or the month under the pointer. */}
                            <g
                                style={{
                                    transform: `translate(${here.x}px, ${here.y}px) scale(${shown ? 1 : 0})`,
                                    transformOrigin: `${here.x}px ${here.y}px`,
                                    transition: "transform 320ms cubic-bezier(0.25,1,0.5,1)",
                                    transitionDelay: shown ? `${560 + path.length * 80}ms` : "0ms",
                                }}
                            >
                                <circle r="3" fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
                                <circle r="3" fill="none" stroke="#ffffff" strokeWidth="1" />
                                <circle r="1" fill="#ffffff" />
                            </g>
                        </g>
                    )}
                </svg>

                <div />
                <div className="flex justify-between t-label">
                    <span>sombre</span>
                    <span>bright</span>
                </div>
            </>

            {path.length > 2 && (
                <>
                    <span
                        className="t-label text-right self-end pb-1 mt-4"
                        onMouseLeave={() => setAt(null)}
                    >
                        plays
                    </span>
                    <div
                        className="flex items-end gap-[3px] h-12 mt-4"
                        onMouseLeave={() => setAt(null)}
                    >
                        {path.map((p, i) => (
                            <button
                                key={p.month}
                                type="button"
                                onMouseEnter={() => setAt(i)}
                                onFocus={() => setAt(i)}
                                onClick={() => setAt(i)}
                                aria-label={`${monthLabel(p.month)}, ${p.plays} listens`}
                                className="flex-1 flex items-end h-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                                title={`${monthLabel(p.month)}: ${p.plays.toLocaleString()} plays`}
                            >
                                <span
                                    className="block w-full transition-colors duration-150"
                                    style={{
                                        height: `${Math.max(6, (p.plays / maxMonth) * 100)}%`,
                                        background:
                                            i === active
                                                ? "#f5f5f5"
                                                : "color-mix(in oklab, var(--color-brand) 45%, transparent)",
                                    }}
                                />
                            </button>
                        ))}
                    </div>
                </>
            )}

            {/* The plot is a single image to assistive technology, which means a
                summary sentence was the whole of it. The same figures as a table
                give a screen reader the evidence rather than only the verdict. */}
            {/* `sr-only` in Tailwind v4 hides with clip-path and leaves the box
                its natural size — this table lays out 517 pixels wide. It does
                not break a phone today only because an ancestor happens to clip
                it, which is not a guarantee, it is luck. Pinned to a single
                pixel so no future layout change can let it push the page wide. */}
            <div className="absolute w-px h-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap border-0 p-0 -m-px">
            <table>
                <caption>Your listening by month: brightness, drive and volume</caption>
                <thead>
                    <tr>
                        <th scope="col">Month</th>
                        <th scope="col">Brightness, 0 to 100</th>
                        <th scope="col">Drive, 0 to 100</th>
                        <th scope="col">Beats per minute</th>
                        <th scope="col">Listens</th>
                    </tr>
                </thead>
                <tbody>
                    {path.map((m) => (
                        <tr key={`row-${m.month}`}>
                            <th scope="row">{monthLong(m.month)}</th>
                            <td>{Math.round(m.valence * 100)}</td>
                            <td>{Math.round(m.energy * 100)}</td>
                            <td>{m.bpm ? Math.round(m.bpm) : "unknown"}</td>
                            <td>{m.plays.toLocaleString()}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            </div>

            <span />
            {/* Reserved height, so walking the strip never nudges the page.
                In the grid's content column, so it starts at the plot's left
                edge rather than the figure's. */}
            <figcaption className="relative mt-4 h-[10rem] overflow-hidden">
                <div className="absolute inset-x-0 top-0 flex flex-col gap-2">
                {region && region.listens > 0 ? (
                    <>
                        <p className="text-[length:var(--stat-lead)] leading-snug font-light text-[var(--text-primary)] max-w-[30ch]">
                            Music here is {drive(region.energy ?? 0.5)} and{" "}
                            {brightness(region.valence ?? 0.5)}.
                        </p>
                        <p className="t-meta">
                            {region.listens.toLocaleString()} of your listens land in this corner
                            {region.bpm ? ` · around ${Math.round(region.bpm)} beats a minute` : ""}
                        </p>
                        <ul className="flex flex-col gap-1 mt-1">
                            {region.tracks.map((t) => (
                                <li key={`${t.title}-${t.artist}`} className="flex items-baseline justify-between gap-4 max-w-[34ch]">
                                    <span className="min-w-0 truncate text-sm text-[var(--text-secondary)]">
                                        <span className="text-[var(--text-primary)]">{t.title}</span>
                                        {" · "}{t.artist}
                                    </span>
                                    <span className="t-meta shrink-0">{t.listens}</span>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : (
                    <>
                        <p className="text-[length:var(--stat-lead)] leading-snug font-light text-[var(--text-primary)] max-w-[30ch]">
                            {at == null && overall
                                ? <>Most of what you play is {drive(overall.energy)} and {brightness(overall.valence)}.</>
                                : <>{monthLong(here.month)} was {drive(here.energy)} and {brightness(here.valence)}.</>}
                        </p>
                        <p className="t-body max-w-[36ch]">
                            {at == null
                                ? movement
                                : `${here.plays.toLocaleString()} plays that month${
                                      here.bpm ? `, averaging ${Math.round(here.bpm)} beats a minute` : ""
                                  }.`}
                        </p>
                        {/* The bare corner used to get its own paragraph at body
                            size — a fourth sentence about one graphic, before
                            the reader had scrolled at all. The fact is worth
                            keeping and a paragraph is not, so it joins the hint
                            line at meta size. */}
                        <p className="t-meta mt-1">
                            {at == null && barestCorner && (
                                <>
                                    {barestCorner.percent === 0
                                        ? "nothing "
                                        : `only ${barestCorner.percent}% `}
                                    {barestCorner.name}
                                    <span className="hidden sm:inline"> · </span>
                                    <br className="sm:hidden" />
                                </>
                            )}
                            <span className="hidden sm:inline">
                                point anywhere on the plot to see what lives there
                            </span>
                        </p>
                    </>
                )}
                </div>
            </figcaption>

        </figure>
    );
}
