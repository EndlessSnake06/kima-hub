// trackGalaxyLayout — the user's OWN music, in THEIR OWN vector space.
//
// reference]. Use it as a reference. The users' embedded music, IN their
// vector space just like the old map was, just cleaner."
//
// Therefore — and this is the difference from every previous attempt:
//   - The field IS the data. No synthetic spiral, no guitar-pick layout, no
//     decorative terrain underneath. Nothing here invents points; every
//     position is a real track's real UMAP (x, y).
//   - Placement is a DIRECT affine map of UMAP space: x → world x, y →
//     world z, scaled to span the disc the camera frames. The previous code
//     re-mapped positions through polar coordinates (theta + sqrt radius),
//     which bent the true layout into the reference's shape — that was the
//     "you ported it" tell. Nothing is rearranged now: neighbours in UMAP
//     stay neighbours, whatever shape that makes.
//   - Vertical (y) comes from the third principal component of the 7-d mood
//     vectors — a real height, ±(disc radius × 0.06).
//   - Colour = the reference's OKLab mood-anchor blend fed by each track's
//     REAL `moods` record (chroma capped at 0.17 — matter, not neon).
//
// Deterministic per dataset. We do NOT re-run UMAP; the UMAP x,y come from
// /api/vibe/map.

// ── Mood keys — EXACT match to the backend's 7-key moods record and the rig. ──
const MOOD_KEYS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;
type MoodKey = (typeof MOOD_KEYS)[number];
const D = MOOD_KEYS.length; // 7

// ── KIMA identity palette (OKLCH, matter-not-neon) — one anchor per mood dim. ──
// Exact copy from the reference's vibeGalaxyLayout.ts.
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

// ── Linear algebra helpers (ported from the reference, unchanged). ────────────
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

// ── OKLab → sRGB (exact copy from the reference). ─────────────────────────────
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
 * Cubic-weight the mood anchors, normalise by total weight, cap chroma at
 * 0.17 (matter-not-neon). `lift` scales L to brighten/dim.
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
    pos: Float32Array;   // xyz per point — x/z = real UMAP, y = mood PCA height
    color: Float32Array; // rgb per point (OKLab mood colour, pre-brightness)
}

export interface TrackGalaxyOpts {
    count?: number;      // unused; kept for call-site parity
    radius?: number;     // scene radius in world units (default 60)
    thickness?: number;  // unused; vertical is ±(radius * 0.06) from PCA
}

/**
 * Build the field from REAL track data. `tracks` is the /api/vibe/map set:
 * each has `x`, `y` (UMAP coords) and `moods` (7 keys). Positions are a
 * direct affine map of UMAP space — no polar re-arrangement, no layout
 * imposed from the reference.
 */
export function buildTrackGalaxy(
    opts: TrackGalaxyOpts,
    tracks: Array<{ x: number; y: number; moods: Record<string, number> }>,
): TrackGalaxy {
    const N = tracks.length;
    if (N === 0) {
        return { count: 0, pos: new Float32Array(0), color: new Float32Array(0) };
    }

    const R = opts.radius ?? 60;
    // Card spec: vertical semi-thickness = ±(scene radius × 0.06).
    const VERT_SEMI = R * 0.06;

    // 1. Real 7-d mood vectors.
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

    // 2. 7-d mood covariance (deterministic — no RNG).
    const mean = new Array(D).fill(0);
    for (const v of moods) for (let i = 0; i < D; i++) mean[i] += v[i] / N;
    const cov: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
    for (const v of moods) for (let i = 0; i < D; i++) {
        const di = v[i] - mean[i];
        for (let j = 0; j < D; j++) cov[i][j] += (di * (v[j] - mean[j])) / N;
    }
    const basis = topEigenvectors(cov, 3);

    // 3. Project each track onto the third eigenvector (height only — the
    //    first two axes ARE the UMAP plane; we never touch them).
    const c3: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
        const d = moods[i].map((x, j) => x - mean[j]);
        c3[i] = basis[2].reduce((s, e, j) => s + e * d[j], 0);
    }

    // 4. Scale height to ±VERT_SEMI by 95th percentile (like the rig's yScale).
    const c3abs = c3.map(Math.abs).sort((a, b) => a - b);
    const c3max = c3abs[Math.floor(0.95 * (N - 1))] || 1;
    const zScale = VERT_SEMI / c3max;

    // 5. DIRECT affine placement: center UMAP bounds on 0, scale so the
    //    full extent spans 2R in each axis. Neighbour relationships are
    //    preserved exactly — this is their space, not the reference's shape.
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
    const span = R * 0.9; // UMAP cloud spans ±(0.9 R) per axis, so the
    //      whole field fits the same overview frame the reference camera
    //      was tuned for (dist ~113 from centre).

    // 6. Build position + color arrays.
    const pos = new Float32Array(N * 3);
    const color = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const t = tracks[i];
        pos[i * 3]     = ((t.x - umapCenterX) / umapHalfX) * span; // real UMAP x
        pos[i * 3 + 1] = c3[i] * zScale;                            // mood PCA height
        pos[i * 3 + 2] = ((t.y - umapCenterY) / umapHalfY) * span; // real UMAP y

        const col = vibeColor(moods[i]);
        color[i * 3]     = col[0];
        color[i * 3 + 1] = col[1];
        color[i * 3 + 2] = col[2];
    }

    return { count: N, pos, color };
}
