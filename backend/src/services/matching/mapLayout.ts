/**
 * The vibe map's maths: UMAP's published method (McInnes, Healy & Melville, arXiv 1802.03426) step for step with
 * umap-learn 0.5.12, run on the matching formula's own neighbours, and the colour field. Pure arithmetic, run in a
 * worker thread; only exactly specified operations and `./exactMath`, so every runtime gives the same map.
 */
import { atan2, exp, log } from "./exactMath";

/** Neighbours per track, the track itself counted first as umap-learn counts it. */
export const MAP_NEIGHBOURS = 15;
/** umap-learn's find_ab_params(spread 1, min_dist 0.1); refit independently to 1.576944 / 0.895061. */
export const CURVE_A = 1.57694346046584;
export const CURVE_B = 0.8950608779639974;
/** A track's colour is its area's: the mean over its nearest tracks on the map, the map gate's k′. */
const AREA_NEIGHBOURS = 50;
const NEGATIVE_RATE = 5;
const SEED = 42;

/** Rows × k neighbour lists: indices and distances, nearest first. */
export interface Graph {
    rows: number;
    k: number;
    idx: Int32Array;
    dist: Float64Array;
}

/** The rigid turn of the map onto the colour plane, kept so placed tracks are coloured on the same field. */
export interface ColourFrame {
    centre: number[];
    scale: number;
    /** 3 × 2, row-major: map axes onto (arousal, valence). */
    turn: number[];
    hueMin: number;
    hueMax: number;
}

/** mulberry32: a small seeded generator, so the same library always gives the same map. */
export function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A standard normal number by Marsaglia's polar method, which needs no trigonometry. */
function gaussian(rng: () => number): number {
    for (;;) {
        const u = 2 * rng() - 1;
        const v = 2 * rng() - 1;
        const s = u * u + v * v;
        if (s > 0 && s < 1) return u * Math.sqrt((-2 * log(s)) / s);
    }
}

const clip = (x: number) => (x > 4 ? 4 : x < -4 ? -4 : x);

/** umap-learn's passes over the edges: 500 up to 10,000 tracks, 200 above. */
export function layoutEpochs(tracks: number): number {
    return tracks <= 10000 ? 500 : 200;
}

/**
 * Each track's own scale (umap_.py smooth_knn_dist): ρ the distance to its nearest neighbour, σ found by 64
 * halvings so its neighbours' strengths add up to log₂ k, never below 0.001 × the mean distance. Column 0 is
 * left out of the sum, as umap-learn leaves it out.
 */
export function smoothKnnDist(graph: Graph, localConnectivity: number): { rho: Float64Array; sigma: Float64Array } {
    const { rows, k, dist } = graph;
    const target = log(k) / Math.LN2;
    const rho = new Float64Array(rows);
    const sigma = new Float64Array(rows);
    let total = 0;
    for (let i = 0; i < rows * k; i++) total += dist[i];
    const meanAll = total / (rows * k);
    for (let i = 0; i < rows; i++) {
        const row = dist.subarray(i * k, (i + 1) * k);
        const nonZero = Array.from(row).filter((d) => d > 0);
        if (nonZero.length >= localConnectivity) {
            const index = Math.floor(localConnectivity);
            const interpolation = localConnectivity - index;
            if (index > 0) {
                rho[i] = nonZero[index - 1];
                if (interpolation > 1e-5) rho[i] += interpolation * (nonZero[index] - nonZero[index - 1]);
            } else {
                rho[i] = nonZero.length > 0 ? interpolation * nonZero[0] : 0;
            }
        } else if (nonZero.length > 0) {
            rho[i] = Math.max(...nonZero);
        }
        let lo = 0;
        let hi = Infinity;
        let mid = 1;
        for (let step = 0; step < 64; step++) {
            let sum = 0;
            for (let j = 1; j < k; j++) {
                const d = row[j] - rho[i];
                sum += d > 0 ? exp(-(d / mid)) : 1;
            }
            if (Math.abs(sum - target) < 1e-5) break;
            if (sum > target) {
                hi = mid;
                mid = (lo + hi) / 2;
            } else {
                lo = mid;
                mid = hi === Infinity ? mid * 2 : (lo + hi) / 2;
            }
        }
        let meanIth = 0;
        for (let j = 0; j < k; j++) meanIth += row[j];
        meanIth /= k;
        const floor = rho[i] > 0 ? 1e-3 * meanIth : 1e-3 * meanAll;
        sigma[i] = mid < floor ? floor : mid;
    }
    return { rho, sigma };
}

/** umap_.py compute_membership_strengths, for one edge. */
function strength(d: number, rho: number, sigma: number): number {
    return d - rho <= 0 || sigma === 0 ? 1 : exp(-((d - rho) / sigma));
}

/**
 * The two-way graph (umap_.py fuzzy union A + Aᵀ − A∘Aᵀ), edges weaker than max/epochs dropped, in umap-learn's
 * row-major order. Row i of `graph` is track i's neighbours with i itself first.
 */
export function fuzzyGraph(graph: Graph, epochs: number): { head: Int32Array; tail: Int32Array; weight: Float64Array } {
    const { rows, k, idx, dist } = graph;
    const { rho, sigma } = smoothKnnDist(graph, 1);
    const one = new Map<number, number>();
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < k; j++) {
            const c = idx[i * k + j];
            if (c === i) continue;
            const w = strength(dist[i * k + j], rho[i], sigma[i]);
            if (w > 0) one.set(i * rows + c, w);
        }
    }
    const both = new Map<number, number>();
    for (const [key, w] of one) {
        const i = Math.floor(key / rows);
        const c = key % rows;
        const back = one.get(c * rows + i) ?? 0;
        const union = w + back - w * back;
        both.set(key, union);
        both.set(c * rows + i, union);
    }
    let max = 0;
    for (const w of both.values()) max = Math.max(max, w);
    const keys = [...both.keys()].filter((key) => both.get(key)! >= max / epochs).sort((a, b) => a - b);
    const head = new Int32Array(keys.length);
    const tail = new Int32Array(keys.length);
    const weight = new Float64Array(keys.length);
    keys.forEach((key, e) => {
        head[e] = Math.floor(key / rows);
        tail[e] = key % rows;
        weight[e] = both.get(key)!;
    });
    return { head, tail, weight };
}

/**
 * The moves (umap layouts.py optimize_layout_euclidean): each edge pulls its tracks together by the derivative
 * of log q, q = 1/(1 + a·d²ᵇ), and pushes against random tracks by the derivative of log(1 − q); every move is
 * clipped to ±4; the step size falls linearly from `alpha0` to 0. Edges are visited in proportion to their weight.
 */
function optimize(
    head: Float64Array,
    tail: Float64Array,
    edges: { head: Int32Array; tail: Int32Array; weight: Float64Array },
    epochs: number,
    vertices: number,
    alpha0: number,
    rng: () => number,
    moveOther: boolean,
): void {
    const m = edges.head.length;
    let wmax = 0;
    for (let e = 0; e < m; e++) wmax = Math.max(wmax, edges.weight[e]);
    const perSample = new Float64Array(m);
    const perNegative = new Float64Array(m);
    const nextSample = new Float64Array(m);
    const nextNegative = new Float64Array(m);
    for (let e = 0; e < m; e++) {
        perSample[e] = wmax / edges.weight[e];
        perNegative[e] = perSample[e] / NEGATIVE_RATE;
        nextSample[e] = perSample[e];
        nextNegative[e] = perNegative[e];
    }
    const a = CURVE_A;
    const b = CURVE_B;
    let alpha = alpha0;
    for (let n = 0; n < epochs; n++) {
        for (let e = 0; e < m; e++) {
            if (nextSample[e] > n) continue;
            const cj = edges.head[e] * 3;
            const ok = edges.tail[e] * 3;
            let d2 = 0;
            for (let d = 0; d < 3; d++) {
                const q = head[cj + d] - tail[ok + d];
                d2 += q * q;
            }
            let pull = 0;
            if (d2 > 0) {
                const powered = exp(b * log(d2));
                pull = (-2 * a * b * (powered / d2)) / (a * powered + 1);
            }
            for (let d = 0; d < 3; d++) {
                const g = clip(pull * (head[cj + d] - tail[ok + d]));
                head[cj + d] += g * alpha;
                if (moveOther) tail[ok + d] -= g * alpha;
            }
            nextSample[e] += perSample[e];
            const negatives = Math.trunc((n - nextNegative[e]) / perNegative[e]);
            for (let p = 0; p < negatives; p++) {
                const other = Math.floor(rng() * vertices);
                const o = other * 3;
                let dd = 0;
                for (let d = 0; d < 3; d++) {
                    const q = head[cj + d] - tail[o + d];
                    dd += q * q;
                }
                let push = 0;
                if (dd > 0) push = (2 * b) / ((0.001 + dd) * (a * exp(b * log(dd)) + 1));
                else if (edges.head[e] === other) continue;
                for (let d = 0; d < 3; d++) {
                    head[cj + d] += (push > 0 ? clip(push * (head[cj + d] - tail[o + d])) : 0) * alpha;
                }
            }
            nextNegative[e] += negatives * perNegative[e];
        }
        alpha = alpha0 * (1 - n / epochs);
    }
}

/** Every track's position (rows × 3): the fuzzy graph of its neighbours, `start` stretched to 0–10 per axis, then the moves. */
export function layout(graph: Graph, start: Float64Array, seed = SEED): Float64Array {
    const n = graph.rows;
    const epochs = layoutEpochs(n);
    const edges = fuzzyGraph(graph, epochs);
    const pos = new Float64Array(n * 3);
    for (let d = 0; d < 3; d++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < n; i++) {
            lo = Math.min(lo, start[i * 3 + d]);
            hi = Math.max(hi, start[i * 3 + d]);
        }
        const span = hi - lo || 1;
        for (let i = 0; i < n; i++) pos[i * 3 + d] = (10 * (start[i * 3 + d] - lo)) / span;
    }
    optimize(pos, pos, edges, epochs, n, 1, seededRandom(seed), true);
    return pos;
}

/**
 * New tracks among laid-out ones (umap_.py transform): their neighbours' strengths with local connectivity 0,
 * a start at the strength-weighted mean of those neighbours (init_graph_transform), then 100 passes (30 above
 * 10,000 new tracks) at a quarter of the step size with every laid-out track held still. Row i of `graph` lists
 * new track i's nearest laid-out tracks, nearest first.
 */
export function place(fitted: Float64Array, fittedCount: number, graph: Graph, seed = SEED): Float64Array {
    const { rows, k, idx } = graph;
    const { pos, weight } = transformStart(fitted, graph);
    const epochs = rows <= 10000 ? 100 : 30;
    let wmax = 0;
    for (const w of weight) wmax = Math.max(wmax, w);
    const head: number[] = [];
    const tail: number[] = [];
    const kept: number[] = [];
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < k; j++) {
            const w = weight[i * k + j];
            if (w < wmax / epochs) continue;
            head.push(i);
            tail.push(idx[i * k + j]);
            kept.push(w);
        }
    }
    const edges = { head: Int32Array.from(head), tail: Int32Array.from(tail), weight: Float64Array.from(kept) };
    optimize(pos, Float64Array.from(fitted), edges, epochs, fittedCount, 0.25, seededRandom(seed), false);
    return pos;
}

/** A new track's starting point (umap_.py init_graph_transform) and its edge strengths, local connectivity 0. */
export function transformStart(fitted: Float64Array, graph: Graph): { pos: Float64Array; weight: Float64Array } {
    const { rows, k, idx, dist } = graph;
    const { rho, sigma } = smoothKnnDist(graph, 0);
    const weight = new Float64Array(rows * k);
    for (let i = 0; i < rows; i++) for (let j = 0; j < k; j++) weight[i * k + j] = strength(dist[i * k + j], rho[i], sigma[i]);
    const pos = new Float64Array(rows * 3);
    for (let i = 0; i < rows; i++) {
        let sum = 0;
        for (let j = 0; j < k; j++) sum += weight[i * k + j];
        for (let j = 0; j < k; j++) {
            const w = weight[i * k + j];
            const c = idx[i * k + j] * 3;
            if (w === 1) {
                for (let d = 0; d < 3; d++) pos[i * 3 + d] = fitted[c + d];
                break;
            }
            for (let d = 0; d < 3; d++) pos[i * 3 + d] += (w / sum) * fitted[c + d];
        }
    }
    return { pos, weight };
}

/** Symmetric 2×2 or 3×3 eigen-decomposition by Jacobi rotations; columns of `vectors` match `values`, largest first. */
function symmetricEigen(m: number[][]): { values: number[]; vectors: number[][] } {
    const n = m.length;
    const a = m.map((r) => r.slice());
    const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
        if (off < 1e-30) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let r = 0; r < n; r++) {
                    const arp = a[r][p];
                    const arq = a[r][q];
                    a[r][p] = c * arp - s * arq;
                    a[r][q] = s * arp + c * arq;
                }
                for (let r = 0; r < n; r++) {
                    const apr = a[p][r];
                    const aqr = a[q][r];
                    a[p][r] = c * apr - s * aqr;
                    a[q][r] = s * apr + c * aqr;
                }
                for (let r = 0; r < n; r++) {
                    const vrp = v[r][p];
                    const vrq = v[r][q];
                    v[r][p] = c * vrp - s * vrq;
                    v[r][q] = s * vrp + c * vrq;
                }
            }
        }
    }
    const order = a.map((r, i) => [r[i], i] as const).sort((x, y) => y[0] - x[0]);
    return { values: order.map(([val]) => val), vectors: v.map((row) => order.map(([, i]) => row[i])) };
}

/**
 * The 3 main axes of the centred n × d matrix behind `multiply` (X·v) and `multiplyT` (Xᵀ·u), as scores n × 3
 * (track-major): subspace iteration on XᵀX with 10 extra directions from a seeded start, then the 3 largest Ritz
 * pairs; each axis's sign set so its largest entry is positive, as scikit-learn's svd_flip does.
 */
export function principalScores(
    n: number,
    d: number,
    multiply: (v: Float64Array) => Float64Array,
    multiplyT: (u: Float64Array) => Float64Array,
    seed = SEED,
): Float64Array {
    const rng = seededRandom(seed);
    const width = Math.min(13, d);
    const orthonormalise = (vs: Float64Array[]) => {
        const out: Float64Array[] = [];
        for (const v of vs) {
            const w = Float64Array.from(v);
            for (let pass = 0; pass < 2; pass++) {
                for (const u of out) {
                    let p = 0;
                    for (let i = 0; i < d; i++) p += w[i] * u[i];
                    for (let i = 0; i < d; i++) w[i] -= p * u[i];
                }
            }
            let norm = 0;
            for (let i = 0; i < d; i++) norm += w[i] * w[i];
            norm = Math.sqrt(norm) || 1;
            for (let i = 0; i < d; i++) w[i] /= norm;
            out.push(w);
        }
        return out;
    };
    const ritz = (basis: Float64Array[]) => {
        const projected = basis.map((v) => multiply(v));
        const small = basis.map((_, r) => basis.map((__, c) => {
            let p = 0;
            for (let i = 0; i < n; i++) p += projected[r][i] * projected[c][i];
            return p;
        }));
        return symmetricEigen(small);
    };
    let basis = orthonormalise(Array.from({ length: width }, () => Float64Array.from({ length: d }, () => gaussian(rng))));
    let previous = [0, 0, 0];
    for (let iter = 0; iter < 200; iter++) {
        basis = orthonormalise(basis.map((v) => multiplyT(multiply(v))));
        const { values } = ritz(basis);
        const settled = values.slice(0, 3).every((v, i) => Math.abs(v - previous[i]) <= 1e-12 * Math.abs(v));
        previous = values.slice(0, 3);
        if (settled) break;
    }
    const { vectors } = ritz(basis);
    const axes = [0, 1, 2].map((c) => {
        const axis = new Float64Array(d);
        for (let r = 0; r < basis.length; r++) for (let i = 0; i < d; i++) axis[i] += vectors[r][c] * basis[r][i];
        let big = 0;
        for (let i = 0; i < d; i++) if (Math.abs(axis[i]) > Math.abs(big)) big = axis[i];
        if (big < 0) for (let i = 0; i < d; i++) axis[i] = -axis[i];
        return axis;
    });
    const scores = axes.map((axis) => multiply(axis));
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = scores[c][i];
    return out;
}

/** umap-learn's start from the main axes (noisy_scale_coords): largest coordinate 10, then noise of 1e-4. */
export function principalStart(
    n: number,
    d: number,
    multiply: (v: Float64Array) => Float64Array,
    multiplyT: (u: Float64Array) => Float64Array,
    seed = SEED,
): Float64Array {
    const scores = principalScores(n, d, multiply, multiplyT, seed);
    let largest = 0;
    for (const x of scores) largest = Math.max(largest, Math.abs(x));
    const rng = seededRandom(seed + 1);
    return scores.map((x) => x * (10 / (largest || 1)) + 1e-4 * gaussian(rng));
}

/** Indices of each query's `k` nearest positions (Euclidean), nearest first, itself included when it is a member. */
function nearestPositions(pos: Float64Array, count: number, query: Float64Array, queries: number, k: number): Int32Array {
    const out = new Int32Array(queries * k);
    const heapIdx = new Int32Array(k);
    const heapDist = new Float64Array(k);
    for (let q = 0; q < queries; q++) {
        let size = 0;
        const worse = (a: number, b: number) => heapDist[a] > heapDist[b] || (heapDist[a] === heapDist[b] && heapIdx[a] > heapIdx[b]);
        const swap = (a: number, b: number) => {
            const ti = heapIdx[a]; heapIdx[a] = heapIdx[b]; heapIdx[b] = ti;
            const td = heapDist[a]; heapDist[a] = heapDist[b]; heapDist[b] = td;
        };
        for (let j = 0; j < count; j++) {
            let s = 0;
            for (let d = 0; d < 3; d++) {
                const t = pos[j * 3 + d] - query[q * 3 + d];
                s += t * t;
            }
            if (size < k) {
                heapIdx[size] = j;
                heapDist[size] = s;
                for (let i = size++; i > 0;) {
                    const p = (i - 1) >> 1;
                    if (!worse(i, p)) break;
                    swap(i, p);
                    i = p;
                }
            } else if (s < heapDist[0] || (s === heapDist[0] && j < heapIdx[0])) {
                heapIdx[0] = j;
                heapDist[0] = s;
                for (let i = 0; ;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < size && worse(l, m)) m = l;
                    if (r < size && worse(r, m)) m = r;
                    if (m === i) break;
                    swap(i, m);
                    i = m;
                }
            }
        }
        const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => heapDist[a] - heapDist[b] || heapIdx[a] - heapIdx[b]);
        order.forEach((h, r) => (out[q * k + r] = heapIdx[h]));
    }
    return out;
}

/** The hue angle, in degrees, of the colour-plane point (arousal, valence), cut at the calm pole (low arousal). */
function hueFromCalm(arousal: number, valence: number): number {
    return (((atan2(valence, arousal) * 180) / Math.PI) - 180 + 720) % 360;
}

function project(frame: ColourFrame, pos: Float64Array, i: number): [number, number] {
    const p = [0, 1, 2].map((d) => (pos[i * 3 + d] - frame.centre[d]) / frame.scale);
    return [
        p[0] * frame.turn[0] + p[1] * frame.turn[2] + p[2] * frame.turn[4],
        p[0] * frame.turn[1] + p[1] * frame.turn[3] + p[2] * frame.turn[5],
    ];
}

/**
 * The colour field: the map centred, scaled to unit spread and turned rigidly onto the colour plane
 * so its axes line up with arousal and valence (orthogonal Procrustes, 3 × 2); each track takes the mean of its
 * area's 50 nearest tracks on the map; its colour is its place along the hue circle from the calm pole, as a share
 * of the library's range: 0 is the logo's azure end, 1 its amber end. `feel` is n × 2 standardised (valence, arousal).
 */
export function colourField(pos: Float64Array, n: number, feel: Float64Array): { frame: ColourFrame; colour: Float64Array } {
    const centre = [0, 1, 2].map((d) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += pos[i * 3 + d];
        return s / n;
    });
    let spread = 0;
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) spread += (pos[i * 3 + d] - centre[d]) ** 2;
    const scale = Math.sqrt(spread / n) || 1;
    const meanFeel = [0, 1].map((c) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += feel[i * 2 + c];
        return s / n;
    });
    const cross = [0, 1, 2].map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
        const target = [feel[i * 2 + 1] - meanFeel[1], feel[i * 2] - meanFeel[0]];
        for (let d = 0; d < 3; d++) {
            const p = (pos[i * 3 + d] - centre[d]) / scale;
            cross[d][0] += p * target[0];
            cross[d][1] += p * target[1];
        }
    }
    const mtm = [0, 1].map((r) => [0, 1].map((c) => cross[0][r] * cross[0][c] + cross[1][r] * cross[1][c] + cross[2][r] * cross[2][c]));
    const { values, vectors } = symmetricEigen(mtm);
    const turn = new Array<number>(6).fill(0);
    for (let c = 0; c < 2; c++) {
        const sv = Math.sqrt(Math.max(values[c], 0)) || 1;
        for (let d = 0; d < 3; d++) {
            const u = (cross[d][0] * vectors[0][c] + cross[d][1] * vectors[1][c]) / sv;
            for (let out = 0; out < 2; out++) turn[d * 2 + out] += u * vectors[out][c];
        }
    }
    const frame: ColourFrame = { centre, scale, turn, hueMin: 0, hueMax: 360 };
    const hue = areaHues(frame, pos, n, pos, n);
    let hueMin = Infinity;
    let hueMax = -Infinity;
    for (const h of hue) {
        if (h < hueMin) hueMin = h;
        if (h > hueMax) hueMax = h;
    }
    frame.hueMin = hueMin;
    frame.hueMax = hueMax;
    return { frame, colour: hue.map((h) => toShare(frame, h)) };
}

/** The colour of tracks at `query` positions on an existing field, their areas taken among all `pos` tracks. */
export function colourAt(frame: ColourFrame, pos: Float64Array, count: number, query: Float64Array, queries: number): Float64Array {
    return areaHues(frame, pos, count, query, queries).map((h) => toShare(frame, h));
}

function areaHues(frame: ColourFrame, pos: Float64Array, count: number, query: Float64Array, queries: number): Float64Array {
    const k = Math.min(AREA_NEIGHBOURS, count);
    const near = nearestPositions(pos, count, query, queries, k);
    const plane = new Float64Array(count * 2);
    for (let j = 0; j < count; j++) {
        const [x, y] = project(frame, pos, j);
        plane[j * 2] = x;
        plane[j * 2 + 1] = y;
    }
    const hue = new Float64Array(queries);
    for (let q = 0; q < queries; q++) {
        let x = 0;
        let y = 0;
        for (let r = 0; r < k; r++) {
            const j = near[q * k + r];
            x += plane[j * 2];
            y += plane[j * 2 + 1];
        }
        hue[q] = hueFromCalm(x / k, y / k);
    }
    return hue;
}

function toShare(frame: ColourFrame, hue: number): number {
    const span = frame.hueMax - frame.hueMin;
    return span > 0 ? Math.min(1, Math.max(0, (hue - frame.hueMin) / span)) : 0.5;
}
