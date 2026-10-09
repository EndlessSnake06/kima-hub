"""
Writes the fixture the backend's matching tests compare the engine against
(backend/src/services/matching/__tests__/fixtures/parity.json).

A small synthetic library (made-up vectors, ratings and genres, no real data) is
scored with the formula exactly as the 1.11 measurement computed it: `l2`, `spread`
and `tag_block` are copied unchanged from the measurement script, and the score is
its `LB_[i] @ LB_[j] + (k * w)^2 * G[i] @ G[j]` between different artists, kept in
float64. The fixture also carries the capped neighbour lists, weighted-set sums and
artist closeness the engine builds on that score.

    python3 matching_parity_fixture.py
"""
from __future__ import annotations

import json
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, '..', '..', '..', 'backend', 'src', 'services', 'matching')
OUT = os.path.join(BACKEND, '__tests__', 'fixtures', 'parity.json')

FEEL, GENRE = 0.25, 0.25
MAX_PER_ALBUM, MAX_PER_ARTIST, TOP = 2, 4, 10
DIM = 16


def l2(X):
    n = np.linalg.norm(X, axis=1, keepdims=True)
    return np.where(n > 0, X / np.where(n > 0, n, 1), 0)


def spread(X):
    return float(np.mean(((X - X.mean(0)) ** 2).sum(1)))


def tag_block(tags):
    vocab = sorted(set().union(*tags)) or ["_"]
    vi = {g: i for i, g in enumerate(vocab)}
    has = np.array([len(t) > 0 for t in tags])
    df = np.zeros(len(vocab))
    for t in tags:
        for g in t:
            df[vi[g]] += 1
    idf = np.log(max(has.sum(), 1) / np.maximum(df, 1))
    T = np.zeros((len(tags), len(vocab)))
    for r, t in enumerate(tags):
        for g in t:
            T[r, vi[g]] = idf[vi[g]]
    B = l2(T)
    if has.any():
        B[has] = l2(B[has] - B[has].mean(0))
    B[~has] = 0
    return B, has


norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())

ARTISTS = {
    'art_a': ['Rock', 'Synth-Pop', 'darkwave'],
    'art_b': ['rock', 'synthpop', 'new wave', 'not a genre'],
    'art_c': ['rock', 'Hip-Hop', 'hip hop', 'trap'],
    'art_d': ['rock', 'hypertechno', 'hyper techno', 'techno'],
    'art_e': ['rock'],
    'art_f': [],
    'art_g': ['made-up tag'],
    'art_h': ['rock', 'ambient', 'neoclassical', 'piano'],
}
ALBUMS = {'art_a': 3, 'art_b': 2, 'art_c': 2, 'art_d': 1, 'art_e': 2, 'art_f': 1, 'art_g': 1, 'art_h': 3}


def main() -> None:
    names = json.load(open(os.path.join(BACKEND, 'mbGenres.json')))['genres']
    mbg = {norm(n) for n in names}
    canon: dict[str, str] = {}
    for n in names:
        canon.setdefault(norm(n), n.lower())
    ld = lambda gs: {canon[norm(g)] for g in gs if isinstance(g, str) and norm(g) in mbg}

    rng = np.random.default_rng(1101)
    centre = {a: rng.normal(size=DIM) for a in ARTISTS}
    tracks = []
    for a, n_albums in ALBUMS.items():
        for b in range(n_albums):
            for t in range(int(rng.integers(2, 6))):
                vec = centre[a] + 0.8 * rng.normal(size=DIM)
                vec *= rng.uniform(0.5, 2.0)
                v, ar = rng.uniform(-0.2, 1.2, 2)
                tracks.append({
                    'id': f'trk_par_{a[-1]}{b}{t}',
                    'albumId': f'alb_par_{a[-1]}{b}',
                    'artistId': a,
                    'sound': [float(x) for x in vec],
                    'valence': float(np.clip(v, 0, 1)),
                    'arousal': float(np.clip(ar, 0, 1)),
                })
    n = len(tracks)
    E = np.array([t['sound'] for t in tracks])
    LE = l2(E)
    raw = np.array([[t['valence'], t['arousal']] for t in tracks])
    mu, sd = raw.mean(0), raw.std(0)
    F = l2((raw - mu) / sd)
    LB = np.hstack([LE, FEEL * F])
    art = np.array([t['artistId'] for t in tracks])
    G, _ = tag_block([ld(ARTISTS[a]) for a in art])
    vocab = sorted(set().union(*[ld(g) for g in ARTISTS.values()]))
    sp_c, sp_g = spread(LE), spread(G)
    wg = GENRE * np.sqrt(sp_c / sp_g)

    S = LB @ LB.T
    Sg = wg * wg * (G @ G.T)
    Sg[art[:, None] == art[None, :]] = 0
    S = S + Sg

    ids = [t['id'] for t in tracks]
    albums = [t['albumId'] for t in tracks]

    def capped(scores, counted, exclude, limit):
        per_album, per_artist = {}, {}
        for k in counted:
            per_album[albums[k]] = per_album.get(albums[k], 0) + 1
            per_artist[art[k]] = per_artist.get(art[k], 0) + 1
        order = sorted((j for j in range(n) if j not in exclude), key=lambda j: (-scores[j], ids[j]))
        out = []
        for j in order:
            if len(out) == limit:
                break
            if per_album.get(albums[j], 0) < MAX_PER_ALBUM and per_artist.get(art[j], 0) < MAX_PER_ARTIST:
                out.append(ids[j])
                per_album[albums[j]] = per_album.get(albums[j], 0) + 1
                per_artist[art[j]] = per_artist.get(art[j], 0) + 1
        return out

    sets = []
    for members, weights, counted in (
        ([0], [1.0], [0]),
        ([3, 17], [0.5, 0.5], [3, 17]),
        ([5, 30, 41], [1 / 2, 1 / 2, -1.0], [5, 30]),
        ([2, 9, 20, 33], [0.25, 0.25, 0.25, 0.25], [2, 9, 20, 33]),
    ):
        w = np.zeros(n)
        w[members] = weights
        total = S @ w
        sets.append({
            'inputs': [{'trackId': ids[k], 'weight': float(x)} for k, x in zip(members, weights)],
            'scores': [float(x) for x in total],
            'selfScore': float(w @ S @ w),
            'capped': capped(total, counted, set(members), TOP),
            'counted': [ids[k] for k in counted],
        })

    artist_rows = {a: np.where(art == a)[0] for a in ARTISTS}

    def closeness(a, b):
        A, B = artist_rows[a], artist_rows[b]
        cross = S[np.ix_(A, B)].mean()
        return float(cross / np.sqrt(S[np.ix_(A, A)].mean() * S[np.ix_(B, B)].mean()))

    pairs = [('art_a', 'art_b'), ('art_a', 'art_e'), ('art_c', 'art_f'), ('art_h', 'art_h')]
    fixture = {
        'source': 'services/audio-analyzer-clap/eval/matching_parity_fixture.py (synthetic data)',
        'artists': [{'artistId': a, 'genres': g} for a, g in ARTISTS.items()],
        'tracks': tracks,
        'feel': {'mean': [float(x) for x in mu], 'sd': [float(x) for x in sd]},
        'soundSpread': sp_c,
        'genreSpread': sp_g,
        'genreWeight': float(wg),
        'vocabulary': vocab,
        'genreVectors': {a: [float(x) for x in G[artist_rows[a][0]]] for a in ARTISTS},
        'scores': [[float(x) for x in row] for row in S],
        'neighbours': {ids[i]: capped(S[i], [i], {i}, TOP) for i in range(n)},
        'sets': sets,
        'artistMatch': [{'a': a, 'b': b, 'value': closeness(a, b)} for a, b in pairs],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(fixture, f)
    print(f'{n} tracks, vocabulary {vocab}, genre weight {wg:.4f}; wrote {os.path.normpath(OUT)}')


if __name__ == '__main__':
    main()
