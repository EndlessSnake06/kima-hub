"""The sound-vector analyzer's reports carry this server's secret, made at random and kept in the Redis the
backend shares. Real Redis (REDIS_URL, else this checkout's test Redis) and a real HTTP listener in place of the
backend's address; nothing reads a fixed value or an environment variable."""
import importlib.util
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import redis

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6390")


@pytest.fixture
def backend():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.path, self.headers["X-Internal-Secret"], json.loads(body)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", received
    server.shutdown()


@pytest.fixture
def worker(backend, monkeypatch):
    spec = importlib.util.spec_from_file_location("clap_analyzer_reports", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    monkeypatch.setattr(analyzer, "BACKEND_URL", backend[0])
    client = redis.from_url(REDIS_URL)
    client.delete(analyzer.INTERNAL_SECRET_KEY)
    w = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    w._redis_client = client
    yield analyzer, w, client
    client.delete(analyzer.INTERNAL_SECRET_KEY)


def test_reports_send_the_server_secret_from_redis(worker, backend, monkeypatch):
    analyzer, w, client = worker
    monkeypatch.setenv("INTERNAL_API_SECRET", "kima-internal-aio")
    w._report_success("job-1-r0", "track-1")
    w._report_success("job-2-r0", "track-2")
    stored = client.get(analyzer.INTERNAL_SECRET_KEY).decode()
    assert len(stored) == 64 and stored != "kima-internal-aio"
    assert [(path, secret, body["trackId"]) for path, secret, body in backend[1]] == [
        ("/api/analysis/vibe/success", stored, "track-1"),
        ("/api/analysis/vibe/success", stored, "track-2"),
    ]


def test_a_secret_the_backend_made_first_is_the_one_sent(worker, backend):
    analyzer, w, client = worker
    client.set(analyzer.INTERNAL_SECRET_KEY, "made-by-the-backend")
    w._report_success("job-1-r0", "track-1")
    assert backend[1][0][1] == "made-by-the-backend"
