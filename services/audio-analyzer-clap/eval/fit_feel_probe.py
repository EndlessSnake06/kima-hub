"""
Fits the matching engine's feel probe on DEAM and writes it for the backend.

Per axis: StandardScaler then RidgeCV over logspace(-1, 3, 12) on the shipped
analyzer's sound vectors, target (rating - 1) / 8, the fit the 1.11 formula was
measured with. The scaler is folded into the ridge so the backend needs only
`clip(weights · unit_vector + bias, 0, 1)`; the script refuses to write a file
whose folded weights disagree with the fitted pipeline.

Run from this directory:

    uv run --no-project --python 3.12 --with-requirements ../requirements.txt \
        --with scikit-learn python fit_feel_probe.py --data <eval data root>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import datasets as D
import embedders as E

ALPHAS = np.logspace(-1, 3, 12)
DEFAULT_OUT = os.path.join(E.SERVICE_DIR, '..', '..', 'backend', 'src', 'services', 'matching',
                           'feelProbe.json')
SOURCE = ('Derived from DEAM (Aljanaki, Yang & Soleymani, "Developing a benchmark for emotional analysis '
          'of music", PLOS ONE 12(3): e0173392, 2017; https://cvml.unige.ch/databases/DEAM/), released by '
          'its authors under Creative Commons BY-NC. This file is licensed CC BY-NC, separately from '
          "Kima's GPL-3.0 code.")


def fold(pipe: Pipeline) -> tuple[np.ndarray, float]:
    scaler, ridge = pipe['scale'], pipe['ridge']
    weights = ridge.coef_ / scaler.scale_
    return weights, float(ridge.intercept_ - weights @ scaler.mean_)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', default=os.getenv('KIMA_EVAL_DATA', os.path.join(E.HERE, '.cache', 'data')))
    ap.add_argument('--cache', default=os.path.join(E.HERE, '.cache'))
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    sys.path.insert(0, E.SERVICE_DIR)
    from analyzer import MODEL_VERSION

    deam = D.load_deam(args.data)
    spec = E.default_spec('v1')
    embs, fails = E.embed_set(spec, 'deam', deam.ids, deam.paths, args.cache, args.workers, 2)
    keep = [k for k, i in enumerate(deam.ids) if i in embs]
    if fails or len(keep) != len(deam.ids):
        raise SystemExit(f'{len(deam.ids) - len(keep)} DEAM clips have no sound vector; refusing a partial fit')
    X = np.vstack([embs[deam.ids[k]] for k in keep]).astype(np.float64)

    probe = {'model': MODEL_VERSION, 'modelSha256': spec.model_sha256, 'source': SOURCE}
    for axis in ('valence', 'arousal'):
        y = (deam.ratings[axis][keep] - 1) / 8
        pipe = Pipeline([('scale', StandardScaler()), ('ridge', RidgeCV(alphas=ALPHAS))]).fit(X, y)
        weights, bias = fold(pipe)
        gap = float(np.max(np.abs(X @ weights + bias - pipe.predict(X))))
        if gap > 1e-9:
            raise SystemExit(f'{axis}: folded weights differ from the fitted pipeline by {gap:.3g}')
        probe[axis] = {'alpha': float(pipe['ridge'].alpha_), 'bias': bias, 'weights': weights.tolist()}
        print(f'{axis}: {len(keep)} clips, alpha {pipe["ridge"].alpha_:.4g}, fold gap {gap:.2g}', flush=True)

    with open(args.out, 'w') as f:
        json.dump(probe, f, indent=1)
        f.write('\n')
    print(f'wrote {os.path.abspath(args.out)}')


if __name__ == '__main__':
    main()
