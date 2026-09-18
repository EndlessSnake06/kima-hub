/**
 * vibeGalaxyLayout — the DECORATIVE ambient galaxy terrain (Layer 1).
 *
 * A faithful port of the approved people-preview rig
 * (`~/projects/kima/kima-people-preview/frontend/features/people/vibeGalaxyLayout.ts`):
 * a continuous synthetic 7-d mood manifold (dense core + soft spiral arms + a thin
 * third axis) → frozen PCA(3) → a spiral-wound disc with a small central void. Viewed
 * at the rig's low camera tilt with the event-horizon hole + tilt-shift DOF, this reads
 * as the approved "guitar-pick" galaxy (approved-galaxy3d.png) — a soft, fine field with
 * a bright accretion arc curving under the black hole. Colour = deterministic OKLab
 * blend of each point's vibe vector (the rig's identity palette).
 *
 * HONESTY: this is decorative terrain — the vibe-space MAP, NOT users. No identities are
 * attached to any point; it is never counted, pickable, or labelled as a person. The
 * REAL people are a separate bright overlay (peopleField.ts / Layer 2). Trimmed from the
 * rig port: the synthetic YOU / match / near-you logic — Layer 2 (real usePeople) owns
 * match, and it stays sampled — real per-user coords are deliberately not used here. This baseline stays decorative.
 */

const MOOD_KEYS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;
type MoodKey = (typeof MOOD_KEYS)[number];
const D = MOOD_KEYS.length;

// KIMA identity palette (OKLCH, matter-not-neon) — one anchor per mood dim.
const ANCHOR: Record<MoodKey, { L: number; C: number; H: number }> = {
    moodHappy: { L: 0.72, C: 0.09, H: 62 },
    moodSad: { L: 0.52, C: 0.10, H: 300 },
    moodRelaxed: { L: 0.64, C: 0.08, H: 178 },
    moodAggressive: { L: 0.56, C: 0.105, H: 28 },
    moodParty: { L: 0.62, C: 0.11, H: 348 },
    moodAcoustic: { L: 0.68, C: 0.07, H: 78 },
    moodElectronic: { L: 0.58, C: 0.10, H: 318 },
};
const ANCHOR_LAB = MOOD_KEYS.map((k) => {
    const v = ANCHOR[k], h = (v.H * Math.PI) / 180;
    return { L: v.L, a: v.C * Math.cos(h), b: v.C * Math.sin(h) };
});

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gauss(rnd: () => number): number {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalize(v: number[]): number[] {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
}
function matVec(m: number[][], v: number[]): number[] {
    return m.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}
/** Top-k eigenvectors of a symmetric D×D matrix (power iteration + deflation). */
function topEigenvectors(cov: number[][], k: number): number[][] {
    const out: number[][] = [];
    let m = cov.map((r) => r.slice());
    for (let c = 0; c < k; c++) {
        let v = normalize(Array.from({ length: D }, (_, i) => 1 + (i === c ? 1 : 0)));
        let lambda = 0;
        for (let it = 0; it < 200; it++) {
            const mv = matVec(m, v);
            const nv = normalize(mv);
            lambda = mv.reduce((s, x, i) => s + x * nv[i], 0);
            let diff = 0;
            for (let i = 0; i < D; i++) diff += Math.abs(nv[i] - v[i]);
            v = nv;
            if (diff < 1e-12) break;
        }
        out.push(v);
        m = m.map((row, i) => row.map((x, j) => x - lambda * v[i] * v[j]));
    }
    return out;
}
function l2normalize(v: number[]): number[] {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n);
    return n > 0 ? v.map((x) => x / n) : v.slice();
}

// ── identity colour (deterministic OKLab blend of the vibe vector) ──────────
function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return lin.map((c) => {
        c = Math.max(0, Math.min(1, c));
        return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }) as [number, number, number];
}
function vibeColor(vec: number[], lift = 1): [number, number, number] {
    let L = 0, a = 0, b = 0, wt = 0;
    for (let i = 0; i < D; i++) {
        const w = Math.max(0, vec[i]) ** 3;
        if (w <= 0) continue;
        L += ANCHOR_LAB[i].L * w; a += ANCHOR_LAB[i].a * w; b += ANCHOR_LAB[i].b * w; wt += w;
    }
    if (wt === 0) return [0.6, 0.6, 0.6];
    L = (L / wt) * lift; a /= wt; b /= wt;
    const C = Math.hypot(a, b);
    if (C > 0.17) { a *= 0.17 / C; b *= 0.17 / C; }
    return oklabToRgb(L, a, b);
}

// ── the synthetic manifold (a real galaxy's latent structure) ───────────────
const ARMS = 3;
function synthVectors(count: number, seed: number): number[][] {
    const rnd = mulberry32(seed);
    const loadRnd = mulberry32(seed ^ 0x9e3779b9);
    const load: number[][] = Array.from({ length: D }, () => [gauss(loadRnd), gauss(loadRnd), gauss(loadRnd)]);
    const vecs: number[][] = [];
    for (let i = 0; i < count; i++) {
        const rad = Math.pow(rnd(), 2.3) * 3.2;
        const arm = (Math.floor(rnd() * ARMS) / ARMS) * Math.PI * 2;
        const ang = arm + rad * 4.0 + 1.3 / (rad + 0.32) + gauss(rnd) * (0.14 + 0.34 / (rad + 0.5));
        const l1 = Math.cos(ang) * rad;
        const l2 = Math.sin(ang) * rad;
        const l3 = gauss(rnd) * 0.5;
        const raw = load.map((row) => row[0] * l1 + row[1] * l2 + row[2] * l3);
        const exp = raw.map((x) => Math.exp(0.7 * x));
        const sum = exp.reduce((s, x) => s + x, 0) || 1;
        vecs.push(l2normalize(exp.map((x) => x / sum)));
    }
    return vecs;
}

export interface VibeGalaxy {
    count: number;
    pos: Float32Array; // xyz per point
    color: Float32Array; // rgb per point (identity hue, pre-brightness)
}

export interface VibeGalaxyOpts {
    count: number;
    seed?: number;
    radius?: number;
    thickness?: number;
}

export function buildVibeGalaxy(opts: VibeGalaxyOpts): VibeGalaxy {
    const N = opts.count;
    const seed = opts.seed ?? 0x51a2;
    const R = opts.radius ?? 60;
    const THICK = opts.thickness ?? 4;
    const HOLE = R * 0.08; // small, subtle void — the arms wind into it; the black hole sits here

    const vectors = synthVectors(N, seed);

    const mean = new Array(D).fill(0);
    for (const v of vectors) for (let i = 0; i < D; i++) mean[i] += v[i] / N;
    const cov: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
    for (const v of vectors) for (let i = 0; i < D; i++) {
        const di = v[i] - mean[i];
        for (let j = 0; j < D; j++) cov[i][j] += (di * (v[j] - mean[j])) / N;
    }
    const basis = topEigenvectors(cov, 3);

    const c1: number[] = [], c2: number[] = [], c3: number[] = [];
    for (const v of vectors) {
        const d = v.map((x, i) => x - mean[i]);
        c1.push(basis[0].reduce((s, e, i) => s + e * d[i], 0));
        c2.push(basis[1].reduce((s, e, i) => s + e * d[i], 0));
        c3.push(basis[2].reduce((s, e, i) => s + e * d[i], 0));
    }
    const rr = c1.map((x, i) => Math.hypot(x, c2[i]));
    const sorted = [...rr].sort((a, b) => a - b);
    const rScale = (sorted[Math.floor(0.95 * (N - 1))] || 1) / R;
    const c3abs = c3.map(Math.abs).sort((a, b) => a - b);
    const yScale = THICK / (c3abs[Math.floor(0.95 * (N - 1))] || 1);

    const pos = new Float32Array(N * 3);
    const color = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
        const r = HOLE + (rr[i] / rScale) * (1 - HOLE / R);
        const theta = Math.atan2(c2[i], c1[i]);
        pos[i * 3] = Math.cos(theta) * r;
        pos[i * 3 + 1] = c3[i] * yScale;
        pos[i * 3 + 2] = Math.sin(theta) * r;
        const col = vibeColor(vectors[i]);
        color[i * 3] = col[0]; color[i * 3 + 1] = col[1]; color[i * 3 + 2] = col[2];
    }

    return { count: N, pos, color };
}
