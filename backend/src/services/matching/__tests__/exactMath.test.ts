/**
 * The map's own maths: close to JavaScript's, and bit for bit the same on every engine. The fingerprints below were
 * produced on Node 20 (x64) and Node 24 (arm64) alike; a runtime that computes any bit differently fails.
 */
import crypto from "crypto";
import fixture from "./fixtures/map-parity.json";
import { atan2, exp, log, pow } from "../exactMath";
import { layout, place, seededRandom } from "../mapLayout";

const hash = (values: Float64Array) => crypto.createHash("sha256").update(Buffer.from(values.buffer)).digest("hex").slice(0, 32);

function ulps(a: number, b: number): number {
    if (a === b) return 0;
    const bits = new BigInt64Array(new Float64Array([a, b]).buffer);
    return Number(bits[0] > bits[1] ? bits[0] - bits[1] : bits[1] - bits[0]);
}

describe("exact maths", () => {
    it("stays within one unit in the last place of JavaScript's exp, log and atan2, and eight for pow", () => {
        const rng = seededRandom(11);
        let worst = [0, 0, 0, 0];
        for (let i = 0; i < 100000; i++) {
            const x = (rng() - 0.5) * 1400;
            const p = Math.exp((rng() - 0.5) * 1400);
            const y = (rng() - 0.5) * 20;
            const d = rng() * 60;
            worst = [
                Math.max(worst[0], ulps(exp(x), Math.exp(x))),
                Math.max(worst[1], ulps(log(p), Math.log(p))),
                Math.max(worst[2], ulps(atan2(y, x), Math.atan2(y, x))),
                Math.max(worst[3], ulps(pow(d, 0.8950608779639974), Math.pow(d, 0.8950608779639974))),
            ];
        }
        expect(worst[0]).toBeLessThanOrEqual(1);
        expect(worst[1]).toBeLessThanOrEqual(1);
        expect(worst[2]).toBeLessThanOrEqual(1);
        expect(worst[3]).toBeLessThanOrEqual(8);
    });

    it("handles the edges", () => {
        expect(exp(0)).toBe(1);
        expect(exp(-Infinity)).toBe(0);
        expect(exp(800)).toBe(Infinity);
        expect(exp(-800)).toBe(0);
        expect(log(1)).toBe(0);
        expect(log(0)).toBe(-Infinity);
        expect(log(-1)).toBeNaN();
        expect(log(5e-324)).toBeCloseTo(-744.4400719213812, 10);
        expect(pow(0, 0.9)).toBe(0);
        expect(atan2(0, -1)).toBe(Math.PI);
        expect(atan2(-0, -1)).toBe(-Math.PI);
        expect(atan2(1, 0)).toBe(Math.PI / 2);
        expect(atan2(-1, 0)).toBe(-Math.PI / 2);
    });

    it("gives the same bits on every engine", () => {
        const rng = seededRandom(2026);
        const out = new Float64Array(200000 * 4);
        for (let i = 0; i < 200000; i++) {
            const x = (rng() - 0.5) * 60;
            const p = rng() * 50 + 1e-9;
            const y = rng() - 0.5;
            out[i * 4] = exp(x);
            out[i * 4 + 1] = log(p);
            out[i * 4 + 2] = pow(p, 0.8950608779639974);
            out[i * 4 + 3] = atan2(y, x);
        }
        expect(hash(out)).toBe("54c0a078e138dc4e4c2a0e5fe60b9de8");
    });

    it("lays out and places the same bits on every engine", () => {
        const graph = { rows: fixture.knnIdx.length, k: fixture.k, idx: Int32Array.from(fixture.knnIdx.flat()), dist: Float64Array.from(fixture.knnDist.flat()) };
        const laid = layout(graph, Float64Array.from(fixture.transform.embedding.flat()));
        const t = fixture.transform;
        const placed = place(laid, graph.rows, { rows: t.knnIdx.length, k: fixture.k, idx: Int32Array.from(t.knnIdx.flat()), dist: Float64Array.from(t.knnDist.flat()) });
        expect(hash(laid)).toBe("c300a2c3c2bfbc30ecaa29340b9c22b6");
        expect(hash(placed)).toBe("6ffb35a2d6c7f7bf524f203b637e90c3");
    });
});
