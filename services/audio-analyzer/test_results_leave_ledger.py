"""A successful analysis settles the TrackStage record and leaves
EnrichmentFailure untouched. Real ``_save_results`` on a recording cursor."""

import sys
import types
import unittest
from typing import Any


def _install_psycopg2_stub() -> None:
    """Provide a dummy psycopg2/psycopg2.extras so the real analyzer imports."""
    extras: Any = types.ModuleType("psycopg2.extras")
    extras.RealDictCursor = dict
    extras.DictCursor = dict
    psycopg2: Any = types.ModuleType("psycopg2")
    psycopg2.extras = extras
    psycopg2.connect = lambda *a, **k: None
    sys.modules["psycopg2"] = psycopg2
    sys.modules["psycopg2.extras"] = extras


_install_psycopg2_stub()

import analyzer  # noqa: E402


class _RecordingCursor:
    """Records every statement the save path executes."""

    def __init__(self, *, returning_retry=1):
        self.returning_retry = returning_retry
        self.statements: list[tuple[str, tuple]] = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params if params is not None else ()))
        self.rowcount = 1

    def executemany(self, *a):
        pass

    def fetchone(self):
        return {"analysisRetryCount": self.returning_retry}

    def fetchall(self):
        return []

    def close(self):
        pass


class _RecordingDB:
    def __init__(self):
        self.cursor: _RecordingCursor = _RecordingCursor(returning_retry=1)
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self) -> _RecordingCursor:
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class SuccessLeavesLedgerTest(unittest.TestCase):
    def setUp(self):
        self.worker: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
        self.db = _RecordingDB()
        self.worker.db = self.db

    def _save_results(self) -> None:
        features: dict[str, Any] = {k: None for k in (
            "bpm", "beatsCount", "key", "keyScale", "keyStrength", "energy",
            "loudness", "dynamicRange", "danceability", "valence", "arousal")}
        features.update(moodTags=[], essentiaGenres=[], analysisMode="standard")
        self.worker._save_results("t1", "/x.flac", features)

    def test_no_statement_touches_enrichmentfailure(self):
        self._save_results()

        self.assertTrue(self.db.cursor.statements, "save path executed nothing")
        for sql, _ in self.db.cursor.statements:
            self.assertNotIn(
                "EnrichmentFailure",
                sql,
                f"success path still writes the old ledger: {sql[:120]}",
            )

    def test_track_and_stage_record_are_still_settled(self):
        self._save_results()

        sqls = [sql for sql, _ in self.db.cursor.statements]
        # The real record of success: the Track columns and the stage record.
        self.assertTrue(any('UPDATE "Track"' in sql for sql in sqls))
        self.assertTrue(
            any('INTO "TrackStage"' in sql for sql in sqls),
            "success must still settle the TrackStage record",
        )
        self.assertEqual(self.db.commits, 1)


if __name__ == "__main__":
    unittest.main()
