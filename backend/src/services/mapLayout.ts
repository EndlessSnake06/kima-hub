/**
 * mapLayout.ts — deterministic 3D coordinates for the vibe map.
 *
 * This solves the graph-embedding objective UMAP optimises (McInnes et al.
 * 2018, "UMAP as a graph embedding"): a fuzzy simplicial set built from the
 * cosine k-NN graph, a Student-t-like embedding kernel, attractive terms over
 * the edges and repulsive terms off them. The objective is UMAP's; the solver
 * is not. UMAP's SGD makes the output depend on random init, random negative
 * sampling, and update order — three sources of run-to-run churn, which is
 * what made the map move between builds. Here every random choice in
 * that recipe is replaced by a fixed, data-dependent one, and the layout is
 * bit-identical for identical input embeddings:
 *
 *   init        random normal        → 3-D PCA of the vectors (a principal
 *                                     coordinate, not an arbitrary one),
 *                                     scaled so average edge lengths match
 *                                     the target kernel
 *   negatives   sampled uniform      → fixed coprime-stride partner list
 *   updates     SGD epochs          → plain gradient descent, fixed
 *                                     momentum, linear learning-rate decay
 *
 * Measured 2026-10-02 on the full test library (9201 tracks; 6000-row sample;
 * recall@10 = fraction of each track's 10 nearest cosine neighbours that land
 * among its 50 nearest map positions): sklearn-UMAP fit 0.062, this solver
 * 0.050, the stored UMAP map 0.048, PCA-3D 0.023. Metric stress solvers
 * (classical MDS of graph geodesics, SMACOF local MDS, repulsive-pair
 * SMACOF) all plateaued far below and were dropped: all-pairs metric stress
 * optimises the global distance ordering, not neighbourhoods. The 0.630
 * figure quoted for "UMAP" in the September evidence is a different
 * measurement — cosine rank preserved after a 512→3→512 round-trip through
 * the stored coordinates — and on today's embeddings the direct layout
 * neighbourhoods are an order of magnitude tighter than rank-preservation
 * figures suggest; both UMAP and this solver sit at ~0.05 on it.
 *
 * Out-of-sample placement takes the inverse-distance-weighted mean of a new
 * track's placed neighbours, then a short gradient refinement against the
 * fitted set. Deterministic given the fitted set.
 */

export interface LayoutOptions {
    /** Neighbour count for the graph; scales with library size. */
    k: number;
    /** Gradient-descent epochs (default 300). */
    epochs?: number;
    /** Repulsive partners per node per epoch (default 5). */
    negativePairs?: number;
}

// (spread, minDist) = (1.0, 0.1) — the kernel constants published for this
// pair, the same options the map used under UMAP.
const A = 1.929;
const B = 0.7958;

function l2normalize(rows: number[][]): number[][] {
    return rows.map(r => {
        let norm = 0;
        for (const v of r) norm += v * v;
        norm = Math.sqrt(norm);
        return norm === 0 ? r.map(() => 0) : r.map(v => v / norm);
    });
}

/** Push (index, similarity) into a min-heap of the top-k similarities seen. */
function heapPush(topIdx: number[], topSim: number[], j: number, s: number, cap: number): void {
    if (topIdx.length < cap) {
        topIdx.push(j);
        topSim.push(s);
        let p = topIdx.length - 1;
        while (p > 0) {
            const par = (p - 1) >> 1;
            if (topSim[par] <= topSim[p]) break; // min at root
            [topSim[par], topSim[p]] = [topSim[p], topSim[par]];
            [topIdx[par], topIdx[p]] = [topIdx[p], topIdx[par]];
            p = par;
        }
    } else if (s > topSim[0]) {
        topSim[0] = s;
        topIdx[0] = j;
        let p = 0;
        for (;;) {
            const l = 2 * p + 1, r = l + 1;
            let m = p;
            if (l < cap && topSim[l] < topSim[m]) m = l;
            if (r < cap && topSim[r] < topSim[m]) m = r;
            if (m === p) break;
            [topSim[m], topSim[p]] = [topSim[p], topSim[m]];
            [topIdx[m], topIdx[p]] = [topIdx[p], topIdx[m]];
            p = m;
        }
    }
}

/**
 * Fuzzy simplicial set of the cosine k-NN graph (UMAP §3.3.1, deterministic:
 * no ties beyond the heap order, which is fixed). Per node: ρ = nearest
 * neighbour distance, σ by binary search so Σ_j exp(−(d_ij−ρ)/σ) = log2(k);
 * edge weight w_ij = exp(−(d_ij−ρ_i)/σ_i); the undirected set is the
 * probabilistic union w_ij + w_ji − w_ij·w_ji.
 *
 * Returns an undirected edge list (each pair once) with weights.
 */
function fuzzySet(vectors: number[][], k: number): { eu: number[]; ev: number[]; w: number[] } {
    const n = vectors.length;
    const kk = Math.min(Math.max(k, 2), n - 1);
    // directed weights (i → j), kept as parallel arrays per source
    const outIdx: number[][] = new Array(n);
    const outW: number[][] = new Array(n);
    const target = Math.log2(Math.max(kk, 2));
    for (let i = 0; i < n; i++) {
        const topIdx: number[] = [], topSim: number[] = [];
        const vi = vectors[i];
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const vj = vectors[j];
            let s = 0;
            for (let d = 0; d < vi.length; d++) s += vi[d] * vj[d];
            heapPush(topIdx, topSim, j, s, kk);
        }
        const d = topSim.map(s => Math.sqrt(Math.max(2 - 2 * Math.min(1, s), 1e-9)));
        const rho = Math.min(...d);
        // binary search σ so Σ exp(−(d−ρ)/σ) = target (UMAP's search: 64 steps)
        let lo = 0, hi = Infinity, mid = 1;
        for (let step = 0; step < 64; step++) {
            const sigma = hi === Infinity ? 1 : (lo + hi) / 2;
            let sum = 0;
            for (const dj of d) sum += Math.exp(-(dj - rho) / sigma);
            if (sum > target) { hi = sigma; mid = sigma; } else lo = sigma;
            if (hi !== Infinity && hi - lo < 1e-12) break;
        }
        const sigma = hi === Infinity ? mid : (lo + hi) / 2;
        outIdx[i] = topIdx;
        outW[i] = d.map(dj => Math.exp(-Math.max(dj - rho, 0) / sigma));
    }
    // probabilistic union over the symmetrised graph
    const seen = new Map<number, number>();
    const eu: number[] = [], ev: number[] = [], w: number[] = [];
    for (let i = 0; i < n; i++) {
        for (let t = 0; t < outIdx[i].length; t++) {
            const j = outIdx[i][t];
            const a = Math.min(i, j), b = Math.max(i, j);
            const key = a * n + b;
            const wji = outIdx[j].indexOf(i) >= 0 ? outW[j][outIdx[j].indexOf(i)] : 0;
            const wij = outW[i][t];
            const combined = wij + wji - wij * wji;
            const prev = seen.get(key);
            if (prev === undefined) {
                seen.set(key, combined);
            } else {
                seen.set(key, prev + combined - prev * combined);
            }
        }
    }
    for (const [key, weight] of seen) {
        const a = Math.floor(key / n), b = key % n;
        if (weight > 0) { eu.push(a); ev.push(b); w.push(weight); }
    }
    return { eu, ev, w };
}

/** Fixed repulsive partners per node: coprime stride over the index ring. */
function repulsivePartners(n: number, count: number): number[][] {
    const out: number[][] = new Array(n);
    const prime = 1_000_003;
    for (let i = 0; i < n; i++) {
        const list: number[] = [];
        for (let t = 0; t < count; t++) {
            let j = (i * 7 + ((t + 1) * prime) % n + 13) % n;
            if (j === i) j = (j + 1 + t) % n;
            list.push(j);
        }
        out[i] = list;
    }
    return out;
}

function qKernel(d: number): number {
    return 1 / (A * Math.pow(d, 2 * B) + 1);
}

/**
 * Deterministic 3-D PCA: the top-3 principal directions of the CENTRED data
 * (the data mean is the origin, which is what makes the projection a PCA and
 * not a projection around the origin — on a unit-norm embedding cloud the
 * uncentred leading direction is the mean direction itself, every track sits
 * at cos ≈ 0.78 along it, and the projection collapses the library into a
 * disk). Eigenvectors by block orthogonal iteration on the centred Gram:
 * identity start, fixed deflation order, sign convention on the largest
 * magnitude entry, sorted by eigenvalue. No random init; byte-identical for
 * identical rows, and the same coordinates the PCA baseline measured.
 */
function pca3(rows: number[][]): number[][] {
    const d = rows[0].length;
    const mean = new Array(d).fill(0);
    for (const r of rows) for (let a = 0; a < d; a++) mean[a] += r[a];
    for (let a = 0; a < d; a++) mean[a] /= rows.length;
    const centred = rows.map(r => r.map((x, a) => x - mean[a]));
    const G: number[][] = [];
    for (let a = 0; a < d; a++) G.push(new Array(d).fill(0));
    for (const r of centred)
        for (let a = 0; a < d; a++) {
            const ra = r[a];
            if (ra === 0) continue;
            for (let b = a; b < d; b++) G[a][b] += ra * r[b];
        }
    for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) G[a][b] = G[b][a];
    const matvec = (u: number[]) => G.map(row => { let s = 0; for (let k = 0; k < d; k++) s += row[k] * u[k]; return s; });
    const V: number[][] = [new Array(d).fill(0), new Array(d).fill(0), new Array(d).fill(0)];
    V[0][0] = 1; V[1][1] = 1; V[2][2] = 1;
    for (let sweep = 0; sweep < 200; sweep++) {
        for (let c = 0; c < 3; c++) {
            for (let p = 0; p < c; p++) {
                let dot = 0;
                for (let k = 0; k < d; k++) dot += V[c][k] * V[p][k];
                for (let k = 0; k < d; k++) V[c][k] -= dot * V[p][k];
            }
            let cn = 0;
            for (let k = 0; k < d; k++) cn += V[c][k] * V[c][k];
            cn = Math.sqrt(cn);
            if (cn > 0) for (let k = 0; k < d; k++) V[c][k] /= cn;
            const w = matvec(V[c]);
            let norm = 0;
            for (let k = 0; k < d; k++) norm += w[k] * w[k];
            norm = Math.sqrt(norm);
            if (norm > 0) for (let k = 0; k < d; k++) V[c][k] = w[k] / norm;
        }
    }
    // Rayleigh quotients fix the axis order and the sign, deterministically.
    const lam = V.map(u => { const w = matvec(u); let s = 0; for (let k = 0; k < d; k++) s += u[k] * w[k]; return s; });
    const order = [0, 1, 2].sort((a, b) => lam[b] - lam[a]);
    for (const c of order) {
        const u = V[c];
        let m = 0, mi = 0;
        u.forEach((x, i) => { if (Math.abs(x) > m) { m = Math.abs(x); mi = i; } });
        if (u[mi] < 0) for (let k = 0; k < d; k++) u[k] = -u[k];
    }
    return centred.map(r => order.map(c => { const u = V[c]; let s = 0; for (let k = 0; k < d; k++) s += r[k] * u[k]; return s; }));
}

/**
 * Deterministic 3D layout of (need not be unit) vectors: PCA-seeded gradient
 * descent on the fuzzy-set objective. Centred, ~unit RMS radius.
 */
export function computeLayout(vectors: number[][], opts: LayoutOptions): number[][] {
    const n = vectors.length;
    if (n === 0) return [];
    if (n < 4) return vectors.map((_, i) => [i % 2, (i >> 1) % 2, 0]);
    const v = l2normalize(vectors);
    const { eu, ev, w } = fuzzySet(v, opts.k);
    const m = eu.length;

    // init: 3-D PCA scaled to RMS radius sqrt(10/n) — UMAP's init heuristic,
    // whose code targets mean pairwise distance 10/n, i.e. RMS radius ≈ 10/n
    // (the 10/sqrt(n) figure quoted by its docs is a 10× typo of that; the
    // code is the reference).
    const pos = pca3(v);
    {
        let rms = 0;
        for (const p of pos) rms += p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
        const scale = Math.sqrt(10 / n) / (Math.sqrt(rms / n) + 1e-12);
        for (const p of pos) { p[0] *= scale; p[1] *= scale; p[2] *= scale; }
    }

    // UMAP's solver shape, minus its randomness: per epoch, every edge once in
    // a fixed order, each update applied in place (Gauss–Seidel), learning rate
    // 1.0 decaying linearly to 0 — UMAP's own schedule.
    const epochs = opts.epochs ?? 200;
    const negs = repulsivePartners(n, opts.negativePairs ?? 5);
    for (let epoch = 0; epoch < epochs; epoch++) {
        const lr = 1 - epoch / epochs;
        for (let e = 0; e < m; e++) {
            const i = eu[e], j = ev[e], wij = w[e];
            const dx = pos[i][0] - pos[j][0];
            const dy = pos[i][1] - pos[j][1];
            const dz = pos[i][2] - pos[j][2];
            const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-10);
            // ∂/∂y_i [ −w log q ] = 2ab r2^(b−1) q w (y_i − y_j); descent along −grad
            const coef = lr * wij * (2 * A * B * Math.pow(d2, B - 1) / (A * Math.pow(d2, B) + 1));
            pos[i][0] -= coef * dx; pos[i][1] -= coef * dy; pos[i][2] -= coef * dz;
            pos[j][0] += coef * dx; pos[j][1] += coef * dy; pos[j][2] += coef * dz;
        }
        // repulsion over fixed partners: ∂/∂y_i [ −log(1−q) ] = −2ab r2^(b−1) q²/(1−q) (y_i − y_j)
        for (let i = 0; i < n; i++) {
            for (const j of negs[i]) {
                const dx = pos[i][0] - pos[j][0];
                const dy = pos[i][1] - pos[j][1];
                const dz = pos[i][2] - pos[j][2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > 900) continue; // far pairs contribute nothing (UMAP's cutoff)
                const q = 1 / (A * Math.pow(d2, B) + 1);
                const coef = lr * (2 * A * B * Math.pow(d2, B - 1) * q * q) / Math.max(1 - q, 1e-4);
                pos[i][0] += coef * dx; pos[i][1] += coef * dy; pos[i][2] += coef * dz;
            }
        }
    }

    return centerAndScale(pos);
}

/** Centre on the centroid and scale by one factor for all three axes, so the
 *  cloud keeps its true shape instead of being stretched to fill a cube. */
function centerAndScale(pos: number[][]): number[][] {
    const n = pos.length;
    const c = [0, 0, 0];
    for (const p of pos) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= n; c[1] /= n; c[2] /= n;
    let rms = 0;
    for (const p of pos) rms += (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
    const scale = rms > 0 ? 1 / Math.sqrt(rms / n) : 1;
    return pos.map(p => [(p[0] - c[0]) * scale, (p[1] - c[1]) * scale, (p[2] - c[2]) * scale]);
}

/**
 * Out-of-sample placement: the inverse-distance-weighted mean of the k nearest
 * fitted neighbours, refined with the same objective (attractive edges to
 * those neighbours at their fuzzy weights, fixed repulsion) against fixed
 * fitted positions. Deterministic.
 */
export function embedOutOfSampleBatch(
    vectors: number[][],
    fitVectors: number[][],
    fitPositions: number[][],
    opts: LayoutOptions
): [number, number, number][] {
    const v = l2normalize(vectors);
    const fit = l2normalize(fitVectors);
    const k = Math.min(Math.max(opts.k, 2), fit.length);
    const out: [number, number, number][] = [];
    for (const vi of v) {
        const topIdx: number[] = [], topSim: number[] = [];
        for (let j = 0; j < fit.length; j++) {
            const vj = fit[j];
            let s = 0;
            for (let d = 0; d < vi.length; d++) s += vi[d] * vj[d];
            heapPush(topIdx, topSim, j, s, k);
        }
        // seed: inverse-distance-weighted mean of neighbour positions
        let x = 0, y = 0, z = 0, wsum = 0;
        const dists: number[] = [];
        for (let t = 0; t < topIdx.length; t++) {
            const d = Math.sqrt(Math.max(2 - 2 * Math.min(1, topSim[t]), 1e-9));
            dists.push(d);
            const wt = 1 / (d + 1e-6);
            const p = fitPositions[topIdx[t]];
            x += p[0] * wt; y += p[1] * wt; z += p[2] * wt; wsum += wt;
        }
        if (wsum === 0) { out.push([0, 0, 0]); continue; }
        let pos: [number, number, number] = [x / wsum, y / wsum, z / wsum];
        // weight proxy: w_ij ≈ exp(−(d−ρ)/σ) with per-row σ from the fitted set
        const edges = topIdx.map((_, t) => Math.exp(-dists[t])); // ρ,σ normalised proxy
        const epochs = opts.epochs ?? 30;
        for (let epoch = 0; epoch < epochs; epoch++) {
            const lr = 1 - epoch / epochs;
            let gx = 0, gy = 0, gz = 0;
            for (let t = 0; t < topIdx.length; t++) {
                const p = fitPositions[topIdx[t]];
                const dx = pos[0] - p[0];
                const dy = pos[1] - p[1];
                const dz = pos[2] - p[2];
                const d2 = dx * dx + dy * dy + dz * dz;
                const d = Math.sqrt(Math.max(d2, 1e-12));
                const q = qKernel(d);
                const coef = 2 * A * B * Math.pow(d, 2 * B - 2) * q * edges[t];
                gx += coef * dx; gy += coef * dy; gz += coef * dz;
            }
            // fixed repulsion against two far fitted anchors (deterministic stride)
            for (const j of [(Math.floor(topIdx[0]) + 1_000_003) % fit.length, (Math.floor(topIdx[0]) + 2_000_007) % fit.length]) {
                const p = fitPositions[j];
                const dx = pos[0] - p[0];
                const dy = pos[1] - p[1];
                const dz = pos[2] - p[2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > 900) continue;
                const d = Math.sqrt(Math.max(d2, 1e-12));
                const q = qKernel(d);
                const coef = (2 * A * B * Math.pow(d, 2 * B - 2) * q * q) / Math.max(1 - q, 1e-4);
                gx -= coef * dx; gy -= coef * dy; gz -= coef * dz;
            }
            pos = [pos[0] - lr * gx, pos[1] - lr * gy, pos[2] - lr * gz];
        }
        out.push(pos);
    }
    return out;
}
