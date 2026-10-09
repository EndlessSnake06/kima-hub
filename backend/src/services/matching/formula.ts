/**
 * The 1.11 matching formula as pure arithmetic:
 * sound, feel at 0.25, and artist genre at 0.25 counted only between different artists,
 * then at most 2 tracks per album and 4 per artist. The SQL pass, the export's
 * neighbour lists and the tests all score with these functions.
 */
import { log } from "./exactMath";

export const FEEL_WEIGHT = 0.25;
const GENRE_WEIGHT = 0.25;
export const MAX_PER_ALBUM = 2;
export const MAX_PER_ARTIST = 4;

/** What any track scores against itself: sound 1 plus feel 0.25², and no genre, being its own artist. */
export const SELF_SCORE = 1 + FEEL_WEIGHT * FEEL_WEIGHT;

export type Feel = [number, number];

export interface FeelStats {
    mean: Feel;
    sd: Feel;
}

/** A track as the formula sees it. `sound` is unit length; `feel` comes from `feelVector`. */
export interface MatchTrack {
    trackId: string;
    albumId: string;
    artistId: string;
    sound: Float64Array;
    feel: Feel;
}

export interface WeightedTrack {
    track: MatchTrack;
    weight: number;
}

/**
 * Artist genres as TF-IDF over the library, centred and made unit length. Each artist
 * with genres stores its TF-IDF entries and `norm = |tfidf − mean|`, so its genre
 * vector is `(tfidf − mean) / norm`.
 */
export interface GenreModel {
    vocabulary: string[];
    mean: number[];
    artists: Record<string, { index: number[]; weight: number[]; norm: number }>;
}

export interface LibraryArtist {
    artistId: string;
    tracks: number;
    genres: string[];
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

export function unit(values: ArrayLike<number>): Float64Array {
    const out = Float64Array.from(values);
    const n = Math.sqrt(dot(out, out));
    if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
    return out;
}

/**
 * Feel in the library's own terms: standardised per axis, then unit length; zero on
 * the library mean. An axis on which every track is the same carries nothing.
 */
export function feelVector(raw: Feel, stats: FeelStats): Feel {
    const v = stats.sd[0] > 0 ? (raw[0] - stats.mean[0]) / stats.sd[0] : 0;
    const a = stats.sd[1] > 0 ? (raw[1] - stats.mean[1]) / stats.sd[1] : 0;
    const n = Math.sqrt(v * v + a * a);
    return n > 0 ? [v / n, a / n] : [0, 0];
}

/**
 * Track-weighted TF-IDF over the artists' genres, centred on the mean of the tracks
 * that have genres. `spread` is the mean squared distance of every track's genre
 * vector from the library's mean genre vector, tracks without genres counting as zero.
 */
export function buildGenreModel(artists: LibraryArtist[]): { model: GenreModel; spread: number } {
    const totalTracks = artists.reduce((n, a) => n + a.tracks, 0);
    const tagged = artists
        .filter((a) => a.tracks > 0 && a.genres.length > 0)
        .sort((a, b) => (a.artistId < b.artistId ? -1 : a.artistId > b.artistId ? 1 : 0));
    const vocabulary = [...new Set(tagged.flatMap((a) => a.genres))].sort();
    const position = new Map(vocabulary.map((g, i) => [g, i]));
    const taggedTracks = tagged.reduce((n, a) => n + a.tracks, 0);

    const df = new Float64Array(vocabulary.length);
    for (const a of tagged) for (const g of a.genres) df[position.get(g)!] += a.tracks;
    const idf = Array.from(df, (d) => log(Math.max(taggedTracks, 1) / Math.max(d, 1)));

    const tfidf = tagged.map((a) => {
        const index = a.genres.map((g) => position.get(g)!);
        const raw = index.map((i) => idf[i]);
        const n = Math.sqrt(dot(raw, raw));
        return { artist: a, index, weight: raw.map((w) => (n > 0 ? w / n : 0)) };
    });

    const mean = new Array<number>(vocabulary.length).fill(0);
    for (const x of tfidf) {
        x.index.forEach((i, k) => (mean[i] += (x.artist.tracks * x.weight[k]) / taggedTracks));
    }

    const model: GenreModel = { vocabulary, mean, artists: {} };
    const sum = new Float64Array(vocabulary.length);
    let squares = 0;
    for (const x of tfidf) {
        const centred = Float64Array.from(mean, (m) => -m);
        x.index.forEach((i, k) => (centred[i] += x.weight[k]));
        const norm = Math.sqrt(dot(centred, centred));
        if (norm === 0) continue;
        model.artists[x.artist.artistId] = { index: x.index, weight: x.weight, norm };
        for (let i = 0; i < centred.length; i++) sum[i] += (x.artist.tracks * centred[i]) / norm;
        squares += x.artist.tracks;
    }
    const spread = totalTracks > 0 ? squares / totalTracks - dot(sum, sum) / (totalTracks * totalTracks) : 0;
    return { model, spread };
}

/** `w_g = 0.25 · √(spread_sound / spread_genre)`: genre gets 0.25² of sound's pull. */
export function genreWeight(soundSpread: number, genreSpread: number): number {
    return genreSpread > 0 ? GENRE_WEIGHT * Math.sqrt(soundSpread / genreSpread) : 0;
}

/** The artist's centred, unit-length genre vector over the model's vocabulary; null without genres. */
export function genreVector(model: GenreModel, artistId: string): Float64Array | null {
    const entry = model.artists[artistId];
    if (!entry) return null;
    const g = Float64Array.from(model.mean, (m) => -m);
    entry.index.forEach((i, k) => (g[i] += entry.weight[k]));
    for (let i = 0; i < g.length; i++) g[i] /= entry.norm;
    return g;
}

/**
 * The genre term of `Σ_i w_i · s(t, i)` for a track by each artist B with genres:
 * `w_g² · (g_B · Σ_i w_i g_A(i) − W_B)`, W_B the summed weight of the inputs by B,
 * which removes the term between an artist and itself. Artists absent from the map
 * have no genres, so their term is zero.
 */
export function artistBonuses(
    inputs: WeightedTrack[],
    model: GenreModel,
    genreWeightSq: number,
): Map<string, number> {
    const bonuses = new Map<string, number>();
    if (genreWeightSq === 0) return bonuses;
    const blended = new Float64Array(model.vocabulary.length);
    const weightByArtist = new Map<string, number>();
    for (const { track, weight } of inputs) {
        weightByArtist.set(track.artistId, (weightByArtist.get(track.artistId) ?? 0) + weight);
        const g = genreVector(model, track.artistId);
        if (g) for (let i = 0; i < g.length; i++) blended[i] += weight * g[i];
    }
    const meanDot = dot(model.mean, blended);
    for (const [artistId, x] of Object.entries(model.artists)) {
        let xDot = 0;
        x.index.forEach((i, k) => (xDot += x.weight[k] * blended[i]));
        const genreDot = (xDot - meanDot) / x.norm;
        bonuses.set(artistId, genreWeightSq * (genreDot - (weightByArtist.get(artistId) ?? 0)));
    }
    return bonuses;
}

/** `Σ_i w_i ĉ_i` and `Σ_i w_i v_i`, the sound and feel halves of a weighted input set. */
export function blendSoundFeel(inputs: WeightedTrack[]): { sound: Float64Array; feel: Feel } {
    const sound = new Float64Array(inputs[0].track.sound.length);
    const feel: Feel = [0, 0];
    for (const { track, weight } of inputs) {
        for (let i = 0; i < sound.length; i++) sound[i] += weight * track.sound[i];
        feel[0] += weight * track.feel[0];
        feel[1] += weight * track.feel[1];
    }
    return { sound, feel };
}

/** s(a, b): sound + 0.25² · feel + w_g² · genre when the artists differ. */
export function pairScore(a: MatchTrack, b: MatchTrack, model: GenreModel, genreWeightSq: number): number {
    let s = dot(a.sound, b.sound) + FEEL_WEIGHT * FEEL_WEIGHT * (a.feel[0] * b.feel[0] + a.feel[1] * b.feel[1]);
    if (a.artistId !== b.artistId && genreWeightSq > 0) {
        const ga = genreVector(model, a.artistId);
        const gb = genreVector(model, b.artistId);
        if (ga && gb) s += genreWeightSq * dot(ga, gb);
    }
    return s;
}

/** What a weighted input set scores against itself, `Σ_i Σ_j w_i w_j s(i, j)`: the squared length of the blend. */
export function blendSelfScore(inputs: WeightedTrack[], model: GenreModel, genreWeightSq: number): number {
    let total = 0;
    for (const a of inputs) {
        for (const b of inputs) total += a.weight * b.weight * pairScore(a.track, b.track, model, genreWeightSq);
    }
    return total;
}

/** An artist as the mean of its tracks: mean unit sound vector and mean feel vector. */
export interface ArtistProfile {
    artistId: string;
    sound: Float64Array;
    feel: Feel;
}

/**
 * The formula averaged over every track pair of two artists, normalised like a
 * cosine. For sound alone it is the cosine between the artists' centroids. Null when
 * an artist has no spread to normalise by.
 */
export function artistMatch(
    a: ArtistProfile,
    b: ArtistProfile,
    model: GenreModel,
    genreWeightSq: number,
): number | null {
    const feelSq = FEEL_WEIGHT * FEEL_WEIGHT;
    const self = (p: ArtistProfile) => dot(p.sound, p.sound) + feelSq * (p.feel[0] ** 2 + p.feel[1] ** 2);
    let cross = dot(a.sound, b.sound) + feelSq * (a.feel[0] * b.feel[0] + a.feel[1] * b.feel[1]);
    if (a.artistId !== b.artistId && genreWeightSq > 0) {
        const ga = genreVector(model, a.artistId);
        const gb = genreVector(model, b.artistId);
        if (ga && gb) cross += genreWeightSq * dot(ga, gb);
    }
    const norm = Math.sqrt(self(a) * self(b));
    return norm > 0 ? cross / norm : null;
}

/**
 * Walk a ranked list keeping at most MAX_PER_ALBUM per album and MAX_PER_ARTIST per
 * artist, each counted track (a seed, an added track) using one place in its own
 * album and artist, up to `limit`.
 */
export function capList<T extends { albumId: string; artistId: string }>(
    ranked: Iterable<T>,
    counted: Array<{ albumId: string; artistId: string }>,
    limit: number,
): T[] {
    const perAlbum = new Map<string, number>();
    const perArtist = new Map<string, number>();
    for (const c of counted) {
        perAlbum.set(c.albumId, (perAlbum.get(c.albumId) ?? 0) + 1);
        perArtist.set(c.artistId, (perArtist.get(c.artistId) ?? 0) + 1);
    }
    const out: T[] = [];
    for (const row of ranked) {
        if (out.length >= limit) break;
        const albumCount = perAlbum.get(row.albumId) ?? 0;
        const artistCount = perArtist.get(row.artistId) ?? 0;
        if (albumCount < MAX_PER_ALBUM && artistCount < MAX_PER_ARTIST) {
            out.push(row);
            perAlbum.set(row.albumId, albumCount + 1);
            perArtist.set(row.artistId, artistCount + 1);
        }
    }
    return out;
}

/**
 * Weights (w0, w1) for the point a fraction `t` of the way along the arc between two
 * tracks whose normalised similarity is `cosTheta`; straight-line weights when they
 * point the same way.
 */
export function slerpWeights(cosTheta: number, t: number): [number, number] {
    const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
    const sinTheta = Math.sin(theta);
    if (theta < 1e-6 || sinTheta === 0) return [1 - t, t];
    return [Math.sin((1 - t) * theta) / sinTheta, Math.sin(t * theta) / sinTheta];
}
