// Layer 0 — the DEEP BACKGROUND starfield ("other stars further back
// at varying distances and twinkling in various ways and colors to create
// depth", "the map itself some depth against a stark blackdrop").
//
// Restraint rules, learned the hard way this week:
//   - Stars are sampled in SCREEN SPACE off the overview camera: a random
//     point in the view (u,v in the fov-40 frustum, 16:9), then a depth
//     PAST the disc plane along that ray (t0 + 15..85, where t0 is where
//     the ray crosses y=0). Every star is therefore provably on-screen at
//     the overview angle, below the plane, and BEHIND the map — varying
//     distances, never in front of the field. (Two earlier attempts sampled
//     a spherical/annular shell around the scene; the geometry check showed
//     those stars sat 35-78° off-axis — invisible — or blurred out.)
//   - Star distance to the camera is 117-165, entirely inside the DOF crisp
//     band (uFocal 98 ± uDofRange 70 → crisp to 168), so NOTHING here
//     blooms into a bokeh blob; sizes stay tiny (0.5-1.65) and with
//     uSizeScale 150 render ~1.7-6px. Pinpoints. The rejected pass ran
//     uSizeScale 310 / uDofRange 260 — every far star was a soft blob.
//   - Depth bands also dim the far layers (0.5 → 0.34 → 0.22 brightness)
//     so the sky reads dark with depth, not lit evenly.
import * as THREE from "three";

function makeRng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1);
        t = (t ^ (t >>> 14)) >>> 0;
        return t / 4294967296;
    };
}

export const BACKGROUND_COUNT = 1100;

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
    const rnd = makeRng(0x5eed);
    const pos = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);
    const phase = new Float32Array(BACKGROUND_COUNT);
    const twAmp = new Float32Array(BACKGROUND_COUNT);
    const spark = new Float32Array(BACKGROUND_COUNT);

    // ── camera frame (matches the Canvas camera: pos [0,96,62], fov 40) ──
    const cam = { x: 0, y: 96, z: 62 };
    const fl = Math.hypot(cam.x, cam.y, cam.z);
    const forward = { x: -cam.x / fl, y: -cam.y / fl, z: -cam.z / fl };
    // right = forward × worldUp (worldUp = +y), then up = right × forward.
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

    // Depth bands (distance past the plane): the spread must be WIDE — that
    // is what "varying distances" means — so we center the DOF V-shape on
    // 180 with a 140 half-width: stars 110–300 from the camera sit within
    // blur ≤ 1.0, most around 0.4–0.6. Sizes are kept tiny (0.5–1.65) so
    // even fully-blurred stars stay 2–5px pinpoints — soft a touch, never
    // the 20px bokeh discs of the rejected pass.
    const BANDS = [
        { extraMin: 15, extraMax: 70, frac: 0.34, size: 1.3, bright: 0.55 },
        { extraMin: 60, extraMax: 110, frac: 0.33, size: 1.0, bright: 0.4 },
        { extraMin: 100, extraMax: 150, frac: 0.33, size: 0.8, bright: 0.3 },
    ];

    let i = 0;
    for (const band of BANDS) {
        const n = Math.floor(BACKGROUND_COUNT * band.frac);
        for (let k = 0; k < n && i < BACKGROUND_COUNT; k++, i++) {
            // Sample a ray through the view frustum and place the star on it,
            // past the disc plane. Ray must descend; the plane crossing must
            // sit within reach (t0 ≤ 210) so depths 110–300 stay coverable.
            let px = 0;
            let py = 0;
            let pz = 0;
            let ok = false;
            for (let tries = 0; tries < 16; tries++) {
                const u = rnd() * 2 - 1;
                const v = rnd() * 2 - 1;
                const dx = forward.x + right.x * u * tanH + up.x * v * tanV;
                const dy = forward.y + right.y * u * tanH + up.y * v * tanV;
                const dz = forward.z + right.z * u * tanH + up.z * v * tanV;
                const dl = Math.hypot(dx, dy, dz) || 1;
                const ndx = dx / dl;
                const ndy = dy / dl;
                const ndz = dz / dl;
                if (ndy >= -0.05) continue; // must descend below the plane
                const t0 = -cam.y / ndy; // distance to the y=0 crossing
                if (t0 < 30 || t0 > 210) continue;
                const d = Math.min(
                    t0 + band.extraMin + rnd() * (band.extraMax - band.extraMin),
                    300,
                );
                px = cam.x + ndx * d;
                py = cam.y + ndy * d;
                pz = cam.z + ndz * d;
                ok = true;
                break;
            }
            if (!ok) {
                sizes[i] = 0; // skipped → sub-pixel, invisible; buffers stay indexed
                continue;
            }

            pos[i * 3] = px;
            pos[i * 3 + 1] = py;
            pos[i * 3 + 2] = pz;

            const [tr, tg, tb] = pickTint(rnd);
            const notable = rnd() < 0.1;
            const b = band.bright * (notable ? 0.8 + rnd() * 0.4 : 0.35 + rnd() * 0.4);
            colors[i * 3] = tr * b;
            colors[i * 3 + 1] = tg * b;
            colors[i * 3 + 2] = tb * b;

            sizes[i] = band.size * (notable ? 1.15 + rnd() * 0.5 : 0.7 + rnd() * 0.45);

            // VARIED twinkle: wide spread of speed and depth — some stars
            // barely breathe, a few flicker. Never uniform.
            phase[i] = rnd() * 6.283;
            twAmp[i] = notable ? 0.1 + rnd() * 0.15 : 0.15 + rnd() * 0.35;
            spark[i] = rnd() < 0.035 ? 1 : 0;
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