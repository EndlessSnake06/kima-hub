// Layer 0 — the DEEP BACKGROUND starfield ("no background stars, no depth").
//
// The ambient terrain (ambientBaseline, 10k stars) hugs the disc, so the camera's
// surroundings read as empty black — none of the depth the kima social rig has. This
// layer adds a sparse spherical shell of dim, far stars AROUND and BEYOND the disc
// (radius 2x–5x the disc, thin band in y so the tilt stays readable), in near-neutral
// whites. It is pure decoration: never pickable, never labelled, exempt from every
// live-state effect (aIndex = aHighlight = -1, aSector = -1), and drawn FIRST so the
// disc, tracks, and overlays layer over it.
//
// Sizes deliberately run small (0.5–1.3): background stars must recede. Depth comes
// from the shell spanning 3x radial range behind the disc — parallax as the camera
// orbits does the rest.
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

export const BACKGROUND_COUNT = 2600;
const DISC_R = 60; // keep in step with GalaxyScene's DISC_RADIUS

export function buildBackgroundStars(): THREE.BufferGeometry {
    const rnd = makeRng(0xbeef);
    const pos = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);
    const phase = new Float32Array(BACKGROUND_COUNT);
    const twAmp = new Float32Array(BACKGROUND_COUNT);
    const spark = new Float32Array(BACKGROUND_COUNT);

    const rMin = DISC_R * 1.9;
    const rMax = DISC_R * 5.0;
    const yBand = DISC_R * 0.55;

    for (let i = 0; i < BACKGROUND_COUNT; i++) {
        // Spherical-ish shell: uniform direction, radius biased outward.
        const u = rnd() * 2 - 1;
        const theta = rnd() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        // Flatten y a touch so most stars sit near the galactic plane (depth
        // without the field reading as a bubble).
        const y = u * yBand * (0.35 + 0.65 * rnd());
        const r = rMin + (rMax - rMin) * Math.pow(rnd(), 0.7);
        pos[i * 3] = Math.cos(theta) * s * r;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = Math.sin(theta) * s * r;

        // Near-neutral whites with a whisper of the identity palette: a few
        // warm, a few cool, most plain. Brightness: a bright few over a faint
        // many — same dynamic-range rule as the disc field.
        const notable = rnd() < 0.08;
        const b = notable ? 0.55 + rnd() * 0.35 : 0.14 + rnd() * 0.2;
        const warm = rnd();
        const tintR = warm < 0.25 ? 1.0 : warm < 0.5 ? 0.92 : 1.0;
        const tintB = warm < 0.25 ? 0.9 : warm < 0.5 ? 1.0 : 0.95;
        colors[i * 3] = b * tintR;
        colors[i * 3 + 1] = b * 0.97;
        colors[i * 3 + 2] = b * tintB;
        sizes[i] = notable ? 1.0 + rnd() * 0.6 : 0.5 + rnd() * 0.5;
        phase[i] = rnd() * 6.283;
        twAmp[i] = 0.1 + rnd() * 0.18;
        spark[i] = 0;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTwAmp", new THREE.BufferAttribute(twAmp, 1));
    g.setAttribute("aSpark", new THREE.BufferAttribute(spark, 1));
    // Decorative-exempt attributes, same rule as the ambient disc: PRESENT and
    // -1, because a missing attribute reads as 0 and 0 is a real track's index.
    g.setAttribute("aSector", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    g.setAttribute("aIndex", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    g.setAttribute("aHighlight", new THREE.BufferAttribute(new Float32Array(BACKGROUND_COUNT).fill(-1), 1));
    return g;
}
