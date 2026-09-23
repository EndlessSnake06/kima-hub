// Layer 0 — the DEEP BACKGROUND starfield ("other stars further back
// at varying distances and twinkling in various ways and colors to create
// depth" against a "stark blackdrop").
//
// How this differs from every previous attempt (do not regress these):
//   - Stars are sampled per-RAY through the view frustum: random (u,v) in
//     screen space, depth chosen ALONG that ray. Rays that hit the disc
//     place their star PAST the disc plane (so the field never obscures the
//     map); rays that miss it (sky above the horizon, sky past the rim)
//     place at a varied depth 100-240. Every star is therefore on-screen
//     AND either behind the map or in open sky — this replaces the earlier
//     generator whose "ray must descend / t0 in [30,210]" rejection logic
//     silently dropped 730/1100 candidates (the rest landed outside the
//     20-degree cone: "verified 858/900" was an OLDER version; re-checked
//     the shipped file in Node — only 370 in cone. That is why the sky
//     looked empty.)
//   - Brightness has REAL dynamic range: ~10% notable stars at 0.8-1.0,
//     the rest a long tail down to ~0.22 — a few bright anchors over a
//     faint many, which is what a real sky looks like. Previous versions
//     capped everything at 0.55 and read as flat static.
//   - All depths 100-260 stay inside the crisp DOF band (uFocal 180 /
//     uDofRange 140 → crisp to 320), so nothing blooms into bokeh.
//   - Sizes 1-3 world units → ps = aSize*uSizeScale(230)*dpr/depth ≈
//     2-4.5px. Pinpoints with visible variance, never discs.
import * as THREE from "three";

function makeRng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const BACKGROUND_COUNT = 2200;

// Real stellar color families, weighted like the sky: mostly warm whites
// and golds, some blue-whites, a violet tier for the nebular feel.
const STAR_TINTS: Array<[number, number, number, number]> = [
    // [r, g, b, weight]
    [0.72, 0.80, 1.0, 0.1], // blue-white giants
    [1.0, 0.98, 0.92, 0.3], // white
    [1.0, 0.9, 0.7, 0.25], // warm gold
    [1.0, 0.78, 0.55, 0.15], // amber
    [0.8, 0.7, 1.0, 0.12], // violet
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
    const rnd = makeRng(0x5eed);
    const pos = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);
    const phase = new Float32Array(BACKGROUND_COUNT);
    const twAmp = new Float32Array(BACKGROUND_COUNT);
    const spark = new Float32Array(BACKGROUND_COUNT);

    // Camera frame (matches the Canvas camera: pos [0,96,62], fov 40,
    // looking at the origin). We sample rays THROUGH the frustum, so the
    // star field covers the exact screen the overview shows — including
    // the sky ABOVE the horizon, which the previous generator skipped.
    const cam = { x: 0, y: 96, z: 62 };
    const fl = Math.hypot(cam.x, cam.y, cam.z);
    const forward = { x: -cam.x / fl, y: -cam.y / fl, z: -cam.z / fl };
    // Screen basis: right = forward × worldUp, up = right × forward.
    let right = {
        x: forward.y * 0 - forward.z * 1, //  forward × (0,1,0)
        y: forward.z * 0 - forward.x * 0,
        z: forward.x * 1 - forward.y * 0,
    };
    const rl = Math.hypot(right.x, right.y, right.z) || 1;
    right = { x: right.x / rl, y: right.y / rl, z: right.z / rl };
    const up = {
        x: right.y * forward.z - right.z * forward.y,
        y: right.z * forward.x - right.x * forward.z,
        z: right.x * forward.y - right.y * forward.x,
    };
    const tanV = Math.tan((20 * Math.PI) / 180); // fov 40 → half 20
    const tanH = Math.tan(Math.atan(tanV * (16 / 9))); // 16:9 landscape

    // Disc bounds for the "behind the map" rule: field occupies roughly
    // |x|,|z| <= 66 on the y=0 plane; a star must never sit between the
    // camera and the plane point its ray crosses inside that disc.
    const DISC_R = 66;

    for (let i = 0; i < BACKGROUND_COUNT; i++) {
        const u = rnd() * 2 - 1;
        const v = rnd() * 2 - 1;
        const dx = forward.x + right.x * u * tanH + up.x * v * tanV;
        const dy = forward.y + right.y * u * tanH + up.y * v * tanV;
        const dz = forward.z + right.z * u * tanH + up.z * v * tanV;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const ndx = dx / dl;
        const ndy = dy / dl;
        const ndz = dz / dl;

        // Depth along this ray: if the ray crosses the y=0 plane within
        // reach, place PAST the plane so stars sit behind the map; if the
        // ray points at open sky (or misses the disc), place anywhere in
        // the 100-240 band. EVERY candidate gets a position — no rejection
        // sampling, so the count is real.
        let depth: number;
        if (ndy < -0.05) {
            const t0 = -cam.y / ndy; // distance to the y=0 crossing
            const hitX = cam.x + ndx * t0;
            const hitZ = cam.z + ndz * t0;
            const hitsDisc = Math.hypot(hitX, hitZ) <= DISC_R;
            depth = hitsDisc ? t0 + 12 + rnd() * 90 : 100 + rnd() * 140;
        } else {
            depth = 100 + rnd() * 140; // sky above the horizon
        }

        pos[i * 3] = cam.x + ndx * depth;
        pos[i * 3 + 1] = cam.y + ndy * depth;
        pos[i * 3 + 2] = cam.z + ndz * depth;

        const [tr, tg, tb] = pickTint(rnd);
        const notable = rnd() < 0.1; // ~10% bright anchors, the rest faint
        const b = notable ? 0.8 + rnd() * 0.2 : 0.22 + rnd() * 0.3;
        colors[i * 3] = tr * b;
        colors[i * 3 + 1] = tg * b;
        colors[i * 3 + 2] = tb * b;

        // Size loosely coupled to brightness (brighter → bigger) with
        // independent jitter so a faint star can still be a big soft one.
        sizes[i] = notable ? 1.8 + rnd() * 1.2 : 0.7 + rnd() * 1.3;

        // VARIED twinkle: wide spread of speed and depth — some stars
        // barely breathe, a few flicker; ~3% carry a sharp sparkle.
        phase[i] = rnd() * 6.283;
        twAmp[i] = notable ? 0.1 + rnd() * 0.15 : 0.15 + rnd() * 0.35;
        spark[i] = rnd() < 0.03 ? 1 : 0;
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
    return g;
}
