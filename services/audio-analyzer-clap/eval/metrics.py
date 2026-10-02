"""
Scores from embeddings and human judgments, each with n and a 95% interval:
Wilson + exact binomial for proportions, Fisher z for correlations, exact
McNemar + paired bootstrap (10,000, fixed seed) for model differences.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
from scipy import stats

Z95 = 1.959963984540054
N_BOOT = 10_000
SEED = 20260924


def wilson(k: int, n: int) -> dict:
    ci = stats.binomtest(k, n).proportion_ci(confidence_level=0.95, method='wilson')
    return {'k': int(k), 'n': int(n), 'rate': k / n if n else float('nan'),
            'ci95': [float(ci.low), float(ci.high)]}


def pearson(x: np.ndarray, y: np.ndarray) -> dict:
    n = len(x)
    r = float(np.corrcoef(x, y)[0, 1])
    z = math.atanh(max(min(r, 0.999999), -0.999999))
    se = 1.0 / math.sqrt(n - 3)
    p = float(stats.pearsonr(x, y).pvalue)
    return {'r': r, 'n': n, 'ci95': [math.tanh(z - Z95 * se), math.tanh(z + Z95 * se)], 'p': p}


# --------------------------------------------------------------------------
# (a) triplet agreement -- the similarity question itself
# --------------------------------------------------------------------------
def triplet_hits(emb: dict[str, np.ndarray], triplets) -> np.ndarray:
    """1 where the model's odd one out matches the humans' majority, else 0.

    The model's odd one out is the clip whose removal leaves the most similar
    (highest cosine) pair -- identical to the rule behind the new engine's
    446-triplet 67.0% figure."""
    hits = []
    for a, b, c, odd in triplets:
        ea, eb, ec = emb[a], emb[b], emb[c]
        sims = [float(eb @ ec), float(ea @ ec), float(ea @ eb)]  # pair left if 0/1/2 is removed
        hits.append(1.0 if int(np.argmax(sims)) == odd else 0.0)
    return np.array(hits)


def triplet_score(hits: np.ndarray) -> dict:
    k, n = int(hits.sum()), len(hits)
    out = wilson(k, n)
    out['chance'] = 1 / 3
    out['p_vs_chance'] = float(stats.binomtest(k, n, 1 / 3, alternative='greater').pvalue)
    return out


def paired_difference(a: np.ndarray, b: np.ndarray) -> dict:
    """a - b on the same items (both 0/1 hit vectors)."""
    d = a - b
    rng = np.random.default_rng(SEED)
    idx = rng.integers(0, len(d), size=(N_BOOT, len(d)))
    boots = d[idx].mean(axis=1)
    only_a, only_b = int(((a == 1) & (b == 0)).sum()), int(((a == 0) & (b == 1)).sum())
    p = float(stats.binomtest(only_a, only_a + only_b, 0.5).pvalue) if only_a + only_b else 1.0
    return {'delta': float(d.mean()), 'n': len(d),
            'ci95_bootstrap': [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
            'only_first_right': only_a, 'only_second_right': only_b, 'mcnemar_exact_p': p}


# --------------------------------------------------------------------------
# (b) continuous ratings -- neighbours and a linear probe
# --------------------------------------------------------------------------
def knn_agreement(E: np.ndarray, y: np.ndarray, groups: Optional[np.ndarray], k: int = 10) -> dict:
    """Predict each clip's rating as the mean of its k nearest neighbours
    (cosine, excluding its own group) and correlate with the true rating."""
    S = E @ E.T
    np.fill_diagonal(S, -np.inf)
    if groups is not None:
        S[groups[:, None] == groups[None, :]] = -np.inf
    nb = np.argpartition(-S, k, axis=1)[:, :k]
    pred = y[nb].mean(axis=1)
    out = pearson(pred, y)
    out['k'] = k
    out['excludes_same_group'] = groups is not None
    return out


def _folds(n: int, groups: Optional[np.ndarray], n_folds: int = 5) -> np.ndarray:
    """Fold index per item; whole groups stay in one fold (largest-first fill)."""
    rng = np.random.default_rng(SEED)
    if groups is None:
        f = np.arange(n) % n_folds
        rng.shuffle(f)
        return f
    uniq, inv, counts = np.unique(groups, return_inverse=True, return_counts=True)
    order = sorted(range(len(uniq)), key=lambda g: (-counts[g], rng.random()))
    load = np.zeros(n_folds)
    gfold = np.zeros(len(uniq), dtype=int)
    for g in order:
        gfold[g] = int(np.argmin(load))
        load[gfold[g]] += counts[g]
    return gfold[inv]


ALPHAS = np.logspace(-3, 3, 13)


def _ridge_fit(X: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Ridge with the penalty chosen by exact leave-one-out error on the
    training rows only (closed form via SVD)."""
    xm, ym = X.mean(0), y.mean()
    Xc, yc = X - xm, y - ym
    U, s, Vt = np.linalg.svd(Xc, full_matrices=False)
    Uy = U.T @ yc
    n = len(y)
    best = (np.inf, None)
    for a in ALPHAS:
        f = s ** 2 / (s ** 2 + a)
        yhat = U @ (f * Uy)
        h = (U ** 2) @ f + 1.0 / n
        loo = np.mean(((yc - yhat) / (1 - h)) ** 2)
        if loo < best[0]:
            best = (loo, a)
    a = best[1]
    w = Vt.T @ ((s / (s ** 2 + a)) * Uy)
    return w, float(ym - xm @ w), float(a)


def probe_oof(E: np.ndarray, y: np.ndarray, groups: Optional[np.ndarray]) -> np.ndarray:
    """Out-of-fold ridge predictions (5 folds, grouped when groups exist)."""
    folds = _folds(len(y), groups)
    pred = np.zeros_like(y, dtype=float)
    for f in np.unique(folds):
        tr, te = folds != f, folds == f
        w, b, _ = _ridge_fit(E[tr], y[tr])
        pred[te] = E[te] @ w + b
    return pred


def probe_score(E: np.ndarray, y: np.ndarray, groups: Optional[np.ndarray]) -> tuple[dict, np.ndarray]:
    pred = probe_oof(E, y, groups)
    out = pearson(pred, y)
    out['folds'] = 5
    out['grouped'] = groups is not None
    return out, pred


# --------------------------------------------------------------------------
# Soundtracks Set 1 "blunt test" (the new engine's four checks), applied to
# the out-of-fold valence probe of this embedding
# --------------------------------------------------------------------------
BLUNT = [('TENDER', 'ANGER'), ('TENDER', 'FEAR'), ('HIGH VALENCE', 'LOW VALENCE'), ('HAPPY', 'SAD')]


def blunt_test(pred_valence: np.ndarray, true_valence: np.ndarray, target: list[str]) -> list[dict]:
    t = np.array(target)
    rows = []
    for hi, lo in BLUNT:
        a, b = pred_valence[t == hi], pred_valence[t == lo]
        ha, hb = true_valence[t == hi], true_valence[t == lo]
        tt = stats.ttest_ind(a, b, equal_var=False)
        diff = float(a.mean() - b.mean())
        se = math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
        dof = float(tt.df)
        q = float(stats.t.ppf(0.975, dof))
        rows.append({'check': f'{hi.lower()} above {lo.lower()}', 'n': [len(a), len(b)],
                     'pred_means': [float(a.mean()), float(b.mean())],
                     'pred_diff': diff, 'pred_diff_ci95': [diff - q * se, diff + q * se],
                     'welch_p': float(tt.pvalue),
                     'human_means': [float(ha.mean()), float(hb.mean())],
                     'passes': bool(diff > 0 and tt.pvalue < 0.05)})
    return rows


# --------------------------------------------------------------------------
# IsoVAT: does the medium version sit between low and high?
# --------------------------------------------------------------------------
def isovat_between(emb: dict[str, np.ndarray], ids: list[str], meta: dict) -> dict:
    """For each composed L/M/H trio, the low-high pair should be the farthest
    apart of the three pairs (the medium version lies between the extremes).
    Chance is 1/3. Scored per varied dimension and pooled."""
    trios: dict[tuple[str, int], dict[str, str]] = {}
    for i, key in enumerate(ids):
        trios.setdefault((meta['dim'][i], meta['set'][i]), {})[meta['level'][i]] = key
    per: dict[str, list[int]] = {}
    for (dim, _), lv in sorted(trios.items()):
        if set(lv) != {'L', 'M', 'H'} or any(lv[x] not in emb for x in 'LMH'):
            continue
        L, M, H = (emb[lv[x]] for x in 'LMH')
        d_lh, d_lm, d_mh = 1 - L @ H, 1 - L @ M, 1 - M @ H
        per.setdefault(dim, []).append(int(d_lh > d_lm and d_lh > d_mh))
    out = {}
    allhits = []
    for dim, hits in per.items():
        k, n = sum(hits), len(hits)
        out[dim] = wilson(k, n) | {'p_vs_chance': float(stats.binomtest(k, n, 1 / 3, alternative='greater').pvalue)}
        allhits += hits
    k, n = sum(allhits), len(allhits)
    out['pooled'] = wilson(k, n) | {'p_vs_chance': float(stats.binomtest(k, n, 1 / 3, alternative='greater').pvalue)}
    out['chance'] = 1 / 3
    return out
