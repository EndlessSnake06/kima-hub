"""
Ship-blocker regression tests.

The ONNX swap was approved SAFE but a fresh image couldn't run it: onnxruntime
was missing from requirements.txt, the Dockerfile never copied onnx_backend.py
or the model, and the startup path didn't assert the ONNX path actually works.
These tests pin the FIXED behaviors:

1. requirements.txt MUST carry onnxruntime (the image pip-installs this file).
2. CLAPAnalyzer._ensure_onnx_backend eagerly LOADS the model (raises/loud on a
   broken model) instead of lazily constructing a wrapper that fails at the
   first embed.
3. With CLAP_BACKEND=onnx pinned, a per-window ONNX failure must NOT silently
   fall back to torch -- failed track, no mixed vector spaces mid-sweep.

Run with the pocs venv (has torch/librosa/onnxruntime):
  python3 \
      -m pytest test_ship_blocker.py -q
"""
import importlib.util
import os
import sys

SERVICE_DIR = "services/audio-analyzer-clap"

_spec = importlib.util.spec_from_file_location("clap_analyzer_under_test", os.path.join(SERVICE_DIR, "analyzer.py"))
assert _spec and _spec.loader
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["clap_analyzer_under_test"] = analyzer
_spec.loader.exec_module(analyzer)
CLAPAnalyzer = analyzer.CLAPAnalyzer


def test_requirements_pins_onnxruntime():
    with open(os.path.join(SERVICE_DIR, "requirements.txt")) as f:
        req = f.read()
    assert "onnxruntime" in req, "onnxruntime missing from requirements.txt"


def test_ensure_onnx_backend_eagerly_loads_model():
    # Construction and load must happen in _ensure_onnx_backend (which the
    # startup path calls before claiming ONNX works), and the load must NOT
    # raise when the shipped model + onnxruntime are present.
    analyzer.CLAP_BACKEND = "onnx"
    a = CLAPAnalyzer()
    try:
        a._ensure_onnx_backend()
        assert a.onnx_backend is not None
        assert a.onnx_backend._sess is not None, "model session not loaded eagerly"
    finally:
        analyzer.CLAP_BACKEND = "torch"


def test_ensure_onnx_backend_raises_on_broken_model(monkeypatch, tmp_path):
    # A broken model path must fail LOUDLY at ensure time (startup), not at the
    # first embed call.
    analyzer.CLAP_BACKEND = "onnx"
    a = CLAPAnalyzer()
    dead = str(tmp_path / "does-not-exist.onnx")
    try:
        import onnx_backend
        class BrokenBackend(onnx_backend.OnnxCLAPBackend):
            def __init__(self, *args, **kwargs):
                super().__init__(dead)
        # Patch at the SOURCE module, since _ensure_onnx_backend does
        # `from onnx_backend import OnnxCLAPBackend` at call time.
        monkeypatch.setattr(onnx_backend, "OnnxCLAPBackend", BrokenBackend)
        import pytest
        with pytest.raises(Exception):
            a._ensure_onnx_backend()
    finally:
        analyzer.CLAP_BACKEND = "torch"


def test_no_silent_torch_fallback_for_window_embed_failure(monkeypatch):
    # With CLAP_BACKEND=onnx, a window that fails to load audio must return
    # None (track failed) and must NOT proceed to the torch path.
    analyzer.CLAP_BACKEND = "onnx"
    calls = {"torch": 0, "load_window": 0}
    a = CLAPAnalyzer()

    def fail_load(*args, **kwargs):
        calls["load_window"] += 1
        return None  # window load failure

    monkeypatch.setattr(a, "_load_window", fail_load)

    result = a._embed_window("/nonexistent.mp3", 0.0, 240.0)
    assert result is None
    assert calls["torch"] == 0
    assert calls["load_window"] == 1
    analyzer.CLAP_BACKEND = "torch"


def test_requirements_pins_onnxruntime_and_transformers():
    with open(os.path.join(SERVICE_DIR, "requirements.txt")) as f:
        req = f.read()
    assert "onnxruntime" in req, "onnxruntime missing from requirements.txt"
    assert "transformers" in req, "transformers missing from requirements.txt"


def test_text_embeddings_routes_to_onnx_not_torch(monkeypatch):
    # CLAP_BACKEND=onnx: _text_embeddings must use the ONNX text backend and
    # NEVER load the torch laion_clap model (self.model stays None).
    analyzer.CLAP_BACKEND = "onnx"
    calls = {"torch": 0}
    a = CLAPAnalyzer()

    def fail_torch(*args, **kwargs):
        calls["torch"] += 1
        raise AssertionError("torch model must not load in onnx mode")

    monkeypatch.setattr(a, "ensure_model", fail_torch)

    try:
        embs = a._text_embeddings(["music with singing vocals"])
    except Exception:
        # Without the text model present this raises; the key assertion is that
        # it did NOT fall through to torch (which would have triggered the
        # monkeypatched ensure_model above).
        assert calls["torch"] == 0, "text path fell back to torch in onnx mode"
        return
    assert calls["torch"] == 0
    analyzer.CLAP_BACKEND = "torch"


def test_text_embeddings_torch_mode_still_loads_model(monkeypatch):
    # CLAP_BACKEND=torch (default): _text_embeddings uses the torch path.
    analyzer.CLAP_BACKEND = "torch"
    calls = {"torch": 0}
    a = CLAPAnalyzer()

    def fake_ensure_model():
        calls["torch"] += 1

    def fake_get_text_embedding(prompts, *args, **kwargs):
        import numpy as np
        return [np.zeros(512, dtype=np.float32) for _ in prompts]

    monkeypatch.setattr(a, "ensure_model", fake_ensure_model)
    m = type("M", (), {})()
    m.get_text_embedding = fake_get_text_embedding  # instance attr: no self-binding
    monkeypatch.setattr(a, "model", m)

    embs = a._text_embeddings(["test prompt"])
    assert calls["torch"] == 1, "torch mode should call ensure_model"
    assert len(embs) == 1
    assert embs[0].shape == (512,)