"""
Human-judged evaluation sets for the vibe (CLAP) embedding.

Each loader returns an `EvalSet`: the clip ids, the audio path for each clip,
and whatever human judgments the set carries (triplet votes, valence/arousal
ratings, composed low/medium/high levels). Audio is never in the repo -- it is
fetched into a data root (fetch_data.sh) -- and labels are read either from
that data root or, where the licence allows redistribution, from ./labels/.

Data root layout (what fetch_data.sh produces; symlinks work too):

  <root>/mtt/comparisons_final.csv      MagnaTagATune similarity triplets
  <root>/mtt/audio/<d>/<clip>.mp3       MagnaTagATune clips
  <root>/soundtracks/set1/..../001.mp3  Eerola & Vuoskoski film excerpts, Set 1
  <root>/soundtracks/set2/..../001.mp3  ... Set 2
  <root>/isovat/Audio/{Valence,Arousal,Tension}/X-NN-{L,M,H}.wav
  <root>/deam/MEMD_audio/<id>.mp3 + <root>/deam/annotations/...
  <root>/merge/MERGE_Audio_Complete/{Q1..Q4}/<id>.mp3 + *_av_values.csv
  <root>/memo2496/audio/<uuid>.mp3
  <root>/pmemo/PMEmo2019/{chorus,annotations,metadata.csv}

A set whose files are absent is reported as missing, never silently skipped.
"""
from __future__ import annotations

import csv
import os
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = os.path.join(HERE, 'labels')


class MissingData(Exception):
    """The set's audio or labels are not present under the data root."""


@dataclass
class EvalSet:
    name: str
    ids: list[str]
    paths: list[str]
    # Continuous human ratings, one array per dimension, aligned with ids.
    ratings: dict[str, np.ndarray] = field(default_factory=dict)
    # Grouping used to keep related clips out of each other's folds and
    # neighbour lists (same film / same artist). None = every clip its own group.
    groups: Optional[np.ndarray] = None
    # Free-form per-clip categorical info (Soundtracks target emotion, IsoVAT level).
    meta: dict[str, list] = field(default_factory=dict)
    # MTT only: (id_a, id_b, id_c, index_of_odd_one_out)
    triplets: list[tuple[str, str, str, int]] = field(default_factory=list)
    n_triplets_raw: int = 0
    scale: str = ''


def _need(path: str) -> str:
    if not os.path.exists(path):
        raise MissingData(path)
    return path


def _find_dir_with(root: str, filename: str) -> str:
    """The directory under `root` that holds `filename` (skipping __MACOSX).

    The OSF zips unpack with differing inner folder names (Set1/ vs set2/), so
    the audio folder is located by content rather than by a hard-coded path.
    """
    _need(root)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        dirnames[:] = [d for d in dirnames if d != '__MACOSX']
        if filename in filenames:
            return dirpath
    raise MissingData(f'{root}/**/{filename}')


def _read_csv(path: str) -> list[dict]:
    with open(_need(path), encoding='utf-8-sig', newline='') as f:
        return [{(k or '').strip(): (v or '').strip() for k, v in r.items()}
                for r in csv.DictReader(f)]


# --------------------------------------------------------------------------
# MagnaTagATune similarity triplets (Law et al. 2009)
# --------------------------------------------------------------------------
def load_mtt(root: str) -> EvalSet:
    """Odd-one-out triplets, usable when one clip got strictly the most "odd
    one out" votes and all three clips have audio."""
    base = os.path.join(root, 'mtt')
    comp = _need(os.path.join(base, 'comparisons_final.csv'))
    audio = _need(os.path.join(base, 'audio'))
    paths: dict[str, str] = {}
    trips = []
    raw = 0
    with open(comp) as f:
        rd = csv.reader(f, delimiter='\t')
        next(rd)
        for row in rd:
            row = [c.strip('"') for c in row]
            if len(row) < 9:
                continue
            raw += 1
            ids = row[0:3]
            votes = [int(v) for v in row[3:6]]
            for cid, rel in zip(ids, row[6:9]):
                paths[cid] = os.path.join(audio, rel)
            mx = max(votes)
            if votes.count(mx) != 1:
                continue
            trips.append((ids[0], ids[1], ids[2], votes.index(mx)))
    have = {cid for cid, p in paths.items() if os.path.isfile(p)}
    if not have:
        raise MissingData(f'{audio} (no triplet clips found)')
    trips = [t for t in trips if t[0] in have and t[1] in have and t[2] in have]
    ids = sorted(have)
    return EvalSet('mtt_triplets', ids, [paths[i] for i in ids],
                   triplets=trips, n_triplets_raw=raw)


# --------------------------------------------------------------------------
# Soundtracks (Eerola & Vuoskoski 2011) -- labels vendored (CC BY 4.0)
# --------------------------------------------------------------------------
def _soundtracks(root: str, which: str) -> EvalSet:
    lab = os.path.join(LABELS, 'soundtracks')
    if which == 'set1':
        ratings = _read_csv(os.path.join(lab, 'mean_ratings_set1.csv'))
        films = {r['Nro']: r['Album name'] for r in _read_csv(os.path.join(lab, 'set1_tracklist.csv'))}
        num_key, cols = 'number', {'valence': 'valence', 'energy': 'energy', 'tension': 'tension'}
    else:
        ratings = _read_csv(os.path.join(lab, 'mean_ratings_set2.csv'))
        films = {r['Number']: r['soundtrack'] for r in ratings}
        num_key, cols = 'Number', {'valence': 'Valence', 'energy': 'Energy', 'tension': 'Tension'}
    adir = _find_dir_with(os.path.join(root, 'soundtracks', which), '001.mp3')
    rows = [r for r in ratings if os.path.isfile(os.path.join(adir, f"{r[num_key]}.mp3"))]
    if not rows:
        raise MissingData(adir)
    ids = [r[num_key] for r in rows]
    return EvalSet(
        f'soundtracks_{which}', ids, [os.path.join(adir, f'{i}.mp3') for i in ids],
        ratings={k: np.array([float(r[c]) for r in rows]) for k, c in cols.items()},
        groups=np.array([films.get(i, i).strip().lower() for i in ids]),
        meta={'target': [r['TARGET'].strip().upper() for r in rows]},
        scale='1-9 mean expert rating')


def load_soundtracks_set1(root: str) -> EvalSet:
    return _soundtracks(root, 'set1')


def load_soundtracks_set2(root: str) -> EvalSet:
    return _soundtracks(root, 'set2')


# --------------------------------------------------------------------------
# IsoVAT (Plut et al.) -- composed L/M/H versions varying one dimension
# --------------------------------------------------------------------------
def load_isovat(root: str) -> EvalSet:
    base = _need(os.path.join(root, 'isovat', 'Audio'))
    ids, paths, dim, sset, lvl = [], [], [], [], []
    for d, letter in (('valence', 'V'), ('arousal', 'A'), ('tension', 'T')):
        folder = os.path.join(base, d.capitalize())
        for fn in sorted(os.listdir(_need(folder))):
            if not fn.endswith('.wav'):
                continue
            stem = fn[:-4]
            parts = stem.split('-')
            if len(parts) != 3 or parts[0] != letter or parts[2] not in ('L', 'M', 'H'):
                continue
            ids.append(stem)
            paths.append(os.path.join(folder, fn))
            dim.append(d)
            sset.append(int(parts[1]))
            lvl.append(parts[2])
    if not ids:
        raise MissingData(base)
    return EvalSet('isovat', ids, paths, meta={'dim': dim, 'set': sset, 'level': lvl})


# --------------------------------------------------------------------------
# DEAM (Aljanaki et al. 2017) -- song-level static means, 1-9
# --------------------------------------------------------------------------
def load_deam(root: str) -> EvalSet:
    base = os.path.join(root, 'deam')
    ann = os.path.join(base, 'annotations', 'annotations averaged per song', 'song_level')
    val, aro = {}, {}
    for fn in ('static_annotations_averaged_songs_1_2000.csv',
               'static_annotations_averaged_songs_2000_2058.csv'):
        for r in _read_csv(os.path.join(ann, fn)):
            sid = r['song_id']
            val[sid] = float(r['valence_mean'])
            aro[sid] = float(r['arousal_mean'])
    audio = _need(os.path.join(base, 'MEMD_audio'))
    ids = sorted((s for s in val if os.path.isfile(os.path.join(audio, f'{s}.mp3'))), key=int)
    if not ids:
        raise MissingData(audio)
    return EvalSet('deam', ids, [os.path.join(audio, f'{s}.mp3') for s in ids],
                   ratings={'valence': np.array([val[s] for s in ids]),
                            'arousal': np.array([aro[s] for s in ids])},
                   scale='1-9 mean rating')


# --------------------------------------------------------------------------
# MERGE audio complete (Louro et al. 2024) -- AV in 0-1, grouped by artist
# --------------------------------------------------------------------------
def load_merge(root: str) -> EvalSet:
    base = os.path.join(root, 'merge', 'MERGE_Audio_Complete')
    av = {r['Song']: r for r in _read_csv(os.path.join(base, 'merge_audio_complete_av_values.csv'))}
    md = {r['Song']: r for r in _read_csv(os.path.join(base, 'merge_audio_complete_metadata.csv'))}
    ids, paths = [], []
    for song, m in sorted(md.items()):
        if song not in av:
            continue
        p = os.path.join(base, m['Quadrant'], f"{m['AllMusic Id']}.mp3")
        if not os.path.isfile(p):
            p = os.path.join(base, m['Quadrant'], f'{song}.mp3')
        if os.path.isfile(p):
            ids.append(song)
            paths.append(p)
    if not ids:
        raise MissingData(base)
    return EvalSet('merge', ids, paths,
                   ratings={'valence': np.array([float(av[s]['Valence']) for s in ids]),
                            'arousal': np.array([float(av[s]['Arousal']) for s in ids])},
                   groups=np.array([md[s]['Artist'].strip().lower() for s in ids]),
                   scale='0-1')


# --------------------------------------------------------------------------
# Memo2496 (Li et al. 2025) -- labels vendored as per-song means (CC BY 4.0)
# --------------------------------------------------------------------------
MEMO_LABELS = os.path.join(LABELS, 'memo2496', 'memo2496_song_means.csv')


def load_memo2496(root: str) -> EvalSet:
    audio = _need(os.path.join(root, 'memo2496', 'audio'))
    rows = [r for r in _read_csv(MEMO_LABELS)
            if os.path.isfile(os.path.join(audio, r['file_name']))]
    if not rows:
        raise MissingData(audio)
    return EvalSet('memo2496', [r['song_id'] for r in rows],
                   [os.path.join(audio, r['file_name']) for r in rows],
                   ratings={'valence': np.array([float(r['valence_mean']) for r in rows]),
                            'arousal': np.array([float(r['arousal_mean']) for r in rows])},
                   meta={'emotion': [r['emotion'] for r in rows]},
                   scale='-1..1 per-second mean over the track')


def derive_memo_labels(valence_csv: str, arousal_csv: str, info_csv: str, out_csv: str) -> int:
    """Rebuild labels/memo2496/memo2496_song_means.csv from the Figshare files
    valence_all_average.csv, arousal_all_average.csv and songs_info_all.csv.

    Each track's label is the mean of its per-second expert average. NOTE the
    Figshare record also carries *_all_std.csv files of the same shape; the
    arousal one must not be substituted for the average (see README).
    """
    def seq_mean(fn: str) -> dict[int, tuple[float, int]]:
        out = {}
        with open(fn) as f:
            for r in csv.reader(f):
                if r[0] == 'song_id':
                    continue
                v = [float(x) for x in r[1:] if x.strip() not in ('', 'nan', 'NaN')]
                if v:
                    out[int(r[0])] = (sum(v) / len(v), len(v))
        return out
    V, A = seq_mean(valence_csv), seq_mean(arousal_csv)
    info = {int(r['song_id']): r for r in _read_csv(info_csv)}
    n = 0
    with open(out_csv, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['song_id', 'file_name', 'emotion', 'platform',
                    'valence_mean', 'arousal_mean', 'n_seconds'])
        for s in sorted(info):
            if s in V and s in A:
                w.writerow([s, info[s]['file_name'], info[s]['emotion'], info[s]['platform'],
                            f'{V[s][0]:.6f}', f'{A[s][0]:.6f}', V[s][1]])
                n += 1
    return n


# --------------------------------------------------------------------------
# PMEmo 2019 (Zhang et al. 2018) -- chorus clips, AV in 0-1, grouped by artist
# --------------------------------------------------------------------------
def load_pmemo(root: str) -> EvalSet:
    base = os.path.join(root, 'pmemo', 'PMEmo2019')
    ann = {r['musicId']: r for r in _read_csv(os.path.join(base, 'annotations', 'static_annotations.csv'))}
    md = {r['musicId']: r for r in _read_csv(os.path.join(base, 'metadata.csv'))}
    chorus = _need(os.path.join(base, 'chorus'))
    ids = sorted((m for m in ann if m in md and os.path.isfile(os.path.join(chorus, md[m]['fileName']))),
                 key=int)
    if not ids:
        raise MissingData(chorus)
    return EvalSet('pmemo', ids, [os.path.join(chorus, md[m]['fileName']) for m in ids],
                   ratings={'valence': np.array([float(ann[m]['Valence(mean)']) for m in ids]),
                            'arousal': np.array([float(ann[m]['Arousal(mean)']) for m in ids])},
                   groups=np.array([md[m]['artist'].strip().lower() for m in ids]),
                   scale='0-1')


LOADERS = {
    'mtt_triplets': load_mtt,
    'soundtracks_set1': load_soundtracks_set1,
    'soundtracks_set2': load_soundtracks_set2,
    'isovat': load_isovat,
    'deam': load_deam,
    'merge': load_merge,
    'memo2496': load_memo2496,
    'pmemo': load_pmemo,
}


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 6 and sys.argv[1] == 'derive-memo':
        print(f'wrote {derive_memo_labels(*sys.argv[2:])} rows to {sys.argv[5]}')
    else:
        sys.exit('usage: datasets.py derive-memo <valence_all_average.csv> '
                 '<arousal_all_average.csv> <songs_info_all.csv> <out.csv>')
