/**
 * The vibe map's arithmetic for the similarity step, run in a worker thread by services/matching/map.ts: the
 * whole-library layout and the placement of new tracks, both from the matching formula's own neighbours.
 */
import { FEEL_WEIGHT, type GenreModel, type MatchTrack } from "./formula";
import { MAP_NEIGHBOURS, colourAt, colourField, layout, place, principalStart, type ColourFrame, type Graph } from "./mapLayout";
import { nearestColumns } from "./neighbours";

export interface LaidOutMap {
    positions: Float64Array;
    colour: Float64Array;
    frame: ColourFrame;
    /** The highest score between two tracks; a distance is this minus the score. */
    maxScore: number;
}

export interface PlacedTracks {
    positions: Float64Array;
    colour: Float64Array;
}

/**
 * Multiplication by the centred matrix whose rows are [sound; 0.25·feel; w_g·genre], the vector the formula is
 * the dot product of (genre counted for an artist's own tracks too), without building it: each artist's genre
 * vector is its sparse TF-IDF entries less the library mean, over its norm.
 */
function centredRows(tracks: MatchTrack[], model: GenreModel, genreWeight: number) {
    const n = tracks.length;
    const dim = tracks[0].sound.length;
    const vocab = model.vocabulary.length;
    const d = dim + 2 + vocab;
    const entry = tracks.map((t) => model.artists[t.artistId] ?? null);
    const raw = (v: Float64Array) => {
        const out = new Float64Array(n);
        let meanDot = 0;
        for (let g = 0; g < vocab; g++) meanDot += model.mean[g] * v[dim + 2 + g];
        const genreDot = new Map<string, number>();
        for (let i = 0; i < n; i++) {
            const t = tracks[i];
            let s = 0;
            for (let c = 0; c < dim; c++) s += t.sound[c] * v[c];
            s += FEEL_WEIGHT * (t.feel[0] * v[dim] + t.feel[1] * v[dim + 1]);
            const e = entry[i];
            if (e) {
                let gd = genreDot.get(t.artistId);
                if (gd === undefined) {
                    gd = 0;
                    e.index.forEach((g, k) => (gd! += e.weight[k] * v[dim + 2 + g]));
                    gd = (gd - meanDot) / e.norm;
                    genreDot.set(t.artistId, gd);
                }
                s += genreWeight * gd;
            }
            out[i] = s;
        }
        return out;
    };
    const rawT = (u: Float64Array) => {
        const out = new Float64Array(d);
        const byArtist = new Map<string, number>();
        for (let i = 0; i < n; i++) {
            const t = tracks[i];
            for (let c = 0; c < dim; c++) out[c] += u[i] * t.sound[c];
            out[dim] += FEEL_WEIGHT * u[i] * t.feel[0];
            out[dim + 1] += FEEL_WEIGHT * u[i] * t.feel[1];
            if (entry[i]) byArtist.set(t.artistId, (byArtist.get(t.artistId) ?? 0) + u[i]);
        }
        let meanShare = 0;
        for (const [artistId, total] of byArtist) {
            const e = model.artists[artistId];
            const share = (genreWeight * total) / e.norm;
            e.index.forEach((g, k) => (out[dim + 2 + g] += share * e.weight[k]));
            meanShare += share;
        }
        for (let g = 0; g < vocab; g++) out[dim + 2 + g] -= meanShare * model.mean[g];
        return out;
    };
    const mean = rawT(new Float64Array(n).fill(1 / n));
    const multiply = (v: Float64Array) => {
        const out = raw(v);
        let shift = 0;
        for (let c = 0; c < d; c++) shift += mean[c] * v[c];
        for (let i = 0; i < n; i++) out[i] -= shift;
        return out;
    };
    const multiplyT = (u: Float64Array) => {
        const out = rawT(u);
        let total = 0;
        for (let i = 0; i < n; i++) total += u[i];
        for (let c = 0; c < d; c++) out[c] -= mean[c] * total;
        return out;
    };
    return { d, multiply, multiplyT };
}

/**
 * The whole library's map: neighbours, start, layout and colour field. `feelZ` is n × 2 standardised (valence,
 * arousal). `seed` is fixed in the engine; other seeds measure how much a fresh layout moves things.
 */
export function layoutLibrary(
    tracks: MatchTrack[],
    feelZ: Float64Array,
    model: GenreModel,
    genreWeight: number,
    seed?: number,
): LaidOutMap {
    const n = tracks.length;
    const near = nearestColumns(tracks, tracks, model, genreWeight ** 2, MAP_NEIGHBOURS - 1, true);
    const k = near.k + 1;
    const graph: Graph = { rows: n, k, idx: new Int32Array(n * k), dist: new Float64Array(n * k) };
    for (let i = 0; i < n; i++) {
        graph.idx[i * k] = i;
        for (let r = 0; r < near.k; r++) {
            graph.idx[i * k + 1 + r] = near.idx[i * near.k + r];
            graph.dist[i * k + 1 + r] = near.maxScore - near.score[i * near.k + r];
        }
    }
    const { d, multiply, multiplyT } = centredRows(tracks, model, genreWeight);
    const positions = layout(graph, principalStart(n, d, multiply, multiplyT, seed), seed);
    const { frame, colour } = colourField(positions, n, feelZ);
    return { positions, colour, frame, maxScore: near.maxScore };
}

/**
 * New tracks placed among the laid-out ones by umap-learn's transform rule; each coloured by its area among every
 * positioned track (`positioned`, laid out and placed before, then these).
 */
export function placeTracks(
    laidOut: MatchTrack[],
    laidOutPositions: Float64Array,
    positioned: Float64Array,
    newTracks: MatchTrack[],
    model: GenreModel,
    genreWeight: number,
    frame: ColourFrame,
    maxScore: number,
): PlacedTracks {
    const m = newTracks.length;
    const near = nearestColumns(newTracks, laidOut, model, genreWeight ** 2, MAP_NEIGHBOURS, false);
    const graph: Graph = { rows: m, k: near.k, idx: near.idx, dist: new Float64Array(m * near.k) };
    for (let e = 0; e < m * near.k; e++) graph.dist[e] = Math.max(maxScore - near.score[e], 0);
    const positions = place(laidOutPositions, laidOut.length, graph);
    const all = new Float64Array(positioned.length + positions.length);
    all.set(positioned);
    all.set(positions, positioned.length);
    const colour = colourAt(frame, all, all.length / 3, positions, m);
    return { positions, colour };
}
