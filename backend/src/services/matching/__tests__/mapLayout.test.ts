/**
 * The vibe map's arithmetic against umap-learn 0.5.12 and scikit-learn 1.9 themselves: every deterministic step
 * is compared with the numbers those libraries give on the same synthetic points
 * (fixtures/map-parity.json, written by services/audio-analyzer-clap/eval/map_parity_fixture.py).
 * umap-learn works in float32, so values agree to about 1e-5 of their size.
 */
import fixture from "./fixtures/map-parity.json";
import {
    CURVE_A,
    CURVE_B,
    colourAt,
    colourField,
    fuzzyGraph,
    layout,
    layoutEpochs,
    place,
    principalScores,
    principalStart,
    smoothKnnDist,
    transformStart,
    type Graph,
} from "../mapLayout";

function graphOf(idx: number[][], dist: number[][]): Graph {
    return {
        rows: idx.length,
        k: idx[0].length,
        idx: Int32Array.from(idx.flat()),
        dist: Float64Array.from(dist.flat()),
    };
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, relative = 2e-5): void {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(relative * Math.max(1, Math.abs(expected[i])));
    }
}

function centredProducts(points: number[][]) {
    const n = points.length;
    const d = points[0].length;
    const mean = Array.from({ length: d }, (_, c) => points.reduce((s, p) => s + p[c], 0) / n);
    const rows = points.map((p) => p.map((x, c) => x - mean[c]));
    return {
        n,
        d,
        multiply: (v: Float64Array) => Float64Array.from(rows, (r) => r.reduce((s, x, c) => s + x * v[c], 0)),
        multiplyT: (u: Float64Array) => {
            const out = new Float64Array(d);
            rows.forEach((r, i) => r.forEach((x, c) => (out[c] += x * u[i])));
            return out;
        },
    };
}

const fitted = graphOf(fixture.knnIdx, fixture.knnDist);

describe("vibe map layout, against umap-learn", () => {
    it("gives every point umap-learn's own scale and nearest distance", () => {
        const { rho, sigma } = smoothKnnDist(fitted, 1);
        expectClose(rho, fixture.rho);
        expectClose(sigma, fixture.sigma);
    });

    it("builds the same two-way graph, with the same weak edges dropped", () => {
        const graph = fuzzyGraph(fitted, fixture.epochs);
        expect(Array.from(graph.head)).toEqual(fixture.graph.head);
        expect(Array.from(graph.tail)).toEqual(fixture.graph.tail);
        expectClose(graph.weight, fixture.graph.weight);
    });

    it("uses umap-learn's curve for a minimum distance of 0.1", () => {
        expect(CURVE_A).toBeCloseTo(fixture.a, 5);
        expect(CURVE_B).toBeCloseTo(fixture.b, 5);
    });

    it("starts a new point where umap-learn's transform starts it", () => {
        const t = fixture.transform;
        const graph = graphOf(t.knnIdx, t.knnDist);
        expectClose(smoothKnnDist(graph, 0).sigma, t.sigma);
        const { pos, weight } = transformStart(Float64Array.from(t.embedding.flat()), graph);
        expectClose(weight, t.weight);
        expectClose(pos, t.start.flat(), 1e-5);
    });

    it("puts a new point that matches a laid-out one exactly on top of it", () => {
        const t = fixture.transform;
        const graph = graphOf(t.knnIdx.slice(0, 1), [[0, ...t.knnDist[0].slice(1)]]);
        const embedding = Float64Array.from(t.embedding.flat());
        const { pos } = transformStart(embedding, graph);
        const twin = t.knnIdx[0][0];
        expect(Array.from(pos)).toEqual(Array.from(embedding.subarray(twin * 3, twin * 3 + 3)));
    });

    it.each([0, 1])("finds scikit-learn's main axes, signs included (set %i)", (set) => {
        // Within 1e-6 of the largest score: a hundredth of the noise umap-learn adds to its start (1e-4 at 10).
        const { points, scores } = fixture.pca[set];
        const { n, d, multiply, multiplyT } = centredProducts(points);
        const expected = scores.flat();
        const largest = Math.max(...expected.map(Math.abs));
        const actual = principalScores(n, d, multiply, multiplyT);
        expected.forEach((x, i) => expect(Math.abs(actual[i] - x)).toBeLessThanOrEqual(1e-6 * largest));
    });

    it("scales the start to a largest coordinate of 10, as umap-learn does", () => {
        const { points } = fixture.pca[1];
        const { n, d, multiply, multiplyT } = centredProducts(points);
        const start = principalStart(n, d, multiply, multiplyT);
        const largest = Math.max(...Array.from(start, Math.abs));
        expect(largest).toBeGreaterThan(10 - 1e-3);
        expect(largest).toBeLessThan(10 + 1e-3);
    });

    it("runs 500 epochs up to 10,000 tracks and 200 above, as umap-learn does", () => {
        expect(layoutEpochs(10000)).toBe(500);
        expect(layoutEpochs(10001)).toBe(200);
    });

    it("lays out and places the same way every time", () => {
        const { points } = fixture.pca[0];
        const { n, d, multiply, multiplyT } = centredProducts(points);
        const start = principalStart(n, d, multiply, multiplyT);
        const first = layout(fitted, start);
        expect(Array.from(layout(fitted, start))).toEqual(Array.from(first));
        expect(first.every(Number.isFinite)).toBe(true);
        const t = fixture.transform;
        const graph = graphOf(t.knnIdx, t.knnDist);
        const placed = place(first, n, graph);
        expect(Array.from(place(first, n, graph))).toEqual(Array.from(placed));
        expect(placed.every(Number.isFinite)).toBe(true);
    });
});

describe("vibe map colour field", () => {
    const n = 240;
    const angle = (i: number) => (2 * Math.PI * i) / n;
    const feel = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
        feel[i * 2] = Math.sin(angle(i));
        feel[i * 2 + 1] = Math.cos(angle(i));
    }
    function mapFrom(axes: number[][]): Float64Array {
        const pos = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const plane = [5 * Math.cos(angle(i)), 5 * Math.sin(angle(i)), 0.3 * Math.sin(7 * angle(i) + 0.4)];
            for (let d = 0; d < 3; d++) pos[i * 3 + d] = 2 + axes[d].reduce((s, a, c) => s + a * plane[c], 0);
        }
        return pos;
    }
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    const upright = mapFrom([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const turned = mapFrom([[c, -s, 0], [s * 0.6, c * 0.6, 0.8], [-s * 0.8, -c * 0.8, 0.6]]);
    const mirrored = mapFrom([[0, 1, 0], [1, 0, 0], [0, 0, 1]]);

    it("follows feel round the circle from the calm pole: intense half way, positive at three quarters", () => {
        const { colour } = colourField(upright, n, feel);
        expect(Math.min(...colour)).toBe(0);
        expect(Math.max(...colour)).toBe(1);
        expect(colour[0]).toBeCloseTo(0.5, 1);
        expect(colour[n / 4]).toBeCloseTo(0.75, 1);
        expect(colour[(3 * n) / 4]).toBeCloseTo(0.25, 1);
    });

    it("does not depend on how the map happens to be turned or mirrored", () => {
        const base = colourField(upright, n, feel).colour;
        expectClose(colourField(turned, n, feel).colour, base, 1e-9);
        expectClose(colourField(mirrored, n, feel).colour, base, 1e-9);
    });

    it("colours a placed track by the same rule as the laid-out ones", () => {
        const { frame, colour } = colourField(turned, n, feel);
        expectClose(colourAt(frame, turned, n, turned, n), colour, 1e-12);
    });
});
