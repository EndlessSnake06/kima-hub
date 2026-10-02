"""Each Essentia mood head is read from its positive-class column: column 0 for
happy, aggressive, acoustic, electronic and danceability, column 1 for sad,
relaxed and party (from each head's model metadata)."""

import inspect
import re
import sys
import types
import unittest
from typing import Any

import numpy as np


def _install_psycopg2_stub() -> None:
    extras: Any = types.ModuleType("psycopg2.extras")
    extras.RealDictCursor = dict
    extras.DictCursor = dict
    psycopg2: Any = types.ModuleType("psycopg2")
    psycopg2.extras = extras
    psycopg2.connect = lambda *a, **k: None
    sys.modules.setdefault("psycopg2", psycopg2)
    sys.modules.setdefault("psycopg2.extras", extras)


_install_psycopg2_stub()

import analyzer  # noqa: E402


# Positive-class column per head, straight from each head's metadata "classes".
EXPECTED_POSITIVE_COLUMN = {
    'mood_happy': 0,        # ['happy', 'non_happy']
    'mood_sad': 1,          # ['non_sad', 'sad']
    'mood_relaxed': 1,      # ['non_relaxed', 'relaxed']
    'mood_aggressive': 0,   # ['aggressive', 'not_aggressive']
    'mood_party': 1,        # ['non_party', 'party']
    'mood_acoustic': 0,     # ['acoustic', 'non_acoustic']
    'mood_electronic': 0,   # ['electronic', 'non_electronic']
    'danceability': 0,      # ['danceable', 'not_danceable']
}


class _Head:
    """Fake TensorflowPredict2D: every frame returns the same softmax row."""

    def __init__(self, row, fail=False):
        self.row = row
        self.fail = fail

    def __call__(self, embeddings):
        if self.fail:
            raise RuntimeError("boom")
        return np.tile(np.array(self.row, dtype=np.float32), (len(embeddings), 1))


def _analyzer_with(heads):
    a = analyzer.AudioAnalyzer.__new__(analyzer.AudioAnalyzer)
    a.musicnn_model = lambda audio: np.zeros((4, 200), dtype=np.float32)
    a.prediction_models = heads
    return a


class PositiveColumnTest(unittest.TestCase):
    def test_every_loaded_head_has_a_metadata_column(self):
        self.assertEqual(set(analyzer.HEAD_CLASSES), set(EXPECTED_POSITIVE_COLUMN))

    def test_positive_column_matches_metadata(self):
        for head, col in EXPECTED_POSITIVE_COLUMN.items():
            self.assertEqual(analyzer.positive_class_index(head), col, head)


class ExtractMoodsTest(unittest.TestCase):
    def _heads(self, **overrides):
        # Column 0 always holds 0.9, column 1 holds 0.1. A correct reader
        # therefore stores 0.9 for column-0-positive heads and 0.1 for the rest.
        heads = {h: _Head([0.9, 0.1]) for h in EXPECTED_POSITIVE_COLUMN}
        heads.update(overrides)
        return heads

    def test_each_head_reads_its_positive_column(self):
        out = _analyzer_with(self._heads())._extract_ml_features(np.zeros(16000))
        self.assertEqual(out['moodHappy'], 0.9)
        self.assertEqual(out['moodAggressive'], 0.9)
        self.assertEqual(out['moodAcoustic'], 0.9)
        self.assertEqual(out['moodElectronic'], 0.9)
        self.assertEqual(out['danceabilityMl'], 0.9)
        self.assertEqual(out['moodSad'], 0.1)
        self.assertEqual(out['moodRelaxed'], 0.1)
        self.assertEqual(out['moodParty'], 0.1)

    def test_heads_are_independent_not_paired(self):
        # Bittersweet: confidently happy AND sad. The old pairwise softmax
        # forced happy + sad = 1; each head must now keep its own value.
        heads = self._heads(mood_happy=_Head([0.8, 0.2]), mood_sad=_Head([0.3, 0.7]),
                            mood_relaxed=_Head([0.01, 0.99]),
                            mood_aggressive=_Head([0.01, 0.99]))
        out = _analyzer_with(heads)._extract_ml_features(np.zeros(16000))
        self.assertEqual(out['moodHappy'], 0.8)
        self.assertEqual(out['moodSad'], 0.7)
        # A calm track: relaxed 0.99, aggressive 0.01 -- not the 0.5/0.5 the
        # old clip-then-softmax produced for saturated heads.
        self.assertEqual(out['moodRelaxed'], 0.99)
        self.assertEqual(out['moodAggressive'], 0.01)

    def test_failed_head_is_missing_not_neutral(self):
        heads = self._heads(mood_party=_Head(None, fail=True))
        out = _analyzer_with(heads)._extract_ml_features(np.zeros(16000))
        self.assertIsNone(out['moodParty'])


class _Cursor:
    def __init__(self):
        self.statements = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params))

    def fetchall(self):
        return []

    def fetchone(self):
        return {"count": 0}

    def close(self):
        pass


class _DB:
    def __init__(self):
        self.cursor = _Cursor()
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self):
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _worker() -> Any:
    w: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.db = _DB()
    w.redis = types.SimpleNamespace(publish=lambda *a: None)
    return w


class ReanalysisSafetyTest(unittest.TestCase):
    def test_save_results_does_not_touch_clap_columns(self):
        w = _worker()
        features: dict[str, Any] = {k: None for k in (
            'bpm', 'beatsCount', 'key', 'keyScale', 'keyStrength', 'energy',
            'loudness', 'dynamicRange', 'danceability', 'valence', 'arousal',
            'instrumentalness', 'acousticness')}
        features.update(moodTags=[], essentiaGenres=[])
        w._save_results("t1", "/x.flac", features)
        update_sql = w.db.cursor.statements[0][0]
        self.assertNotIn('acousticness', update_sql)
        self.assertNotIn('instrumentalness', update_sql)
        # Placeholder count must still match the parameter tuple.
        self.assertEqual(update_sql.count('%s'), len(w.db.cursor.statements[0][1]))

    def test_stale_processing_is_never_marked_completed(self):
        # The sweep that rewrote stale 'processing' rows from column guesses
        # is gone: recovery is a TrackStage record whose claim lease expires,
        # so no analyzer code path may flip analysisStatus back from
        # staleness. Pin the methods' absence so they cannot return silently.
        for gone in ("_cleanup_stale_processing", "_retry_failed_tracks",
                     "_run_db_reconciliation", "_reset_queued_on_restart"):
            self.assertFalse(hasattr(analyzer.AnalysisWorker, gone),
                             f"{gone} still exists")
        # And 'completed' is written by _save_results alone.
        src = inspect.getsource(analyzer)
        save_src = inspect.getsource(analyzer.AnalysisWorker._save_results)
        self.assertEqual(src.count("'completed'"), save_src.count("'completed'"),
                         "'completed' appears outside _save_results")

    def test_failed_tracks_are_retried_not_marked_completed(self):
        # Re-offering a failed track is the stage queue's job now: the record
        # settles failed+retryable with a nextRetryAt and getNextWork offers
        # it once due. The analyzer must not re-queue anything itself.
        self.assertFalse(hasattr(analyzer.AnalysisWorker, "_retry_failed_tracks"))
        src = inspect.getsource(analyzer)
        for block in re.findall(r'UPDATE "Track".*?;', src, flags=re.S):
            if "'pending'" in block:
                # The only pending-write left is _save_failed's timeout
                # branch, which releases a claim it verifiably holds.
                self.assertIn("= 'processing'", block,
                              f"an UPDATE resets unclaimed tracks to pending: {block[:120]}")
            self.assertNotIn("track_embeddings", block)


if __name__ == '__main__':
    unittest.main()
