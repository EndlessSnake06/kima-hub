"""End-to-end routing test for the real ``AnalysisWorker._save_failed``.

The classifier unit tests cover the *decision*; this suite covers the *effect*:
the real failure sink in analyzer.py must write ``permanently_failed`` (never
touching ``analysisRetryCount``) for terminal dispositions and ``failed``
with a retry bump for ``INCONCLUSIVE``, while a batch-timeout is exempt -- and
every branch must settle the TrackStage analysis record with the SAME verdict
(status, failureClass, retryable, nextRetryAt, evidence), because the record
is what the stage queue reads.

We load analyzer.py against a stubbed psycopg2 (essentia is absent) and drive
_save_failed / _save_results with an in-memory fake cursor that honours
rowcount and RETURNING, then assert on the SQL and params they actually
executed -- not on a re-implementation of the methods. The driver stub is the
only mock: the code under test runs for real.

Run from the service dir:
    cd services/audio-analyzer && python -m pytest test_save_failed_routing.py -v
"""

import json
import sys
import types
import unittest
from typing import Any


def _install_psycopg2_stub() -> None:
    """Provide a dummy psycopg2/psycopg2.extras so the real analyzer imports.

    Nothing here touches a real driver; the recorded cursor fully stands in
    for psycopg2's cursor inside the save paths.
    """
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

from classifier import classify_failure, Disposition  # noqa: E402


class _FakeCursor:
    """Minimal stand-in for a psycopg2 cursor.

    Honours ``rowcount`` and the RETURNING-fetch contract of the save paths
    so they exercise their real branches. ``execute`` records EVERY statement
    and its params -- _save_failed writes the Track row AND the TrackStage
    record, and the assertions must see both.
    """

    def __init__(self, *, returning_retry=1):
        self.returning_retry = returning_retry
        self.statements: list[tuple[str, tuple]] = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params if params is not None else ()))
        # A real MATCHES=1 UPDATE on a genuinely 'processing' track: rowcount
        # is 1, so the guard at _save_failed's rowcount check never fires.
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
    """Tiny recording stand-in for the analyzer's DB connection."""

    def __init__(self):
        self.cursor: _FakeCursor = _FakeCursor(returning_retry=1)
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self) -> _FakeCursor:
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class SaveFailedRoutingTest(unittest.TestCase):
    def setUp(self):
        self.worker: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
        self.db = _RecordingDB()
        self.worker.db = self.db

    # -- helpers -----------------------------------------------------------

    def track_sql(self) -> str:
        # The INCONCLUSIVE branch reads the stage record before writing, so
        # the Track update is not necessarily statements[0]: scan for it.
        for sql, _ in self.db.cursor.statements:
            if 'UPDATE "Track"' in sql:
                return sql
        raise AssertionError("no Track update executed")

    def stage_index(self) -> int:
        for i, (sql, _) in enumerate(self.db.cursor.statements):
            if 'INTO "TrackStage"' in sql:
                return i
        raise AssertionError("no TrackStage settlement executed")

    def stage_sql(self) -> str:
        return self.db.cursor.statements[self.stage_index()][0]

    def stage_params(self):
        return self.db.cursor.statements[self.stage_index()][1]

    def assertSettledTerminal(self, failure_class: str):
        """The TrackStage branch of a terminal disposition: closed for good."""
        sql = self.stage_sql()
        self.assertIn('"TrackStage"', sql)
        self.assertIn("'failed'", sql)
        self.assertIn("retryable = false", sql)
        self.assertIn('"nextRetryAt" = NULL', sql)
        params = self.stage_params()
        self.assertEqual(params[3], failure_class)          # "lastErrorCode"
        self.assertEqual(params[5], failure_class)          # failureClass
        evidence = json.loads(params[6])
        self.assertIn("error", evidence)

    # -- column routing (the old contract, still in force) ------------------

    def test_damaged_becomes_permanently_failed_without_retry_bump(self):
        self.worker._save_failed("t1", "flac: decode_frame overrun")
        sql = self.track_sql()
        self.assertIn("'permanently_failed'", sql)
        self.assertNotIn('COALESCE("analysisRetryCount"', sql)
        self.assertTrue(self.db.cursor.statements[0][1][0].startswith("DAMAGED::"))
        # Successful terminal write commits; the guard rollback must not fire.
        self.assertEqual(self.db.commits, 1)
        self.assertEqual(self.db.rollbacks, 0)

    def test_multichannel_becomes_permanently_failed_and_named(self):
        self.worker._save_failed("t2", "Audio file has more than 2 channels")
        self.assertIn("'permanently_failed'", self.track_sql())
        self.assertTrue(self.db.cursor.statements[0][1][0].startswith("MULTICANNEL::"))

    def test_unsupported_names_the_codec(self):
        self.worker._save_failed("t3", "unsupported codec: dts")
        self.assertIn("'permanently_failed'", self.track_sql())
        self.assertTrue(self.db.cursor.statements[0][1][0].startswith("UNSUPPORTED::dts"))

    def test_inconclusive_stays_failed_and_increments_retry(self):
        # The inverted test: a damage-shaped message must NOT slip through
        # as retryable, and a genuine retryable error must bump retryCount.
        self.worker._save_failed("t4", "temporary transient io glitch")
        sql = self.track_sql()
        self.assertIn("'failed'", sql)
        self.assertIn(
            '"analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1',
            sql,
        )

    def test_batch_timeout_is_reset_pending_without_penalty(self):
        # Even a damage-looking message is exempted when the failure was an
        # innocent-batch-timeout; that path must never be quarantined.
        self.worker._save_failed(
            "t5", "flac: decode_frame overrun", is_timeout=True)
        sql = self.track_sql()
        self.assertIn("'pending'", sql)
        self.assertNotIn("'permanently_failed'", sql)

    # -- TrackStage settlement (the record drives the stage queue) ----------

    def test_damaged_settles_stage_record_closed(self):
        self.worker._save_failed("t1", "flac: decode_frame overrun")
        self.assertSettledTerminal("DAMAGED")

    def test_multichannel_settles_stage_record_closed(self):
        self.worker._save_failed("t2", "Audio file has more than 2 channels")
        self.assertSettledTerminal("MULTICANNEL")

    def test_unsupported_settles_stage_record_with_codec_evidence(self):
        self.worker._save_failed("t3", "unsupported codec: dts")
        self.assertSettledTerminal("UNSUPPORTED")
        evidence = json.loads(self.stage_params()[6])
        self.assertEqual(evidence["codec"], "dts")

    def test_inconclusive_settles_stage_record_retryable_with_backoff(self):
        # The engine's rules, mirrored: attempt is READ from the record (the
        # fake cursor has no attempt -> 0 -> this is attempt 1), retryable
        # below STAGE_RETRY_CAP, and the wait is the ladder's 30s -- not the
        # old flat 30 minutes.
        self.worker._save_failed("t4", "temporary transient io glitch")
        sql = self.stage_sql()
        self.assertIn('"TrackStage"', sql)
        self.assertIn("'failed'", sql)
        self.assertIn("retryable = EXCLUDED.retryable", sql)
        self.assertIn("interval '1 second'", sql)
        self.assertNotIn("interval '30 minutes'", sql)
        self.assertNotIn("attempt + 1", sql)
        params = self.stage_params()
        self.assertEqual(params[2], 1)                       # attempt = 0 + 1
        self.assertEqual(params[3], "temporary transient io glitch")
        self.assertEqual(params[4], "INCONCLUSIVE")
        self.assertEqual(params[5], True)                    # retryable
        self.assertEqual(params[6], 30)                      # ladder wait
        self.assertIn("error", json.loads(params[8]))

    def test_batch_timeout_settles_stage_record_pending_without_penalty(self):
        self.worker._save_failed(
            "t5", "flac: decode_frame overrun", is_timeout=True)
        sql = self.stage_sql()
        self.assertIn("'pending'", sql)
        self.assertNotIn("attempt + 1", sql)
        self.assertIn("retryable = true", sql)
        params = self.stage_params()
        self.assertIn("timeout", json.loads(params[4]))

    def test_stage_record_writes_share_the_track_transaction(self):
        # Record and column are written in ONE transaction: a crash between
        # them must roll both back, never answer the queue without the row.
        self.worker._save_failed("t6", "flac: decode_frame overrun")
        self.assertEqual(self.db.commits, 1)

    def test_results_settle_the_stage_record_done(self):
        # The success path must answer the stage record too -- otherwise the
        # dispatched 'working' record never resolves and the queue stalls.
        features: dict[str, Any] = {k: None for k in (
            "bpm", "beatsCount", "key", "keyScale", "keyStrength", "energy",
            "loudness", "dynamicRange", "danceability", "valence", "arousal")}
        features.update(moodTags=[], essentiaGenres=[], analysisMode="standard")
        self.worker._save_results("t7", "/x.flac", features)
        # statements: Track UPDATE, TrackStage settle (the EnrichmentFailure
        # resolve is gone — one record per fact).
        sql, params = self.db.cursor.statements[1]
        self.assertIn('"TrackStage"', sql)
        self.assertIn("'done'", sql)
        self.assertIn("retryable = false", sql)
        self.assertIn("attempt + 1", sql)
        evidence = json.loads(params[3])
        self.assertEqual(evidence["essentiaVersion"], analyzer.ESSENTIA_VERSION)

    def test_every_damaged_message_remains_terminal(self):
        # Guard against a regression where a real damage message is left
        # retryable. The reverse of INCONCLUSIVE must be terminal here.
        for msg in ["flac: decode_frame", "more than 2 channels",
                    "unsupported codec: dts"]:
            disp = classify_failure(msg)
            self.assertNotEqual(
                disp, Disposition.INCONCLUSIVE,
                f"{msg!r} should be terminal, not retryable")


if __name__ == "__main__":
    unittest.main()
