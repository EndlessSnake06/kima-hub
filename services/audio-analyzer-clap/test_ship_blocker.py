"""
The image can run ONNX: requirements.txt carries onnxruntime,
_ensure_onnx_backend loads the model eagerly, and with CLAP_BACKEND=onnx a
window failure fails the track instead of falling back to torch.
"""
import importlib.util
import os
import sys

import numpy as np

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location("clap_analyzer_under_test", os.path.join(SERVICE_DIR, "analyzer.py"))
assert _spec and _spec.loader
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["clap_analyzer_under_test"] = analyzer
_spec.loader.exec_module(analyzer)
CLAPAnalyzer = analyzer.CLAPAnalyzer


def test_ensure_onnx_backend_eagerly_loads_model(monkeypatch):
    # Construction and load must happen in _ensure_onnx_backend (which the
    # startup path calls before claiming ONNX works), and the load must not
    # raise when the shipped model and onnxruntime are present.
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "onnx")
    a = CLAPAnalyzer()
    a._ensure_onnx_backend()
    assert a.onnx_backend is not None
    assert a.onnx_backend._sess is not None, "model session not loaded eagerly"


def test_ensure_onnx_backend_raises_on_broken_model(monkeypatch, tmp_path):
    # A broken model path must fail LOUDLY at ensure time (startup), not at the
    # first embed call.
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "onnx")
    a = CLAPAnalyzer()
    dead = str(tmp_path / "does-not-exist.onnx")
    import onnx_backend
    import pytest

    class BrokenBackend(onnx_backend.OnnxCLAPBackend):
        def __init__(self, *args, **kwargs):
            super().__init__(dead)

    # Patched at the source module: _ensure_onnx_backend imports OnnxCLAPBackend at call time.
    monkeypatch.setattr(onnx_backend, "OnnxCLAPBackend", BrokenBackend)
    with pytest.raises(Exception):
        a._ensure_onnx_backend()


def test_a_failed_window_fails_the_track_without_torch(monkeypatch):
    # One window that fails to load means no vector: the other windows are never
    # averaged as the whole track, and the torch path is never touched.
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "onnx")
    a = CLAPAnalyzer()
    loads = {"n": 0}

    class Backend:
        def embed_clips(self, clips):
            raise AssertionError("must not embed a track with a failed window")

    def load(path, start, seconds, duration):
        loads["n"] += 1
        return (None, 0) if loads["n"] == 3 else (np.zeros(480000, dtype=np.float32), 48000)

    a.onnx_backend = Backend()
    monkeypatch.setattr(a, "_load_window", load)
    monkeypatch.setattr(analyzer.os.path, "exists", lambda p: True)
    monkeypatch.setattr(analyzer.librosa, "get_duration", lambda path: 240.0)
    assert a.get_audio_embedding("/music/x.flac") is None
    assert loads["n"] == 3
    assert a.model is None


def _pins(text: str) -> dict:
    import re
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r"^'?([A-Za-z0-9_.-]+)==([^\s'\\]+)", text, re.M)}


def test_the_runtime_stack_is_pinned_exactly_and_the_same_in_every_image():
    with open(os.path.join(SERVICE_DIR, "requirements.txt")) as f:
        pinned = _pins(f.read())
    for name in ("onnxruntime", "transformers", "librosa", "soundfile", "numpy"):
        assert name in pinned, f"{name} is not pinned with == in requirements.txt"
    with open(os.path.join(SERVICE_DIR, "..", "..", "Dockerfile")) as f:
        image = _pins("\n".join(line.strip() for line in f))
    for name in ("onnxruntime", "transformers", "librosa", "soundfile", "numpy", "bullmq"):
        assert image.get(name) == pinned[name], f"the all-in-one image pins {name}=={image.get(name)}"
    with open(os.path.join(SERVICE_DIR, "..", "audio-analyzer", "requirements.txt")) as f:
        analysis = _pins(f.read())
    for name in ("onnxruntime", "numpy"):
        assert analysis.get(name) == pinned[name], f"the analysis service pins {name}=={analysis.get(name)}"


def test_text_embeddings_routes_to_onnx_not_torch(monkeypatch):
    # CLAP_BACKEND=onnx: _text_embeddings must use the ONNX text backend and
    # never load the torch laion_clap model (self.model stays None).
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "onnx")
    calls = {"torch": 0}
    a = CLAPAnalyzer()

    def fail_torch(*args, **kwargs):
        calls["torch"] += 1
        raise AssertionError("torch model must not load in onnx mode")

    monkeypatch.setattr(a, "ensure_model", fail_torch)

    try:
        a._text_embeddings(["music with singing vocals"])
    except Exception:
        # Without the text model present this raises; the key assertion is that
        # it did NOT fall through to torch (which would have triggered the
        # monkeypatched ensure_model above).
        assert calls["torch"] == 0, "text path fell back to torch in onnx mode"
        return
    assert calls["torch"] == 0


def test_text_embeddings_torch_mode_still_loads_model(monkeypatch):
    # CLAP_BACKEND=torch: _text_embeddings uses the torch path.
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "torch")
    calls = {"torch": 0}
    a = CLAPAnalyzer()

    def fake_ensure_model():
        calls["torch"] += 1

    def fake_get_text_embedding(prompts, *args, **kwargs):
        return [np.zeros(512, dtype=np.float32) for _ in prompts]

    monkeypatch.setattr(a, "ensure_model", fake_ensure_model)
    m = type("M", (), {})()
    m.get_text_embedding = fake_get_text_embedding  # instance attr: no self-binding
    monkeypatch.setattr(a, "model", m)

    embs = a._text_embeddings(["test prompt"])
    assert calls["torch"] == 1, "torch mode should call ensure_model"
    assert len(embs) == 1
    assert embs[0].shape == (512,)