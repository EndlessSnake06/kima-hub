"""Retry-cap parity tests for ``AnalysisWorker._save_failed`` (INCONCLUSIVE).

The TypeScript twin of this failure sink — ``recordStageFailure`` in
backend/src/workers/unifiedEnrichment.ts — applies the rules the engine
actually runs:

  - attempt = (the TrackStage record's attempt) + 1, read from the row;
  - ``retryable = failureClass == "INCONCLUSIVE" && attempt < STAGE_RETRY_CAP``
    (cap = 3);
  - ``nextRetryAt = now + computeStageRetryWaitMs(attempt)`` — 30s, 60s,
    120s, never more — and NULL once the record closes;
  - at the cap the record closes TERMINALLY (retryable = false,
    nextRetryAt = NULL): it is never offered again until a human re-decides;
  - an already-closed record (failed, not retryable) is never resurrected.

The analyzer's INCONCLUSIVE branch did none of this: it wrote
``retryable = true`` and ``nextRetryAt = now() + interval '30 minutes'``
forever, and its only cap check was a log line. These tests pin the parity.

Run from the service dir:
    cd services/audio-analyzer && python3 -m pytest test_save_failed_retry_cap.py -v
"""

import json
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

STAGE_RETRY_CAP = 3


def _stage_row(attempt: int, *, status: str = "pending", retryable: bool = True):
    return {"attempt": attempt, "retryable": retryable, "status": status}


class _FakeCursor:
    """Recording cursor whose fetchone() answers the TrackStage SELECT.

    The INCONCLUSIVE branch must READ the attempt from the TrackStage row it
    is about to settle, so the cursor is primed with that row up front.
    """

    def __init__(self, stage_row: dict | None):
        self.stage_row = stage_row
        self.statements: list[tuple[str, tuple]] = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params if params is not None else ()))
        self.rowcount = 1

    def executemany(self, *a):
        pass

    def fetchone(self):
        return self.stage_row

    def fetchall(self):
        return []

    def close(self):
        pass


class _RecordingDB:
    def __init__(self, stage_row: dict | None):
        self.cursor = _FakeCursor(stage_row)
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self) -> _FakeCursor:
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class RetryLadderParityTest(unittest.TestCase):
    """The backoff function itself mirrors computeStageRetryWaitMs exactly."""

    def test_ladder_matches_typescript(self):
        # 30s * 2^(attempt-1), floored at 30s, capped at 120s.
        self.assertEqual(analyzer.compute_stage_retry_wait_seconds(0), 30)
        self.assertEqual(analyzer.compute_stage_retry_wait_seconds(1), 30)
        self.assertEqual(analyzer.compute_stage_retry_wait_seconds(2), 60)
        self.assertEqual(analyzer.compute_stage_retry_wait_seconds(3), 120)
        self.assertEqual(analyzer.compute_stage_retry_wait_seconds(4), 120)

    def test_cap_matches_typescript(self):
        self.assertEqual(analyzer.STAGE_RETRY_CAP, STAGE_RETRY_CAP)


class SaveFailedCapTest(unittest.TestCase):
    def setUp(self):
        self.worker: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)

    def _run(self, stage_row: dict | None, error: str = "temporary transient io glitch"):
        self.db = _RecordingDB(stage_row)
        self.worker.db = self.db
        self.worker._save_failed("t1", error)
        return self.db

    def _stage_write(self):
        for sql, params in self.db.cursor.statements:
            if 'INTO "TrackStage"' in sql:
                return sql, params
        raise AssertionError("no TrackStage upsert was executed")

    def _track_update(self):
        for sql, params in self.db.cursor.statements:
            if 'UPDATE "Track"' in sql:
                return sql, params
        raise AssertionError("no Track update was executed")

    def test_attempt_below_cap_stays_retryable_with_ladder_wait(self):
        # The record sits at attempt 0; this failure is attempt 1 -> 30s wait.
        self._run(_stage_row(0))

        sql, params = self._stage_write()
        self.assertIn('"TrackStage"', sql)
        self.assertIn("'failed'", sql)
        # Retryable below the cap, and the wait comes in as a computed
        # seconds param (30 for attempt 1), not a flat 30 minutes.
        self.assertIn("retryable = EXCLUDED.retryable", sql)
        self.assertIn("interval '1 second'", sql)
        # params: (id, trackId, attempt, lastErrorMessage, failureClass,
        #          retryable, wait_seconds|None, evidence)
        self.assertEqual(params[2], 1)                      # attempt = 0 + 1
        self.assertEqual(params[4], "INCONCLUSIVE")
        self.assertEqual(params[5], True)                   # retryable
        self.assertEqual(params[6], 30)                     # ladder wait
        evidence = json.loads(params[8])                    # wait passed twice (CASE + multiply)
        self.assertIn("error", evidence)

        # The Track column mirrors a retryable failure: 'failed' + bump.
        track_sql, track_params = self._track_update()
        self.assertIn("'failed'", track_sql)
        self.assertIn(
            '"analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1',
            track_sql,
        )
        self.assertNotIn("'permanently_failed'", track_sql)
        # The attempt was READ from the record, not guessed in SQL: the
        # SELECT happens before any write.
        first_sql = self.db.cursor.statements[0][0]
        self.assertIn('FROM "TrackStage"', first_sql)
        self.assertIn("attempt", first_sql)

    def test_mid_ladder_attempt_waits_60s(self):
        # attempt 1 on the record -> this is attempt 2 -> 60s.
        self._run(_stage_row(1))
        _, params = self._stage_write()
        self.assertEqual(params[2], 2)
        self.assertEqual(params[5], True)
        self.assertEqual(params[6], 60)

    def test_attempt_at_cap_closes_the_record_terminally(self):
        # attempt 2 on the record -> this is attempt 3 == the cap: closed.
        self._run(_stage_row(2))

        sql, params = self._stage_write()
        self.assertEqual(params[2], STAGE_RETRY_CAP)
        self.assertEqual(params[5], False)                  # retryable = false
        self.assertIsNone(params[6])                        # nextRetryAt NULL

        # The Track column mirrors the terminal truth: permanently_failed,
        # with no retry bump -- re-offering cannot change the answer.
        track_sql, _ = self._track_update()
        self.assertIn("'permanently_failed'", track_sql)
        self.assertNotIn(
            '"analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1',
            track_sql,
        )

    def test_beyond_cap_stays_closed(self):
        # A record somehow past the cap closes all the same.
        self._run(_stage_row(5))
        _, params = self._stage_write()
        self.assertEqual(params[5], False)
        self.assertIsNone(params[6])

    def test_already_closed_record_is_never_resurrected(self):
        # failed + retryable=false on the record: TS recordStageFailure
        # returns without touching it. The column is still settled (the
        # analyzer owns that mirror) but the record is left exactly as-is.
        self._run(_stage_row(2, status="failed", retryable=False))

        for sql, _ in self.db.cursor.statements:
            self.assertNotIn('INTO "TrackStage"', sql)
        track_sql, _ = self._track_update()
        self.assertIn("'permanently_failed'", track_sql)


if __name__ == "__main__":
    unittest.main()
