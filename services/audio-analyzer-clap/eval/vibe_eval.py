#!/usr/bin/env python3
"""
Vibe evaluation harness: score CLAP audio embeddings against human judgments.

    ./run.sh                                  # v1's shipped model, every set present
    ./run.sh --models v1 engine --sets mtt_triplets   # head-to-head on the triplets
    ./run.sh --list                           # which sets are present under the data root

See README.md for the sets, their licences, and what each score means.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import datasets as D  # noqa: E402
import embedders as EM  # noqa: E402
import metrics as M  # noqa: E402

DEFAULT_DATA = os.getenv('KIMA_EVAL_DATA', os.path.join(HERE, '.cache', 'data'))
DEFAULT_CACHE = os.path.join(HERE, '.cache')
ALL_SETS = list(D.LOADERS)


def score_set(es: D.EvalSet, emb: dict[str, np.ndarray]) -> dict:
    ids = [i for i in es.ids if i in emb]
    out: dict = {'n_clips_in_set': len(es.ids), 'n_clips_embedded': len(ids)}
    if es.name == 'mtt_triplets':
        trips = [t for t in es.triplets if all(x in emb for x in t[:3])]
        hits = M.triplet_hits(emb, trips)
        out['triplets_raw'] = es.n_triplets_raw
        out['triplets_usable'] = len(trips)
        out['triplet_agreement'] = M.triplet_score(hits)
        out['_hits'] = hits
        out['_triplet_keys'] = [f'{a}|{b}|{c}' for a, b, c, _ in trips]
        return out
    if es.name == 'isovat':
        out['medium_between_extremes'] = M.isovat_between(emb, ids, es.meta)
        return out
    keep = [es.ids.index(i) for i in ids]
    E = np.vstack([emb[i] for i in ids])
    groups = es.groups[keep] if es.groups is not None else None
    out['scale'] = es.scale
    out['grouping'] = 'film/artist' if groups is not None else 'none'
    preds = {}
    for dim, y_all in es.ratings.items():
        y = y_all[keep]
        knn = M.knn_agreement(E, y, groups)
        probe, pred = M.probe_score(E, y, groups)
        out[dim] = {'knn10_neighbour_agreement': knn, 'linear_probe_oof': probe}
        preds[dim] = pred
    if 'valence' in preds and ('arousal' in preds or 'energy' in preds):
        other = 'arousal' if 'arousal' in preds else 'energy'
        human = M.pearson(es.ratings['valence'][keep], es.ratings[other][keep])
        model = M.pearson(preds['valence'], preds[other])
        out['valence_vs_' + other + '_correlation'] = {'humans': human, 'probe_predictions': model}
    if es.name == 'soundtracks_set1':
        target = [es.meta['target'][k] for k in keep]
        out['blunt_test'] = M.blunt_test(preds['valence'], es.ratings['valence'][keep], target)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--models', nargs='+', default=['v1'], choices=['v1', 'engine'])
    ap.add_argument('--sets', nargs='+', default=ALL_SETS, choices=ALL_SETS)
    ap.add_argument('--data', default=DEFAULT_DATA, help='data root (default $KIMA_EVAL_DATA or eval/.cache/data)')
    ap.add_argument('--cache', default=DEFAULT_CACHE)
    ap.add_argument('--engine-dir', default=EM.DEFAULT_ENGINE_DIR,
                    help='new vibe engine checkout (read-only), for --models engine')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--threads', type=int, default=2, help='CPU threads per worker')
    ap.add_argument('--retry-failed', action='store_true', help='re-attempt clips that failed before')
    ap.add_argument('--out', default=None, help='results JSON (default eval/.cache/results-<timestamp>.json)')
    ap.add_argument('--list', action='store_true', help='only report which sets are present')
    args = ap.parse_args()

    loaded: dict[str, D.EvalSet] = {}
    missing: dict[str, str] = {}
    for name in args.sets:
        try:
            loaded[name] = D.LOADERS[name](args.data)
        except D.MissingData as e:
            missing[name] = f'missing: {e}'
    for name, es in loaded.items():
        extra = f', {len(es.triplets)} usable triplets' if es.triplets else ''
        print(f'[set] {name}: {len(es.ids)} clips{extra}')
    for name, why in missing.items():
        print(f'[set] {name}: {why}  (run fetch_data.sh, see README)')
    if args.list:
        return 0
    if not loaded:
        print('no evaluation set is present under', args.data)
        return 1

    report: dict = {'generated': dt.datetime.now().isoformat(timespec='seconds'),
                    'data_root': os.path.abspath(args.data), 'missing_sets': missing, 'models': {}}
    hits_by_model: dict[str, tuple[list[str], np.ndarray]] = {}
    for kind in args.models:
        spec = EM.default_spec(kind, args.engine_dir)
        print(f'[model] {kind}: {spec.model_path} sha256={spec.model_sha256[:16]}...')
        mrep: dict = {'embedder': spec.describe(), 'sets': {}}
        for name, es in loaded.items():
            emb, fails = EM.embed_set(spec, name, es.ids, es.paths, args.cache,
                                      args.workers, args.threads, args.retry_failed)
            res = score_set(es, emb)
            res['failed_clips'] = len([k for k in es.ids if k in fails])
            if res['failed_clips']:
                res['failed_examples'] = {k: fails[k] for k in list(fails)[:5]}
            if '_hits' in res:
                hits_by_model[kind] = (res.pop('_triplet_keys'), res.pop('_hits'))
            mrep['sets'][name] = res
        report['models'][kind] = mrep

    if len(hits_by_model) == 2:
        (ka, ha), (kb, hb) = hits_by_model['v1'], hits_by_model['engine']
        common = sorted(set(ka) & set(kb))
        ia = {k: i for i, k in enumerate(ka)}
        ib = {k: i for i, k in enumerate(kb)}
        a = np.array([ha[ia[k]] for k in common])
        b = np.array([hb[ib[k]] for k in common])
        report['head_to_head_triplets'] = {
            'v1': M.triplet_score(a), 'engine': M.triplet_score(b),
            'v1_minus_engine': M.paired_difference(a, b)}

    out = args.out or os.path.join(args.cache, f"results-{dt.datetime.now():%Y%m%d-%H%M%S}.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w') as f:
        json.dump(report, f, indent=2)
    print_summary(report)
    print(f'\nfull results: {out}')
    return 0


def _ci(d: dict, key: str = 'rate') -> str:
    lo, hi = d['ci95']
    return f"{d[key]:.3f} [{lo:.3f}, {hi:.3f}] n={d['n']}"


def print_summary(rep: dict) -> None:
    for kind, m in rep['models'].items():
        print(f'\n=== {kind}  ({os.path.basename(m["embedder"]["model_path"])}) ===')
        for name, r in m['sets'].items():
            fail = f"  ({r['failed_clips']} clips failed to embed)" if r.get('failed_clips') else ''
            if 'triplet_agreement' in r:
                print(f"{name}: agreement {_ci(r['triplet_agreement'])} (chance 0.333){fail}")
            elif 'medium_between_extremes' in r:
                mb = r['medium_between_extremes']
                parts = ', '.join(f"{d} {mb[d]['k']}/{mb[d]['n']}" for d in ('valence', 'arousal', 'tension') if d in mb)
                print(f"{name}: medium-between-extremes pooled {_ci(mb['pooled'])} ({parts}; chance 0.333){fail}")
            else:
                for dim in ('valence', 'arousal', 'energy', 'tension'):
                    if dim in r:
                        k, p = r[dim]['knn10_neighbour_agreement'], r[dim]['linear_probe_oof']
                        print(f"{name} {dim}: kNN-10 r={_ci(k, 'r')}  probe r={_ci(p, 'r')}{fail}")
                if 'blunt_test' in r:
                    passed = sum(x['passes'] for x in r['blunt_test'])
                    print(f"{name} blunt test: {passed}/4 -- " + '; '.join(
                        f"{x['check']} {'PASS' if x['passes'] else 'fail'} (p={x['welch_p']:.2g})" for x in r['blunt_test']))
    h = rep.get('head_to_head_triplets')
    if h:
        d = h['v1_minus_engine']
        print(f"\nhead-to-head triplets (same {d['n']}): v1 {h['v1']['rate']:.3f} vs engine {h['engine']['rate']:.3f}; "
              f"v1-engine {d['delta']:+.3f} [{d['ci95_bootstrap'][0]:+.3f}, {d['ci95_bootstrap'][1]:+.3f}], "
              f"McNemar p={d['mcnemar_exact_p']:.3g} ({d['only_first_right']} only-v1 vs {d['only_second_right']} only-engine)")


if __name__ == '__main__':
    sys.exit(main())
