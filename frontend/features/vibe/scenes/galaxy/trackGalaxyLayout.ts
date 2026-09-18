/**
 * trackGalaxyLayout — the DECORATIVE-FREE galaxy terrain built from REAL data.
 *
 * A faithful port of the approved rig's `vibeGalaxyLayout` (kima-hub-unified
 * frontend/features/social/galaxy/vibeGalaxyLayout.ts) with the Layer 1 data
 * source swapped:
 *   - RIG: synthetic spiral vectors (synthVectors) → a "guitar-pick" disc.
 *   - US:  real UMAP x,y (normalized 0→1 from /api/vibe/map) for the disc plane
 *           + a deterministic vertical from the 7-d mood covariance PCA.
 *
 * Layout (matches the rig's axis convention: x/z = disc plane, y = vertical):
 *   - x = UMAP x  → disc plane (centered, scaled to disc radius)
 *   - z = UMAP y  → disc plane (centered, scaled to disc radius)
 *   - y = third PCA component of the 7-d mood covariance, scaled to
 *     ±(discRadius * 0.06) for the real mood vector.
 *
 * Colour = the rig's vibeColor() OKLab mood-anchor blend (vibeGalaxyLayout.ts
 * ANCHOR palette), fed by each track's REAL `moods` record, chroma capped at
 * 0.17 (matter-not-neon).
 *
 * PCA is computed ONCE per dataset with a deterministic seed → stable z.
 * We do NOT re-run UMAP; the UMAP x,y come from the API.
 */

// ── Mood keys — EXACT match to the backend's 7-key moods record and the rig. ──
const MOOD_KEYS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;
type MoodKey = (typeof MOOD_KEYS)[number];
const D = MOOD_KEYS.length; // 7

// ── KIMA identity palette (OKLCH, matter-not-neon) — one anchor per mood dim. ──
// Exact copy from vibeGalaxyLayout.ts (the rig's approved palette).
const ANCHOR: Record<MoodKey, { L: number; C: number; H: number }> = {
    moodHappy:      { L: 0.72, C: 0.09,  H: 62  },
    moodSad:        { L: 0.52, C: 0.10,  H: 300 },
    moodRelaxed:    { L: 0.64, C: 0.08,  H: 178 },
    moodAggressive: { L: 0.56, C: 0.105, H: 28  },
    moodParty:      { L: 0.62, C: 0.11,  H: 348 },
    moodAcoustic:   { L: 0.68, C: 0.07,  H: 78  },
    moodElectronic: { L: 0.58, C: 0.10,  H: 318 },
};
const ANCHOR_LAB = MOOD_KEYS.map((k) => {
    const v = ANCHOR[k];
    const h = (v.H * Math.PI) / 180;
    return { L: v.L, a: v.C * Math.cos(h), b: v.C * Math.sin(h) };
});

// ── Linear algebra helpers (ported from vibeGalaxyLayout.ts, unchanged). ──────
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

// ── OKLab → sRGB (exact copy from vibeGalaxyLayout.ts). ───────────────────────
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

/**
 * vibeColor — deterministic OKLab blend of a 7-d mood vector.
 *
 * The rig's identity colour (vibeGalaxyLayout.ts): cubic-weight the mood
 * anchors, normalise by total weight, cap chroma at 0.17 (matter-not-neon).
 * `lift` scales L to brighten/dim (kept for possible future use; default 1).
 */
export function vibeColor(vec: number[], lift = 1): [number, number, number] {
    let L = 0, a = 0, b = 0, wt = 0;
    for (let i = 0; i < D; i++) {
        const w = Math.max(0, vec[i]) ** 3;
        if (w <= 0) continue;
        L += ANCHOR_LAB[i].L * w;
        a += ANCHOR_LAB[i].a * w;
        b += ANCHOR_LAB[i].b * w;
        wt += w;
    }
    if (wt === 0) return [0.6, 0.6, 0.6];
    L = (L / wt) * lift;
    a /= wt;
    b /= wt;
    const C = Math.hypot(a, b);
    if (C > 0.17) {
        a *= 0.17 / C;
        b *= 0.17 / C;
    }
    return oklabToRgb(L, a, b);
}

// ── Public interface ──────────────────────────────────────────────────────────
export interface TrackGalaxy {
    count: number;
    pos: Float32Array;   // xyz per point — x/z = UMAP disc, y = mood PCA vertical
    color: Float32Array; // rgb per point (OKLab identity hue, pre-brightness)
}

export interface TrackGalaxyOpts {
    count: number;
    seed?: number;       // deterministic PCA seed (not used by real data, kept for signature parity)
    radius?: number;     // disc radius in world units (default 60, matches rig)
    thickness?: number;  // deprecated — spec uses radius*0.06
}

/**
 * Build the galaxy from REAL track data.
 *
 * `tracks` must be the /api/vibe/map tracks (MapTrack): each has `x`, `y`
 * (UMAP normalized 0→1) and `moods` (7 keys). The layout is deterministic
 * per dataset (only the data changes between fetches).
 */
export function buildTrackGalaxy(opts: TrackGalaxyOpts, tracks: Array<{ x: number; y: number; moods: Record<string, number> }>): TrackGalaxy {
    const N = opts.count;
    if (N === 0) {
        return { count: 0, pos: new Float32Array(0), color: new Float32Array(0) };
    }

    const R = opts.radius ?? 60;
    // Card spec: vertical semi-thickness = ±(discRadius * 0.06).
    const VERT_SEMI = R * 0.06;

    // 1. Build the 7-d mood vectors from real data.
    const moods: number[][] = new Array(N);
    for (let i = 0; i < N; i++) {
        const m = tracks[i].moods;
        const vec: number[] = new Array(D);
        for (let j = 0; j < D; j++) {
            const k = MOOD_KEYS[j];
            vec[j] = (m && k in m) ? (m[k] as number) : 0;
        }
        moods[i] = vec;
    }

    // 2. Compute the 7-d mood covariance (deterministic — no RNG needed).
    const mean = new Array(D).fill(0);
    for (const v of moods) for (let i = 0; i < D; i++) mean[i] += v[i] / N;
    const cov: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
    for (const v of moods) for (let i = 0; i < D; i++) {
        const di = v[i] - mean[i];
        for (let j = 0; j < D; j++) cov[i][j] += (di * (v[j] - mean[j])) / N;
    }
    const basis = topEigenvectors(cov, 3); // 3 eigenvectors of the 7×7 matrix

    // 3. Project each track onto the 3 eigenvectors.
    const c1: number[] = new Array(N);
    const c2: number[] = new Array(N);
    const c3: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
        const d = moods[i].map((x, j) => x - mean[j]);
        c1[i] = basis[0].reduce((s, e, j) => s + e * d[j], 0);
        c2[i] = basis[1].reduce((s, e, j) => s + e * d[j], 0);
        c3[i] = basis[2].reduce((s, e, j) => s + e * d[j], 0);
    }

    // 4. Scale the third component to ±VERT_SEMI (95th-percentile, like the rig's yScale).
    const c3abs = c3.map(Math.abs).sort((a, b) => a - b);
    const c3max = c3abs[Math.floor(0.95 * (N - 1))] || 1;
    const zScale = VERT_SEMI / c3max;

    // 5. Map UMAP (x, y) → disc plane (x, z). UMAP is normalized 0→1;
    //    center around 0.5 and scale to disc radius.
    let umapMinX = Infinity, umapMaxX = -Infinity, umapMinY = Infinity, umapMaxY = -Infinity;
    for (const t of tracks) {
        if (t.x < umapMinX) umapMinX = t.x;
        if (t.x > umapMaxX) umapMaxX = t.x;
        if (t.y < umapMinY) umapMinY = t.y;
        if (t.y > umapMaxY) umapMaxY = t.y;
    }
    const umapCenterX = (umapMinX + umapMaxX) / 2;
    const umapCenterY = (umapMinY + umapMaxY) / 2;
    const umapHalfX = (umapMaxX - umapMinX) / 2 || 0.5;
    const umapHalfY = (umapMaxY - umapMinY) / 2 || 0.5;

    // 6. Build position + color arrays.
    const pos = new Float32Array(N * 3);
    const color = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const t = tracks[i];
        const vec = moods[i];

        // UMAP → disc (x, z). Polar mapping keeps the centre readable and
        // wraps the range smoothly (matches the rig's polar disc layout).
        const nx = (t.x - umapCenterX) / umapHalfX; // [-1, 1] (roughly)
        const ny = (t.y - umapCenterY) / umapHalfY;
        const r = Math.min(1, Math.hypot(nx, ny));
        const theta = Math.atan2(ny, nx);
        const discR = r * R;
        const fx = Math.cos(theta) * discR;
        const fz = Math.sin(theta) * discR;

        // PCA third component → vertical (y), scaled to ±VERT_SEMI.
        const fy = c3[i] * zScale;

        pos[i * 3]     = fx;
        pos[i * 3 + 1] = fy;
        pos[i * 3 + 2] = fz;

        // OKLab mood colour (chroma-capped).
        const col = vibeColor(vec);
        color[i * 3]     = col[0];
        color[i * 3 + 1] = col[1];
        color[i * 3 + 2] = col[2];
    }

    return { count: N, pos, color };
}
