"""
Writes the fixture the backend's map tests compare the layout code against
(backend/src/services/matching/__tests__/fixtures/map-parity.json).

A small synthetic point set (made-up numbers, no real data) goes through umap-learn's own
functions for every deterministic step the backend reproduces: each point's neighbourhood
scale (smooth_knn_dist), edge strengths and the fuzzy union (fuzzy_simplicial_set), the
curve constants (find_ab_params) and a new point's start (smooth_knn_dist with local
connectivity 0, compute_membership_strengths, init_graph_transform); and scikit-learn's PCA
for the start's main axes, on one set narrower and one wider than the backend's search.

    uv run --no-project --python 3.12 --with numpy --with scipy --with scikit-learn \
        --with umap-learn python map_parity_fixture.py [output path]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import scipy.sparse
from sklearn.decomposition import PCA
from umap.umap_ import (
    compute_membership_strengths,
    find_ab_params,
    fuzzy_simplicial_set,
    init_graph_transform,
    smooth_knn_dist,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', '..', 'backend', 'src', 'services', 'matching', '__tests__', 'fixtures', 'map-parity.json')
N, NEW, DIM, K, EPOCHS = 40, 6, 8, 7, 500


def knn(query, base, k):
    """Each query's k nearest base points, nearest first (a point among its own base finds itself first)."""
    d = np.linalg.norm(query[:, None, :] - base[None, :, :], axis=2)
    order = np.argsort(d, axis=1, kind='stable')[:, :k]
    return order.astype(np.int64), np.take_along_axis(d, order, 1)


def main() -> None:
    rng = np.random.default_rng(1101)
    points = rng.normal(size=(N, DIM))
    points[:5] *= 0.2
    idx, dist = knn(points, points, K)
    sigmas, rhos = smooth_knn_dist(dist.astype(np.float32), float(K), local_connectivity=1.0)
    graph, _, _ = fuzzy_simplicial_set(points, K, np.random.RandomState(0), 'euclidean',
                                       knn_indices=idx, knn_dists=dist.astype(np.float32))
    graph = graph.tocoo()
    graph.sum_duplicates()
    order = np.lexsort((graph.col, graph.row))
    rows, cols, vals = graph.row[order], graph.col[order], graph.data[order]
    keep = vals >= vals.max() / EPOCHS
    a, b = find_ab_params(1.0, 0.1)

    new = rng.normal(size=(NEW, DIM))
    nidx, ndist = knn(new, points, K)
    nsig, nrho = smooth_knn_dist(ndist.astype(np.float32), float(K), local_connectivity=0.0)
    r, c, v, _ = compute_membership_strengths(nidx, ndist.astype(np.float32), nsig, nrho, bipartite=True)
    embedding = rng.uniform(0, 10, size=(N, 3)).astype(np.float32)
    start = init_graph_transform(scipy.sparse.coo_matrix((v, (r, c)), shape=(NEW, N)).tocsr(), embedding)

    scores = PCA(3, svd_solver='full').fit_transform(points)
    wide = rng.normal(size=(60, 30)) * np.linspace(3.0, 0.3, 30)
    wide_scores = PCA(3, svd_solver='full').fit_transform(wide)

    fixture = {
        'source': 'services/audio-analyzer-clap/eval/map_parity_fixture.py (synthetic data)',
        'k': K, 'epochs': EPOCHS,
        'knnIdx': idx.tolist(), 'knnDist': dist.tolist(),
        'sigma': [float(x) for x in sigmas], 'rho': [float(x) for x in rhos],
        'graph': {'head': rows[keep].tolist(), 'tail': cols[keep].tolist(), 'weight': [float(x) for x in vals[keep]]},
        'a': float(a), 'b': float(b),
        'transform': {
            'knnIdx': nidx.tolist(), 'knnDist': ndist.tolist(),
            'sigma': [float(x) for x in nsig], 'rho': [float(x) for x in nrho],
            'weight': [float(x) for x in v],
            'embedding': embedding.astype(np.float64).tolist(), 'start': start.astype(np.float64).tolist(),
        },
        'pca': [
            {'points': points.tolist(), 'scores': scores.tolist()},
            {'points': wide.tolist(), 'scores': wide_scores.tolist()},
        ],
    }
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w') as f:
        json.dump(fixture, f)
    print(f'{N} points, {int(keep.sum())} edges, a {a:.6f} b {b:.6f}; wrote {os.path.normpath(out)}')


if __name__ == '__main__':
    main()
