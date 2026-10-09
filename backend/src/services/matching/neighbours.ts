/**
 * Exact neighbour lists from the formula, every pair scored: the public export's lists (capped, the track itself
 * counted) and the vibe map's neighbours (plain top k). The time grows with the square of the library, so callers
 * run them in a worker thread.
 */
import { FEEL_WEIGHT, artistBonuses, capList, type GenreModel, type MatchTrack } from "./formula";
import { runInWorker } from "./worker";

const FIRST_POOL = 64;

export type NeighbourLists = Map<string, Array<[string, number]>>;

/** Rows × k nearest columns by the formula, best first, equal scores in track id order. */
export interface NearestColumns {
    k: number;
    idx: Int32Array;
    score: Float64Array;
    /** The highest score between a row and a column other than itself. */
    maxScore: number;
}

function idOrder(tracks: MatchTrack[]): Int32Array {
    const rank = new Int32Array(tracks.length);
    tracks
        .map((t, i) => [t.trackId, i] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .forEach(([, i], r) => (rank[i] = r));
    return rank;
}

/**
 * Scores every row track against every column track with the formula, four rows per sweep over the columns, and
 * hands each row's scores to `onRow` (the array is reused). Rows are visited grouped by artist, so each artist's
 * genre bonuses are built once.
 */
function scoreRows(
    rows: MatchTrack[],
    cols: MatchTrack[],
    model: GenreModel,
    genreWeightSq: number,
    onRow: (row: number, scores: Float64Array) => void,
): void {
    const n = cols.length;
    const dim = cols[0].sound.length;
    const sound = new Float64Array(n * dim);
    const feelV = new Float64Array(n);
    const feelA = new Float64Array(n);
    const slots = new Map<string, number>();
    const slotOf = (artistId: string) => {
        if (!slots.has(artistId)) slots.set(artistId, slots.size);
        return slots.get(artistId)!;
    };
    const colArtist = new Int32Array(n);
    cols.forEach((t, j) => {
        sound.set(t.sound, j * dim);
        feelV[j] = t.feel[0];
        feelA[j] = t.feel[1];
        colArtist[j] = slotOf(t.artistId);
    });
    const rowArtist = Int32Array.from(rows, (t) => slotOf(t.artistId));

    const bonusRows = new Map<number, Float64Array>();
    const bonusRow = (row: number): Float64Array => {
        let bonus = bonusRows.get(rowArtist[row]);
        if (!bonus) {
            bonus = new Float64Array(slots.size);
            for (const [artistId, b] of artistBonuses([{ track: rows[row], weight: 1 }], model, genreWeightSq)) {
                const slot = slots.get(artistId);
                if (slot !== undefined) bonus[slot] = b;
            }
            bonusRows.set(rowArtist[row], bonus);
        }
        return bonus;
    };

    const feelSq = FEEL_WEIGHT * FEEL_WEIGHT;
    const scores = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const order = rows.map((_, i) => i).sort((x, y) => rowArtist[x] - rowArtist[y]);

    for (let b = 0; b < order.length; b += 4) {
        const block = order.slice(b, b + 4);
        for (const slot of bonusRows.keys()) {
            if (!block.some((i) => rowArtist[i] === slot)) bonusRows.delete(slot);
        }
        const [i0, i1, i2, i3] = [0, 1, 2, 3].map((q) => block[Math.min(q, block.length - 1)]);
        const [r0, r1, r2, r3] = [i0, i1, i2, i3].map((i) => rows[i].sound);
        const [f0, f1, f2, f3] = [i0, i1, i2, i3].map((i) => rows[i].feel);
        const [g0, g1, g2, g3] = [i0, i1, i2, i3].map(bonusRow);
        const [s0, s1, s2, s3] = scores;
        for (let j = 0; j < n; j++) {
            const o = j * dim;
            let a0 = 0;
            let a1 = 0;
            let a2 = 0;
            let a3 = 0;
            for (let d = 0; d < dim; d++) {
                const x = sound[o + d];
                a0 += r0[d] * x;
                a1 += r1[d] * x;
                a2 += r2[d] * x;
                a3 += r3[d] * x;
            }
            const v = feelV[j];
            const a = feelA[j];
            const slot = colArtist[j];
            s0[j] = a0 + feelSq * (f0[0] * v + f0[1] * a) + g0[slot];
            s1[j] = a1 + feelSq * (f1[0] * v + f1[1] * a) + g1[slot];
            s2[j] = a2 + feelSq * (f2[0] * v + f2[1] * a) + g2[slot];
            s3[j] = a3 + feelSq * (f3[0] * v + f3[1] * a) + g3[slot];
        }
        block.forEach((row, q) => onRow(row, scores[q]));
    }
}

/** Indices of the `size` best scores, best first, equal scores in id order; `skip` is never chosen. */
function topIndices(scores: Float64Array, idRank: Int32Array, size: number, skip: number): number[] {
    const worse = (x: number, y: number) => scores[x] < scores[y] || (scores[x] === scores[y] && idRank[x] > idRank[y]);
    const heap: number[] = [];
    const siftDown = (i: number) => {
        for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < heap.length && worse(heap[l], heap[m])) m = l;
            if (r < heap.length && worse(heap[r], heap[m])) m = r;
            if (m === i) return;
            [heap[i], heap[m]] = [heap[m], heap[i]];
            i = m;
        }
    };
    for (let j = 0; j < scores.length; j++) {
        if (j === skip) continue;
        if (heap.length < size) {
            heap.push(j);
            for (let i = heap.length - 1; i > 0; ) {
                const p = (i - 1) >> 1;
                if (!worse(heap[i], heap[p])) break;
                [heap[i], heap[p]] = [heap[p], heap[i]];
                i = p;
            }
        } else if (worse(heap[0], j)) {
            heap[0] = j;
            siftDown(0);
        }
    }
    return heap.sort((x, y) => (worse(x, y) ? 1 : worse(y, x) ? -1 : 0));
}

/** Up to `k` neighbours per track, as [track id, score], best first, capped with the track itself counted. */
export function neighbourLists(tracks: MatchTrack[], model: GenreModel, genreWeightSq: number, k: number): NeighbourLists {
    const lists: NeighbourLists = new Map();
    if (tracks.length < 2) {
        for (const t of tracks) lists.set(t.trackId, []);
        return lists;
    }
    const idRank = idOrder(tracks);
    scoreRows(tracks, tracks, model, genreWeightSq, (row, scores) => {
        const seed = tracks[row];
        for (let pool = FIRST_POOL; ; pool *= 2) {
            const size = Math.min(pool, tracks.length - 1);
            const ranked = topIndices(scores, idRank, size, row).map((index) => ({
                index,
                albumId: tracks[index].albumId,
                artistId: tracks[index].artistId,
            }));
            const picked = capList(ranked, [seed], k);
            if (picked.length === k || size === tracks.length - 1) {
                lists.set(seed.trackId, picked.map((c) => [tracks[c.index].trackId, scores[c.index]]));
                return;
            }
        }
    });
    return lists;
}

/**
 * Each row track's `k` nearest column tracks by the formula, with no album or artist rule. When the rows are the
 * columns, a track is never its own neighbour.
 */
export function nearestColumns(
    rows: MatchTrack[],
    cols: MatchTrack[],
    model: GenreModel,
    genreWeightSq: number,
    k: number,
    sameSet: boolean,
): NearestColumns {
    const size = Math.min(k, cols.length - (sameSet ? 1 : 0));
    const idx = new Int32Array(rows.length * size);
    const score = new Float64Array(rows.length * size);
    let maxScore = -Infinity;
    const idRank = idOrder(cols);
    scoreRows(rows, cols, model, genreWeightSq, (row, scores) => {
        const skip = sameSet ? row : -1;
        for (let j = 0; j < scores.length; j++) if (j !== skip && scores[j] > maxScore) maxScore = scores[j];
        topIndices(scores, idRank, size, skip).forEach((j, r) => {
            idx[row * size + r] = j;
            score[row * size + r] = scores[j];
        });
    });
    return { k: size, idx, score, maxScore };
}

/** `neighbourLists` in a worker thread, so a large library's arithmetic never holds up requests. */
export function neighbourListsInWorker(
    tracks: MatchTrack[],
    model: GenreModel,
    genreWeightSq: number,
    k: number,
): Promise<NeighbourLists> {
    return runInWorker(__filename, "neighbourLists", [tracks, model, genreWeightSq, k]);
}
