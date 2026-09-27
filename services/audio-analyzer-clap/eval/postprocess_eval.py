#!/usr/bin/env python3
"""
Post-processing experiments on the CACHED v1 embeddings: can a transform
applied after the shipped CLAP model make "similar" agree better with people?

No audio is decoded and no model is run: this reads the vectors that
vibe_eval.py cached under eval/.cache/emb/ plus each set's labels, applies a
transform, and re-scores with the same metrics (metrics.py) as the baseline.

    uv run --no-project --with numpy --with scipy python postprocess_eval.py \
        [--data <data root>] [--out results/postprocess-<date>.json]

Needs only numpy + scipy (no model, no onnxruntime); about 2 minutes. Results
and the conclusion are in README.md, "Post-processing experiments".

What a "library" means here. In Kima the statistics (mean vector, covariance,
neighbour radii) come from the user's own library. In this experiment each
evaluation set plays that library: its statistics are computed from its own
clips, without labels (transductive, exactly what Kima would do). A second
condition, "foreign", computes them from the union of the OTHER sets, which
stands in for a cold start / a library whose mix differs from the tracks being
compared.

Overfitting guard. The 446 triplets are split once (fixed seed) into halves A
and B. Each family's parameter is picked on half A only; the pick is then
reported on half B and on the valence/arousal sets, none of which took part
in the choice.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import datasets as D  # noqa: E402
import metrics as M  # noqa: E402

DEFAULT_DATA = os.getenv('KIMA_EVAL_DATA', os.path.join(HERE, '.cache', 'data'))
V1_CACHE = os.path.join(HERE, '.cache', 'emb', 'v1-model37df17afb988-recipeb4c5cac9181b')
RATING_SETS = ['soundtracks_set1', 'soundtracks_set2', 'deam', 'merge', 'memo2496', 'pmemo']
SPLIT_SEED = 20260924


def l2n(X: np.ndarray) -> np.ndarray:
    return X / np.linalg.norm(X, axis=1, keepdims=True)


# ---------------------------------------------------------------------------
# Library statistics and transforms. Every transform maps (library L, items X)
# to a similarity matrix over X, so vector transforms and similarity-level
# re-scorings (CSLS, mutual proximity) are scored identically.
# ---------------------------------------------------------------------------
def pca(L: np.ndarray):
    mu = L.mean(0)
    C = np.cov(L - mu, rowvar=False)
    w, V = np.linalg.eigh(C)
    order = np.argsort(w)[::-1]
    return mu, w[order], V[:, order]


def vec_transform(kind: str, p, L: np.ndarray, X: np.ndarray) -> np.ndarray:
    if kind == 'none':
        return l2n(X)
    if kind == 'dba':  # database-side augmentation / alpha-QE (Radenovic et al. 2018), alpha = 3
        Xn, Ln = l2n(X), l2n(L)
        S = Xn @ Ln.T
        S[_self_mask(X, L)] = -np.inf
        nb = np.argsort(-S, axis=1)[:, :p]
        wts = np.clip(np.take_along_axis(S, nb, 1), 0, None) ** 3
        return l2n(Xn + (wts[:, :, None] * Ln[nb]).sum(1))
    mu, w, V = pca(L)
    Xc = X - mu
    if kind == 'center':
        return l2n(Xc)
    if kind == 'abtt':  # all-but-the-top: centre, then drop the top p principal directions
        U = V[:, :p]
        return l2n(Xc - (Xc @ U) @ U.T)
    if kind == 'whiten':  # PCA whitening, keep top p dims (Su et al. 2021)
        W = V[:, :p] / np.sqrt(w[:p] + 1e-12)
        return l2n(Xc @ W)
    if kind == 'shrinkwhiten':  # (Sigma + a*mean_eig*I)^(-1/2), full rank, a = p
        lam = np.maximum(w, 0) + p * w.mean()
        W = V / np.sqrt(lam)
        return l2n(Xc @ W)
    if kind == 'pcatrunc':  # centre, keep only the top p principal directions (no rescaling)
        return l2n(Xc @ V[:, :p])
    if kind == 'power':  # centre, scale each PC by (eig/mean eig)^(p/20): p>0 sharpens the top PCs
        return l2n((Xc @ V) * (np.maximum(w, 1e-12) / w.mean()) ** (p / 20))
    raise ValueError(kind)


def sim_matrix(method: str, p, L: np.ndarray, X: np.ndarray, k_hub: int = 10) -> np.ndarray:
    """Similarity over X given library L. method = '<vec>' or '<vec>+csls' or '<vec>+mp'."""
    vec, _, post = method.partition('+')
    vkind, _, vp = vec.partition(':')
    vp = int(vp) if vp else None
    Z = vec_transform(vkind, vp, L, X)
    ZL = vec_transform(vkind, vp, L, L)
    S = Z @ Z.T
    if not post:
        return S
    SL = Z @ ZL.T  # items vs library
    same = _self_mask(X, L)
    SL = np.where(same, -np.inf, SL)
    if post == 'csls':  # Conneau et al. 2018: 2cos(x,y) - r(x) - r(y), r = mean sim to k library NNs
        kk = p or k_hub
        r = np.sort(SL, axis=1)[:, -kk:].mean(1)
        return 2 * S - r[:, None] - r[None, :]
    if post == 'mp':  # Schnitzer et al. 2012, Gaussian mutual proximity on distances d = 1 - sim
        Dl = 1 - np.where(np.isfinite(SL), SL, np.nan)
        m, s = np.nanmean(Dl, 1), np.nanstd(Dl, 1)
        Dm = 1 - S
        px = stats.norm.sf(Dm, loc=m[:, None], scale=s[:, None])
        py = stats.norm.sf(Dm, loc=m[None, :], scale=s[None, :])
        return px * py
    raise ValueError(post)


def _self_mask(X: np.ndarray, L: np.ndarray) -> np.ndarray:
    """True where an item is (numerically) the same vector as a library row, so
    an item never counts itself among its own library neighbours."""
    if X.shape == L.shape and np.shares_memory(X, L):
        return np.eye(len(X), dtype=bool)
    return (l2n(X) @ l2n(L).T) > 1 - 1e-7


# ---------------------------------------------------------------------------
# Scoring on a precomputed similarity matrix (same rules as metrics.py)
# ---------------------------------------------------------------------------
def triplet_hits_S(S: np.ndarray, idx: dict[str, int], trips) -> np.ndarray:
    out = []
    for a, b, c, odd in trips:
        ia, ib, ic = idx[a], idx[b], idx[c]
        sims = [S[ib, ic], S[ia, ic], S[ia, ib]]
        out.append(1.0 if int(np.argmax(sims)) == odd else 0.0)
    return np.array(out)


def knn_pred_S(S: np.ndarray, y: np.ndarray, groups, k: int = 10) -> np.ndarray:
    S = S.astype(float).copy()
    np.fill_diagonal(S, -np.inf)
    if groups is not None:
        S[groups[:, None] == groups[None, :]] = -np.inf
    nb = np.argpartition(-S, k, axis=1)[:, :k]
    return y[nb].mean(1)


def hubness(S: np.ndarray, k: int = 10) -> dict:
    """Skewness of the k-occurrence distribution (Radovanovic et al. 2010) and
    the share of all neighbour slots taken by the top 1% of items."""
    S = S.astype(float).copy()
    np.fill_diagonal(S, -np.inf)
    nb = np.argpartition(-S, k, axis=1)[:, :k]
    N = np.bincount(nb.ravel(), minlength=len(S))
    top = np.sort(N)[::-1][:max(1, len(S) // 100)].sum() / N.sum()
    return {'skew_N10': float(stats.skew(N)), 'top1pct_share': float(top),
            'never_a_neighbour': float((N == 0).mean())}


def paired_r_delta(pa: np.ndarray, pb: np.ndarray, y: np.ndarray, n_boot: int = 2000) -> dict:
    """r(pa, y) - r(pb, y) with a paired bootstrap over clips."""
    rng = np.random.default_rng(M.SEED)
    d0 = np.corrcoef(pa, y)[0, 1] - np.corrcoef(pb, y)[0, 1]
    n = len(y)
    ds = np.empty(n_boot)
    for i in range(n_boot):
        j = rng.integers(0, n, n)
        ds[i] = np.corrcoef(pa[j], y[j])[0, 1] - np.corrcoef(pb[j], y[j])[0, 1]
    return {'delta_r': float(d0), 'ci95': [float(np.percentile(ds, 2.5)), float(np.percentile(ds, 97.5))]}


# ---------------------------------------------------------------------------
def load_all(data_root: str):
    sets = {}
    for name in ['mtt_triplets'] + RATING_SETS:
        es = D.LOADERS[name](data_root)
        z = np.load(os.path.join(V1_CACHE, f'{name}.npz'))
        emb = {str(k): v for k, v in zip(z['ids'], z['emb'])}
        ids = [i for i in es.ids if i in emb]
        sets[name] = (es, ids, np.vstack([emb[i] for i in ids]).astype(np.float64))
    return sets


FAMILIES = {
    'center': ['center'],
    'abtt': [f'abtt:{d}' for d in (1, 2, 3, 5, 8, 12, 20)],
    'whiten': [f'whiten:{k}' for k in (16, 32, 64, 96, 128, 192, 256, 384, 512)],
    'shrinkwhiten': [f'shrinkwhiten:{a}' for a in (1, 2, 4, 8)],  # penalty a x mean eigenvalue
    'pcatrunc': [f'pcatrunc:{k}' for k in (8, 16, 32, 64, 128, 256)],
    'power': [f'power:{b}' for b in (-5, 2, 5, 10)],  # exponent b/20 on eigenvalue ratio
    'dba': [f'dba:{k}' for k in (1, 2, 3, 5, 10)],
    'csls': ['none+csls', 'center+csls'],
    'mp': ['none+mp', 'center+mp'],
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=DEFAULT_DATA)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    sets = load_all(args.data)
    es_m, ids_m, E_m = sets['mtt_triplets']
    idx_m = {k: i for i, k in enumerate(ids_m)}
    trips = [t for t in es_m.triplets if all(x in idx_m for x in t[:3])]
    rng = np.random.default_rng(SPLIT_SEED)
    half = rng.permutation(len(trips)) < len(trips) // 2  # True = half A (selection)

    def foreign_lib(name: str) -> np.ndarray:
        return np.vstack([E for n, (_, _, E) in sets.items() if n != name])

    methods = ['none'] + [m for fam in FAMILIES.values() for m in fam]
    rep: dict = {'n_triplets': len(trips), 'half_A': int(half.sum()), 'half_B': int((~half).sum()),
                 'methods': {}}

    # Direction of the library mean: how anisotropic is the space, and how
    # much does the mean differ between collections?
    means = {n: E.mean(0) for n, (_, _, E) in sets.items()}
    rep['anisotropy'] = {
        n: {'norm_of_mean_of_unit_vectors': float(np.linalg.norm(means[n])),
            'mean_pairwise_cosine': float(((E @ E.T).sum() - len(E)) / (len(E) * (len(E) - 1))),
            'top1_pc_variance_share': float(pca(E)[1][0] / pca(E)[1].sum()),
            'top10_pc_variance_share': float(pca(E)[1][:10].sum() / pca(E)[1].sum())}
        for n, (_, _, E) in sets.items()}
    names = list(means)
    rep['cosine_between_library_means'] = {
        f'{a}|{b}': float(means[a] @ means[b] / np.linalg.norm(means[a]) / np.linalg.norm(means[b]))
        for i, a in enumerate(names) for b in names[i + 1:]}

    base_hits = {}
    base_pred = {}
    for method in methods:
        r: dict = {}
        for cond in ('own', 'foreign'):
            if method == 'none' and cond == 'foreign':
                continue
            L = E_m if cond == 'own' else foreign_lib('mtt_triplets')
            S = sim_matrix(method, None, L, E_m)
            hits = triplet_hits_S(S, idx_m, trips)
            if method == 'none':
                base_hits = hits
            rc = {'all': M.triplet_score(hits), 'A': M.triplet_score(hits[half]),
                  'B': M.triplet_score(hits[~half]),
                  'vs_baseline_all': M.paired_difference(hits, base_hits),
                  'vs_baseline_B': M.paired_difference(hits[~half], base_hits[~half]),
                  'hubness_mtt': hubness(S)}
            for name in RATING_SETS:
                es, ids, E = sets[name]
                keep = [es.ids.index(i) for i in ids]
                groups = es.groups[keep] if es.groups is not None else None
                Lr = E if cond == 'own' else foreign_lib(name)
                Sr = sim_matrix(method, None, Lr, E)
                for dim, y_all in es.ratings.items():
                    y = y_all[keep]
                    pred = knn_pred_S(Sr, y, groups)
                    key = f'{name}.{dim}'
                    if method == 'none':
                        base_pred[key] = pred
                    rc[key] = {'knn10_r': M.pearson(pred, y)['r'],
                               'knn10_ci95': M.pearson(pred, y)['ci95'],
                               'vs_baseline': paired_r_delta(pred, base_pred[key], y)}
            r[cond] = rc
            print(f"{method:22s} {cond:7s} trip all {rc['all']['rate']:.3f} A {rc['A']['rate']:.3f} "
                  f"B {rc['B']['rate']:.3f} McN p {rc['vs_baseline_all']['mcnemar_exact_p']:.3f} "
                  f"skew {rc['hubness_mtt']['skew_N10']:.2f} | "
                  + ' '.join(f"{k.split('.')[0][:5]}.{k.split('.')[1][:3]} {v['vs_baseline']['delta_r']:+.3f}"
                             for k, v in rc.items() if isinstance(v, dict) and 'vs_baseline' in v),
                  flush=True)
        rep['methods'][method] = r

    # Selection on half A only, per family (own-library condition).
    rep['selection'] = {}
    for fam, members in FAMILIES.items():
        best = max(members, key=lambda mm: (rep['methods'][mm]['own']['A']['rate'], -members.index(mm)))
        rep['selection'][fam] = {'picked_on_A': best,
                                 'A': rep['methods'][best]['own']['A']['rate'],
                                 'B': rep['methods'][best]['own']['B']['rate'],
                                 'B_vs_baseline': rep['methods'][best]['own']['vs_baseline_B']}
    for fam, s in rep['selection'].items():
        d = s['B_vs_baseline']
        print(f"[select] {fam}: {s['picked_on_A']} A={s['A']:.3f} -> B={s['B']:.3f} "
              f"(B delta {d['delta']:+.3f} [{d['ci95_bootstrap'][0]:+.3f},{d['ci95_bootstrap'][1]:+.3f}] "
              f"McN p {d['mcnemar_exact_p']:.3f})")
    base = rep['methods']['none']['own']
    print(f"[baseline] all {base['all']['rate']:.3f} A {base['A']['rate']:.3f} B {base['B']['rate']:.3f}")

    out = args.out or os.path.join(HERE, '.cache', 'postprocess-results.json')
    with open(out, 'w') as f:
        json.dump(rep, f, indent=1)
    print('wrote', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
