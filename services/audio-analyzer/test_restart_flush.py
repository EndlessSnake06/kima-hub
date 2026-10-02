"""Analyzer restart safety: startup rewrites no Track columns, and the worker's
only claim is the pre-decode one, accepting every state the stage queue
dispatches from. Real AnalysisWorker claim, fake cursor."""
import ast
import inspect
import importlib.util
import os
import sys
from typing import Any

# Load the REAL audio-analyzer module by absolute path under a UNIQUE name.
# The clap service has its own analyzer.py, and both would otherwise collide
# on sys.modules["analyzer"] when the two services' tests run in one session.
_ANALYZER_PATH = os.path.join(os.path.dirname(__file__), "analyzer.py")
_spec = importlib.util.spec_from_file_location("audio_analyzer_under_test", _ANALYZER_PATH)
assert _spec and _spec.loader, f"cannot load {_ANALYZER_PATH}"
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["audio_analyzer_under_test"] = analyzer
_spec.loader.exec_module(analyzer)


class FakeCursor:
    def __init__(self, rowcount: int = 1):
        self.rowcount = rowcount
        self.executed: list[str] = []
        self.last_params = None

    def execute(self, sql: str, *args):
        self.executed.append(sql)
        self.last_params = args[0] if args else None

    def close(self):
        pass


class FakeDb:
    def __init__(self, rowcount: int = 1):
        self.cursor = FakeCursor(rowcount)
        self.committed = 0
        self.rolled_back = 0

    def get_cursor(self):
        return self.cursor

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1


def make_worker(db: FakeDb) -> Any:
    # Bypass __init__ (which opens real Redis/Postgres connections) by
    # constructing a bare object and setting only what the method touches.
    worker: Any = object.__new__(analyzer.AnalysisWorker)
    worker.db = db
    return worker


def test_column_rewriting_restart_paths_are_gone():
    # The flush, the reconciliation re-push and the failed-track re-queue
    # rewrote Track rows from column guesses; the record owns the attempt
    # now, so none of them may exist.
    for gone in ("_reset_queued_on_restart", "_run_db_reconciliation",
                 "_retry_failed_tracks", "_cleanup_stale_processing"):
        assert not hasattr(analyzer.AnalysisWorker, gone), f"{gone} still exists"


def test_start_makes_no_restart_time_track_writes():
    # start() must not UPDATE "Track" at boot: a restart that rewrites the
    # column contradicts whatever the stage record already answered.
    start_src = inspect.getsource(analyzer.AnalysisWorker.start)
    assert 'UPDATE "Track"' not in start_src
    assert "_reset_queued_on_restart" not in start_src
    assert "_cleanup_stale_processing" not in start_src


def test_claim_accepts_seeded_failed_tracks():
    # The stage queue re-asks tracks the old engine had marked failed (their
    # records were seeded failed+retryable); the claim must take them.
    db = FakeDb(rowcount=1)
    w = make_worker(db)
    claimed = w._mark_track_processing("trk1")
    assert claimed is True
    sql = db.cursor.executed[0]
    assert 'UPDATE "Track"' in sql
    assert "'processing'" in sql
    for acceptable in ("'pending'", "'queued'", "'failed'"):
        assert acceptable in sql, f"claim does not accept {acceptable}"
    # And it commits exactly once, never rolling a claim back silently.
    assert db.committed == 1
    assert db.rolled_back == 0


def test_unclaimed_track_reports_not_claimed():
    db = FakeDb(rowcount=0)
    w = make_worker(db)
    assert w._mark_track_processing("trk1") is False


def test_module_syntax_is_valid():
    # Belt-and-braces: the whole file must still parse after the refactor.
    with open(_ANALYZER_PATH) as f:
        ast.parse(f.read())
