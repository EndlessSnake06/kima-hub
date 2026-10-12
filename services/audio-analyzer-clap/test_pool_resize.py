"""The DB pool follows the worker count: the settings screen can raise an
analyzer's workers live, and the connections must be sized for the new count,
not the one the process booted with (a pool exhaust fails every job that hits
it), and never beyond what the server itself accepts."""
import threading
from unittest import mock

import pytest

import analyzer


def make_worker():
    return analyzer.BullMQVibeWorker(analyzer=None, stop_event=threading.Event(), concurrency=4)


def test_pool_size_follows_workers():
    worker = make_worker()
    worker._server_max_connections = 100
    assert worker._pool_size(4) == 8
    assert worker._pool_size(24) == 48
    assert worker._pool_size(1) == 8  # floor


def test_pool_size_never_exceeds_the_server_limit():
    worker = make_worker()
    worker._server_max_connections = 30
    # 24 workers want 48 connections; a 30-connection server keeps 10 for
    # everyone else, so the pool stops at 20 rather than wedging Postgres.
    assert worker._pool_size(24) == 20


def test_pool_size_falls_back_when_the_limit_is_unknown():
    worker = make_worker()
    worker._server_max_connections = None
    assert worker._pool_size(24) == 48


def test_resize_replaces_the_pool_not_reuses_it():
    worker = make_worker()
    with mock.patch.object(worker, "_read_server_max_connections", return_value=100):
        with mock.patch("psycopg2.pool.ThreadedConnectionPool") as pool_cls:
            worker._resize_pool(24)
    assert pool_cls.call_args.kwargs["maxconn"] == 48
    assert worker._db_pool is pool_cls.return_value


def test_resize_closes_the_old_pool():
    worker = make_worker()
    old = mock.Mock()
    worker._db_pool = old
    with mock.patch.object(worker, "_read_server_max_connections", return_value=100):
        with mock.patch("psycopg2.pool.ThreadedConnectionPool"):
            worker._resize_pool(2)
    old.closeall.assert_called_once()
