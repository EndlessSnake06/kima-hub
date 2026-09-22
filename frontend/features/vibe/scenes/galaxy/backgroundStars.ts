// Layer 0 — the DEEP BACKGROUND starfield ("look BEYOND the galaxy —
// other stars further back at varying distances, twinkling in various ways and
// colors, to create depth").
//
// The library IS the map; this layer is everything BEHIND it: a far shell of
// stars in varied real star colors (blue-white, white, warm gold, amber, and a
// violet tier), at several distance bands so the camera's parallax separates
// them, each twinkling on its own frequency/phase (varied ways), with rare
// color-shifted sparkles. Pure decoration: never pickable, exempt from every
// live-state effect (aIndex = aHighlight = aSector = -1, the PRESENT-and--1
// rule — a missing attribute reads as 0, which is a real track's index).
import * as THREE from "three";

function makeRng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t ^ (t >>> 14)) >>> 0;
        return t / 4294967296;
    };
}

export const BACKGROUND_COUNT = 1800;
const DISC_R = 60; // keep in step with GalaxyScene's DISC_RADIUS

// Real stellar color families, weighted like the sky: few blue-whites, many
// warm whites/golds, a violet tier for the nebular feel.
const STAR_TINTS: Array<[number, number, number, number]> = [
    // [r, g, b, weight]
    [0.72, 0.80, 1.0, 0.10], // blue-white giants
    [1.0, 0.98, 0.92, 0.30], // white
    [1.0, 0.90, 0.70, 0.25], // warm gold
    [1.0, 0.78, 0.55, 0.15], // amber
    [0.80, 0.70, 1.0, 0.12], // violet
    [0.95, 0.88, 1.0, 0.08], // pale lavender
];

function pickTint(rnd: () => number): [number, number, number] {
    let roll = rnd();
    for (const [r, g, b, w] of STAR_TINTS) {
        roll -= w;
        if (roll <= 0) return [r, g, b];
    }
    return [1, 1, 1];
}

export function buildBackgroundStars(): THREE.BufferGeometry {
    const rnd = makeRng(0xbeef);
    const pos = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);
    const phase = new Float32Array(BACKGROUND_COUNT);
    const twAmp = new Float32Array(BACKGROUND_COUNT);
    const spark = new Float32Array(BACKGROUND_COUNT);

    // Three distance bands behind the disc: nearer shell is sparser but
    // brighter/larger; far shells denser but fainter. Parallax between the
    // bands as the camera drifts is what sells the depth.
    const BANDS = [
        { rMin: DISC_R * 1.8, rMax: DISC_R * 2.6, frac: 0.22, size: 1.15, bright: 0.85 },
        { rMin: DISC_R * 2.6, rMax: DISC_R * 3.8, frac: 0.33, size: 0.85, bright: 0.6 },
        { rMin: DISC_R * 3.8, rMax: DISC_R * 5.5, frac: 0.45, size: 0.62, bright: 0.42 },
    ];

    let i = 0;
    for (const band of BANDS) {
        const n = Math.floor(BACKGROUND_COUNT * band.frac);
        for (let k = 0; k < n && i < BACKGROUND_COUNT; k++, i++) {
            // Uniform direction on the sphere, flattened toward the plane so
            // the band reads as a galaxy's outskirts, not a bubble.
            const u = rnd() * 2 - 1;
            const theta = rnd() * Math.PI * 2;
            const s = Math.sqrt(1 - u * u);
            const r = band.rMin + (band.rMax - band.rMin) * Math.pow(rnd(), 0.7);
            pos[i * 3] = Math.cos(theta) * s * r;
            pos[i * 3 + 1] = u * DISC_R * 0.5 * (0.3 + 0.7 * rnd());
            pos[i * 3 + 2] = Math.sin(theta) * s * r;

            const [tr, tg, tb] = pickTint(rnd);
            const notable = rnd() < 0.1;
            const b = band.bright * (notable ? 0.8 + rnd() * 0.4 : 0.35 + rnd() * 0.4);
            colors[i * 3] = tr * b;
            colors[i * 3 + 1] = tg * b;
            colors[i * 3 + 2] = tb * b;

            sizes[i] = band.size * (notable ? 1.3 + rnd() * 0.7 : 0.7 + rnd() * 0.5);

            // VARIED twinkle: wide spread of speed and depth — some stars
            // barely breathe, a few flicker sharply. Phase spread full circle.
            phase[i] = rnd() * 6.283;
            twAmp[i] = notable ? 0.08 + rnd() * 0.12 : 0.15 + rnd() * 0.4;
            // rare sharp sparkles, some color-popping via the tint already in
            // aColor (the fragment adds the sparkle term on top).
            spark[i] = rnd() < 0.045 ? 1 : 0;
        }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTwAmp", new THREE.BufferAttribute(twAmp, 1));
    g.setAttribute("aSpark", new THREE.BufferAttribute(spark, 1));
    g.setAttribute("aSector", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    g.setAttribute("aIndex", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    g.setAttribute("aHighlight", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    return g;
}
