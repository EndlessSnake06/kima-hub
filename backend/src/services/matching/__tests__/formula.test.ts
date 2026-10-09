/**
 * The engine's formula against the fixture written by the measurement's own code
 * (services/audio-analyzer-clap/eval/matching_parity_fixture.py), then the pieces
 * the engine adds on top: the caps, the weighted-set algebra and the arc weights.
 */
import fixture from "./fixtures/parity.json";
import {
    FEEL_WEIGHT,
    MAX_PER_ALBUM,
    MAX_PER_ARTIST,
    SELF_SCORE,
    artistBonuses,
    artistMatch,
    blendSelfScore,
    blendSoundFeel,
    buildGenreModel,
    capList,
    dot,
    feelVector,
    genreVector,
    genreWeight,
    pairScore,
    slerpWeights,
    unit,
    type FeelStats,
    type MatchTrack,
    type WeightedTrack,
} from "../formula";
import { neighbourLists, neighbourListsInWorker } from "../neighbours";
import { matchingGenres } from "../state";

const CLOSE = 12;

const raw = fixture.tracks.map((t) => [t.valence, t.arousal] as [number, number]);
const mean = (k: 0 | 1) => raw.reduce((s, r) => s + r[k], 0) / raw.length;
const sd = (k: 0 | 1, m: number) => Math.sqrt(raw.reduce((s, r) => s + (r[k] - m) ** 2, 0) / raw.length);
const stats: FeelStats = { mean: [mean(0), mean(1)], sd: [sd(0, mean(0)), sd(1, mean(1))] };

const tracks: MatchTrack[] = fixture.tracks.map((t) => ({
    trackId: t.id,
    albumId: t.albumId,
    artistId: t.artistId,
    sound: unit(t.sound),
    feel: feelVector([t.valence, t.arousal], stats),
}));
const byId = new Map(tracks.map((t) => [t.trackId, t]));

const trackCount = (artistId: string) => tracks.filter((t) => t.artistId === artistId).length;
const { model, spread } = buildGenreModel(
    fixture.artists.map((a) => ({ artistId: a.artistId, tracks: trackCount(a.artistId), genres: matchingGenres(a) })),
);

const meanSound = tracks[0].sound.map((_, d) => tracks.reduce((s, t) => s + t.sound[d], 0) / tracks.length);
const soundSpread = 1 - dot(meanSound, meanSound);
const wgSq = genreWeight(soundSpread, spread) ** 2;

function ranked(scores: (t: MatchTrack) => number, exclude: Set<string>) {
    return tracks
        .filter((t) => !exclude.has(t.trackId))
        .map((t) => ({ id: t.trackId, albumId: t.albumId, artistId: t.artistId, score: scores(t) }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

describe("the formula matches the measurement's code", () => {
    it("standardises feel with the library's mean and population SD", () => {
        expect(stats.mean[0]).toBeCloseTo(fixture.feel.mean[0], CLOSE);
        expect(stats.mean[1]).toBeCloseTo(fixture.feel.mean[1], CLOSE);
        expect(stats.sd[0]).toBeCloseTo(fixture.feel.sd[0], CLOSE);
        expect(stats.sd[1]).toBeCloseTo(fixture.feel.sd[1], CLOSE);
    });

    it("keeps MusicBrainz genres in one spelling and builds the same genre vectors", () => {
        expect(model.vocabulary).toEqual(fixture.vocabulary);
        for (const [artistId, expected] of Object.entries(fixture.genreVectors)) {
            const g = genreVector(model, artistId) ?? new Float64Array(model.vocabulary.length);
            expected.forEach((x, i) => expect(g[i]).toBeCloseTo(x, CLOSE));
        }
    });

    it("weights genre at 0.25 of sound's spread", () => {
        expect(soundSpread).toBeCloseTo(fixture.soundSpread, CLOSE);
        expect(spread).toBeCloseTo(fixture.genreSpread, CLOSE);
        expect(genreWeight(soundSpread, spread)).toBeCloseTo(fixture.genreWeight, CLOSE);
    });

    it("scores every pair the same", () => {
        tracks.forEach((a, i) =>
            tracks.forEach((b, j) => expect(pairScore(a, b, model, wgSq)).toBeCloseTo(fixture.scores[i][j], CLOSE)),
        );
    });

    it("gives each track the same capped neighbours", () => {
        for (const seed of tracks) {
            const list = capList(
                ranked((t) => pairScore(seed, t, model, wgSq), new Set([seed.trackId])),
                [seed],
                10,
            );
            expect(list.map((r) => r.id)).toEqual(fixture.neighbours[seed.trackId as keyof typeof fixture.neighbours]);
        }
    });

    it("gives the export the same neighbours and scores", () => {
        const lists = neighbourLists(tracks, model, wgSq, 10);
        tracks.forEach((seed, i) => {
            const list = lists.get(seed.trackId)!;
            expect(list.map(([id]) => id)).toEqual(fixture.neighbours[seed.trackId as keyof typeof fixture.neighbours]);
            for (const [id, score] of list) {
                const j = tracks.findIndex((t) => t.trackId === id);
                expect(score).toBeCloseTo(fixture.scores[i][j], CLOSE);
            }
        });
    });

    it("gives the export's worker thread the same lists as the direct call", async () => {
        // A Map from a worker thread is built outside Jest's sandbox; compare its entries.
        const fromWorker = await neighbourListsInWorker(tracks, model, wgSq, 10);
        expect(JSON.stringify([...fromWorker])).toBe(JSON.stringify([...neighbourLists(tracks, model, wgSq, 10)]));
    });

    it("scores a weighted set as the weighted sum of pair scores, one pass per set", () => {
        for (const set of fixture.sets) {
            const inputs: WeightedTrack[] = set.inputs.map((i) => ({ track: byId.get(i.trackId)!, weight: i.weight }));
            const { sound, feel } = blendSoundFeel(inputs);
            const bonus = artistBonuses(inputs, model, wgSq);
            const score = (t: MatchTrack) =>
                dot(t.sound, sound) +
                FEEL_WEIGHT * FEEL_WEIGHT * (t.feel[0] * feel[0] + t.feel[1] * feel[1]) +
                (bonus.get(t.artistId) ?? 0);
            tracks.forEach((t, k) => expect(score(t)).toBeCloseTo(set.scores[k], CLOSE));
            expect(blendSelfScore(inputs, model, wgSq)).toBeCloseTo(set.selfScore, CLOSE);
            const list = capList(
                ranked(score, new Set(set.inputs.map((i) => i.trackId))),
                set.counted.map((id) => byId.get(id)!),
                10,
            );
            expect(list.map((r) => r.id)).toEqual(set.capped);
        }
    });

    it("scores artists as the formula averaged over their track pairs", () => {
        const profile = (artistId: string) => {
            const own = tracks.filter((t) => t.artistId === artistId);
            const sound = own[0].sound.map((_, d) => own.reduce((s, t) => s + t.sound[d], 0) / own.length);
            const feel: [number, number] = [
                own.reduce((s, t) => s + t.feel[0], 0) / own.length,
                own.reduce((s, t) => s + t.feel[1], 0) / own.length,
            ];
            return { artistId, sound, feel };
        };
        for (const { a, b, value } of fixture.artistMatch) {
            expect(artistMatch(profile(a), profile(b), model, wgSq)).toBeCloseTo(value, CLOSE);
        }
    });
});

describe("capList", () => {
    const row = (id: string, albumId: string, artistId: string) => ({ id, albumId, artistId });

    it("counts the seed against its own artist: at most MAX_PER_ARTIST - 1 more", () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, `alb${i}`, "seedArtist"));
        expect(capList(rows, [{ albumId: "seedAlbum", artistId: "seedArtist" }], 20)).toHaveLength(MAX_PER_ARTIST - 1);
    });

    it("counts the seed against its own album: at most MAX_PER_ALBUM - 1 more", () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, "seedAlbum", `art${i}`));
        expect(capList(rows, [{ albumId: "seedAlbum", artistId: "seedArtist" }], 20)).toHaveLength(MAX_PER_ALBUM - 1);
    });

    it("counts every input: two added tracks from one album leave it no places", () => {
        const counted = [
            { albumId: "alb", artistId: "art" },
            { albumId: "alb", artistId: "art" },
        ];
        const rows = [row("x", "alb", "art"), row("y", "other", "art"), row("z", "other", "art"), row("w", "third", "art")];
        expect(capList(rows, counted, 10).map((r) => r.id)).toEqual(["y", "z"]);
    });

    it("stops at the limit", () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, `alb${i}`, `art${i}`));
        expect(capList(rows, [], 4).map((r) => r.id)).toEqual(["t0", "t1", "t2", "t3"]);
    });
});

describe("feelVector", () => {
    it("is zero on the library mean", () => {
        expect(feelVector([0.4, 0.6], { mean: [0.4, 0.6], sd: [0.1, 0.2] })).toEqual([0, 0]);
    });

    it("leaves out an axis on which every track is the same", () => {
        expect(feelVector([0.9, 0.3], { mean: [0.5, 0.3], sd: [0.1, 0] })).toEqual([1, 0]);
    });
});

describe("slerpWeights", () => {
    it("starts at the first track and ends at the second", () => {
        expect(slerpWeights(0.3, 0)).toEqual([1, 0]);
        const [w0, w1] = slerpWeights(0.3, 1);
        expect(w0).toBeCloseTo(0, CLOSE);
        expect(w1).toBeCloseTo(1, CLOSE);
    });

    it("keeps every point on the arc at the tracks' own length", () => {
        for (const cos of [-0.5, 0, 0.3, 0.9]) {
            for (const t of [0.2, 0.5, 0.8]) {
                const [w0, w1] = slerpWeights(cos, t);
                expect(w0 * w0 + w1 * w1 + 2 * w0 * w1 * cos).toBeCloseTo(1, CLOSE);
            }
        }
    });
});

describe("genreWeight", () => {
    it("is zero when no track has a genre", () => {
        expect(genreWeight(0.7, 0)).toBe(0);
    });
});

describe("SELF_SCORE", () => {
    it("is what a track with feel scores against itself", () => {
        const t = tracks[0];
        expect(pairScore(t, t, model, wgSq)).toBeCloseTo(SELF_SCORE, CLOSE);
    });
});
