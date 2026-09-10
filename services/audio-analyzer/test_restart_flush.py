"""
Restart-flush test for the audio analyzer's queued-track reset.

On restart the analyzer resets 'queued' DB rows to 'pending' (the Redis list
may have been lost or gated during downtime) and flushes the Redis queue list
so the backend's re-push of those 'pending' rows can never double-queue the
same track on top of stale list entries.

Runs the REAL _reset_queued_on_restart method with a fake DB cursor and fake
Redis -- no postgres or redis server needed. Verify with:

  python3 -m pytest test_restart_flush.py -q
"""
import ast
import importlib.util
import sys

# Load the REAL audio-analyzer module by absolute path under a UNIQUE name.
# The clap service has its own analyzer.py, and both would otherwise collide
# on sys.modules["analyzer"] when the two services' tests run in one session.
_ANALYZER_PATH = "services/audio-analyzer/analyzer.py"
_spec = importlib.util.spec_from_file_location("audio_analyzer_under_test", _ANALYZER_PATH)
assert _spec and _spec.loader, f"cannot load {_ANALYZER_PATH}"
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["audio_analyzer_under_test"] = analyzer
_spec.loader.exec_module(analyzer)


class FakeCursor:
    def __init__(self, rowcount: int):
        self.rowcount = rowcount
        self.executed: list[str] = []

    def execute(self, sql: str, *args):
        self.executed.append(sql)

    def close(self):
        pass


class FakeDb:
    def __init__(self, rowcount: int):
        self.cursor = FakeCursor(rowcount)
        self.committed = 0
        self.rolled_back = 0

    def get_cursor(self):
        return self.cursor

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1


class FakeRedis:
    def __init__(self):
        self.deleted: list[str] = []

    def delete(self, key: str):
        self.deleted.append(key)


def make_worker(db: FakeDb, redis: FakeRedis) -> "analyzer.AnalysisWorker":
    # Bypass __init__ (which opens real Redis/Postgres connections) by
    # constructing a bare object and setting only what the method touches.
    worker = object.__new__(analyzer.AnalysisWorker)
    worker.db = db
    worker.redis = redis
    return worker


def test_resets_queued_rows_to_pending():
    db = FakeDb(rowcount=7)
    w = make_worker(db, FakeRedis())
    reset = w._reset_queued_on_restart()
    assert reset == 7
    assert "UPDATE \"Track\"" in db.cursor.executed[0]
    assert "'pending'" in db.cursor.executed[0]
    assert "'queued'" in db.cursor.executed[0]


def test_flushes_redis_queue_list():
    r = FakeRedis()
    db = FakeDb(rowcount=0)
    w = make_worker(db, r)
    w._reset_queued_on_restart()
    assert r.deleted == ["audio:analysis:queue"]


def test_flush_error_does_not_break_reset():
    class FlakyRedis(FakeRedis):
        def delete(self, key):
            raise ConnectionError("redis down")

    # Even if the flush fails, the DB reset must have committed and the method
    # must not raise.
    db = FakeDb(rowcount=0)
    w = make_worker(db, FlakyRedis())
    reset = w._reset_queued_on_restart()
    assert reset == 0
    assert db.committed == 1


def test_db_connect_failure_propagates():
    # cursor acquisition is deliberately OUTSIDE the try: a DB connection
    # failure at worker boot is fatal and must crash loudly, not be swallowed
    # into a silent 0 (the worker would otherwise start believing it reset
    # rows it never touched).
    class BrokenDb:
        def get_cursor(self):
            raise RuntimeError("server gone")

    w = make_worker(BrokenDb(), FakeRedis())
    try:
        w._reset_queued_on_restart()
        raise AssertionError("expected RuntimeError to propagate")
    except RuntimeError as e:
        assert "server gone" in str(e)


def test_module_syntax_is_valid():
    # Belt-and-braces: the whole file must still parse after the refactor.
    with open(analyzer.__file__) as f:
        ast.parse(f.read())