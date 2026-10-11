"""
Platt calibration of CLAP zero-shot valence/arousal.

The baseline the fit is compared with is a fixed softmax at T=15 on the margin
between the positive and negative prompt groups:
score = sigmoid(15 * (avg_pos - avg_neg)). On the full test library that
saturates -- the median CLAP arousal sits at 0.990, so the mood ladder cannot
rank on it.

This script refits the two parameters of score = sigmoid(a * x + b), where x is
the raw margin. The supervision is the labelled sets: DEAM, Memo2496 and the
two Soundtracks sets, each clip's mean human rating binarised at its set median
(standard Platt scaling). The fit runs on one set and every other set reports
the transfer, ECE and the saturation fix, so the numbers cannot come from the
set the parameters saw.

The MTT similarity triplets (446 with a strict majority) are measured, not
fitted on: they are similarity judgements, not valence/arousal judgements, and
fitting an arousal latent to them flips its sign (the triplet-fit arousal is
Spearman -0.64 to -0.84 against every labelled set's ground truth, and its ECE
is 0.49-0.67). The triplet pair agreement is kept as a secondary "monotone in
the judgements" check.

Run (from eval/):
  uv run --no-project --python 3.12 --with-requirements ../requirements.txt \
      --with scipy python calibrate_platt.py --mtt-csv <comparisons_final.csv>
The cache under .cache/emb must contain the clip embeddings for every set.
"""
from __future__ import annotations

import csv
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.dirname(HERE)
sys.path.insert(0, SERVICE_DIR)

from onnx_backend import OnnxTextCLAPBackend  # noqa: E402

from analyzer import PROMPTS as SHIPPED_PROMPTS  # noqa: E402

PROMPTS = {
    'valence': {'pos': SHIPPED_PROMPTS['happy'], 'neg': SHIPPED_PROMPTS['sad']},
    'arousal': {'pos': SHIPPED_PROMPTS['high_energy'], 'neg': SHIPPED_PROMPTS['low_energy']},
}
T_SHIPPED = 15.0
LABEL_SETS = ['deam', 'memo2496', 'soundtracks_set1', 'soundtracks_set2']


def sig(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -500, 500)))


def load_cache_emb(key_glob: str, dataset: str):
    dirs = sorted(glob.glob(os.path.join(HERE, '.cache', 'emb', key_glob)))
    if not dirs:
        sys.exit(f'no embedding cache dir matching {key_glob!r}')
    path = os.path.join(dirs[-1], f'{dataset}.npz')
    if not os.path.isfile(path):
        sys.exit(f'missing cache {path}')
    z = np.load(path, allow_pickle=False)
    return {i: e for i, e in zip(z['ids'].tolist(), z['emb'])}


def margins(emb: dict, text: OnnxTextCLAPBackend) -> dict:
    """Raw margin x per clip, per axis, exactly as the analyzer averages it:
    mean of L2-normalised dot products over each prompt group."""
    out = {}
    for axis, groups in PROMPTS.items():
        pe = text.embed_text(groups['pos'])
        ne = text.embed_text(groups['neg'])
        out[axis] = {
            cid: float(np.mean([e @ t for t in pe]) - np.mean([e @ t for t in ne]))
            for cid, e in emb.items()
        }
    return out


def load_labels_deam(ann_dir: str) -> dict:
    out: dict[str, dict[str, float]] = {}
    for fn in ('static_annotations_averaged_songs_1_2000.csv',
               'static_annotations_averaged_songs_2000_2058.csv'):
        with open(os.path.join(ann_dir, fn), encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f):
                r = {(k or '').strip(): (v or '').strip() for k, v in r.items()}
                out[r['song_id']] = {'valence': float(r['valence_mean']),
                                     'arousal': float(r['arousal_mean'])}
    return out


def load_labels_memo() -> dict:
    with open(os.path.join(HERE, 'labels', 'memo2496', 'memo2496_song_means.csv')) as f:
        return {r['song_id']: {'valence': float(r['valence_mean']),
                               'arousal': float(r['arousal_mean'])}
                for r in csv.DictReader(f)}


def load_labels_soundtracks(csv_name: str, cols: dict) -> dict:
    with open(os.path.join(HERE, 'labels', 'soundtracks', csv_name), encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    num_key = 'number' if 'number' in rows[0] else 'Number'
    return {r[num_key]: {'valence': float(r[cols['valence']]),
                         'arousal': float(r[cols['arousal']])}
            for r in rows}


def load_triplets(csv_path: str, have: set) -> list[tuple[str, str, str, int]]:
    """Strict-majority odd-one-out, same filter as datasets.load_mtt."""
    trips = []
    with open(csv_path) as f:
        rd = csv.reader(f, delimiter='\t')
        next(rd)
        for row in rd:
            row = [c.strip('"') for c in row]
            if len(row) < 9:
                continue
            ids = row[0:3]
            votes = [int(v) for v in row[3:6]]
            mx = max(votes)
            if votes.count(mx) != 1:
                continue
            if not all(i in have for i in ids):
                continue
            trips.append((ids[0], ids[1], ids[2], votes.index(mx)))
    return trips


def platt_nll(theta, x: np.ndarray, y: np.ndarray) -> float:
    s = np.clip(sig(theta[0] * x + theta[1]), 1e-9, 1 - 1e-9)
    return -(np.log(np.where(y > 0.5, s, 1 - s))).sum()


def pair_agreement(x_axis: np.ndarray, trips, index) -> float:
    """Fraction of triplet pairs (in-group = similar, odd = dissimilar) the
    axis scores rank correctly -- monotone-in-the-judgements check."""
    s = x_axis
    hits, total = 0.0, 0
    for a, b, c, odd in trips:
        trio = [a, b, c]
        in_group = [t for t in trio if t != trio[odd]]
        i, j = index[in_group[0]], index[in_group[1]]
        o = index[trio[odd]]
        d_in, d_out = abs(s[i] - s[j]), abs(s[i] - s[o]) + abs(s[j] - s[o])
        hits += 1.0 if d_in * 2 < d_out else (0.5 if d_in * 2 == d_out else 0.0)
        total += 1
    return hits / total


def spearman(p: np.ndarray, q: np.ndarray) -> float:
    rp = np.argsort(np.argsort(p)).astype(float)
    rq = np.argsort(np.argsort(q)).astype(float)
    return float(np.corrcoef(rp, rq)[0, 1])


def ece(s: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(s, edges) - 1, 0, bins - 1)
    total = 0.0
    for k in range(bins):
        m = idx == k
        if m.sum() == 0:
            continue
        total += m.mean() * abs(y[m].mean() - s[m].mean())
    return float(total)


def report_scores(s: np.ndarray) -> dict:
    return {
        'median': round(float(np.median(s)), 4),
        'p05': round(float(np.quantile(s, 0.05)), 4),
        'p95': round(float(np.quantile(s, 0.95)), 4),
        'frac_ge_0.99': round(float(np.mean(s >= 0.99)), 4),
        'frac_le_0.01': round(float(np.mean(s <= 0.01)), 4),
    }


def main():
    import argparse
    from scipy.optimize import minimize

    ap = argparse.ArgumentParser()
    ap.add_argument('--mtt-csv', required=True)
    ap.add_argument('--cache-key', default='v1-model37df17afb988-*')
    ap.add_argument('--deam-ann', required=True,
                    help="DEAM song-level annotation directory (annotations averaged per song)")
    ap.add_argument('--fit-on', default='deam', choices=LABEL_SETS)
    ap.add_argument('--out', help='default: calibration/platt-<fit-on>.json')
    args = ap.parse_args()
    out_path = args.out or os.path.join(HERE, 'calibration', f'platt-{args.fit_on}.json')

    text = OnnxTextCLAPBackend()
    labels = {
        'deam': load_labels_deam(args.deam_ann),
        'memo2496': load_labels_memo(),
        'soundtracks_set1': load_labels_soundtracks(
            'mean_ratings_set1.csv', {'valence': 'valence', 'arousal': 'energy'}),
        'soundtracks_set2': load_labels_soundtracks(
            'mean_ratings_set2.csv', {'valence': 'Valence', 'arousal': 'Energy'}),
    }
    # Every set: raw margins, clipped to labelled ids.
    data = {}
    for name in LABEL_SETS:
        emb = load_cache_emb(args.cache_key, name)
        mx = margins(emb, text)
        common = sorted(set(emb) & set(labels[name]))
        data[name] = {'x': {a: np.array([mx[a][c] for c in common]) for a in PROMPTS},
                      'lab': {a: np.array([labels[name][c][a] for c in common]) for a in PROMPTS}}
        print(f'[set] {name}: {len(common)} labelled clips')

    emb_mtt = load_cache_emb(args.cache_key, 'mtt_triplets')
    x_mtt = margins(emb_mtt, text)
    trips = load_triplets(args.mtt_csv, set(emb_mtt))
    index = {cid: k for k, cid in enumerate(sorted(emb_mtt))}
    print(f'[triplets] {len(trips)} usable (strict majority, all clips cached)')

    out = {'t_shipped': T_SHIPPED, 'fit_on': args.fit_on, 'n_triplets': len(trips),
           'axes': {}, 'verify': {}}
    for axis in ('valence', 'arousal'):
        xf = data[args.fit_on]['x'][axis]
        lf = data[args.fit_on]['lab'][axis]
        yf = (lf > np.median(lf)).astype(float)
        fit = minimize(platt_nll, x0=np.array([T_SHIPPED, 0.0]), args=(xf, yf),
                       method='Nelder-Mead',
                       options={'xatol': 1e-6, 'fatol': 1e-8, 'maxiter': 4000})
        a, b = float(fit.x[0]), float(fit.x[1])
        xm = np.array([x_mtt[axis][cid] for cid in sorted(emb_mtt)])
        out['axes'][axis] = {
            'fit': {'a': round(a, 3), 'b': round(b, 3), 'converged': bool(fit.success)},
            'nll_fit_set': {
                'shipped': round(float(platt_nll([T_SHIPPED, 0.0], xf, yf)), 1),
                'fitted': round(float(fit.fun), 1),
            },
            'triplet_agreement_axis_distance': {
                'shipped': round(pair_agreement(sig(T_SHIPPED * xm), trips, index), 4),
                'fitted': round(pair_agreement(sig(a * xm + b), trips, index), 4),
            },
            'saturation_mtt_clips': {
                'shipped_t15': report_scores(sig(T_SHIPPED * xm)),
                'fitted': report_scores(sig(a * xm + b)),
            },
        }
        print(f"[{axis}] a={a:.3f} b={b:.3f} nll {out['axes'][axis]['nll_fit_set']}")
        for name in LABEL_SETS:
            x, ref = data[name]['x'][axis], data[name]['lab'][axis]
            y = (ref > np.median(ref)).astype(float)
            s15, s = sig(T_SHIPPED * x), sig(a * x + b)
            entry = {
                'n': int(len(x)),
                'spearman': {'shipped': round(spearman(s15, ref), 4),
                             'fitted': round(spearman(s, ref), 4)},
                'ece': {'shipped': round(ece(s15, y), 4), 'fitted': round(ece(s, y), 4)},
                'saturation': {'shipped_t15': report_scores(s15), 'fitted': report_scores(s)},
            }
            out['verify'].setdefault(name, {})[axis] = entry
            print(f"[verify {name}/{axis}] spearman {entry['spearman']} ece {entry['ece']}"
                  f" sat>=0.99 {entry['saturation']['shipped_t15']['frac_ge_0.99']}"
                  f" -> {entry['saturation']['fitted']['frac_ge_0.99']}")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'[out] {out_path}')


if __name__ == '__main__':
    main()
