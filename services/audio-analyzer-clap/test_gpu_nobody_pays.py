"""
With the GPU switch off, nobody pays for it.

The offline half of the promise that a user who never touches the GPU toggle
loses nothing: the provider plan is exactly CPU, the env wrapper exports
nothing, no CUDA/nvidia module ever enters the process, and the image's own
dependency files never mention the runtime (it only ever arrives at runtime
into the data volume).

The live half — inspecting a toggle-off container on CUDA hardware — is done
on test-server, not here.

Run with the pocs venv:
  python3 \
      -m pytest test_gpu_nobody_pays.py -q
"""
import importlib.util
import json
import os
import subprocess
import sys

SERVICE_DIR = "services/audio-analyzer-clap"

CUDAISH = ("cuda", "nvidia", "cudnn", "cublas", "cufft", "curand")


def _cudaish_modules():
    return [m for m in sys.modules if any(k in m.lower() for k in CUDAISH)]


def _load(name, filename, data_dir):
    os.environ["DATA_DIR"] = str(data_dir)
    spec = importlib.util.spec_from_file_location(name, os.path.join(SERVICE_DIR, filename))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_plan_stays_cpu_when_toggle_off_even_with_cuda_available():
    ob = _load("obA", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(False, ["CUDAExecutionProvider", "CPUExecutionProvider"]) == \
        ["CPUExecutionProvider"]


def test_plan_stays_cpu_when_this_runtime_cannot_offer_cuda():
    ob = _load("obB", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(True, ["CPUExecutionProvider"]) == ["CPUExecutionProvider"]


def test_plan_asks_cuda_only_when_toggled_and_available():
    ob = _load("obC", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(True, ["CUDAExecutionProvider", "CPUExecutionProvider"]) == \
        ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_request_gpu_false_on_empty_data_dir_and_no_cudaish_modules():
    gr = _load("grA", "gpu_runtime.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert gr.read_enabled() is False
    assert gr.is_installed() is False
    assert gr.request_gpu() is False
    assert _cudaish_modules() == []


def test_env_wrapper_exports_nothing_when_toggle_off(tmp_path):
    out = subprocess.run(
        ["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"],
        env={**os.environ, "DATA_DIR": str(tmp_path), "PYTHONPATH": "", "LD_LIBRARY_PATH": ""},
        capture_output=True, text=True, check=True).stdout
    assert "gpu-onnx" not in out
    lines = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    assert lines.get("PYTHONPATH", "") == ""
    assert lines.get("LD_LIBRARY_PATH", "") == ""


def test_env_wrapper_activates_only_when_enabled_and_installed(tmp_path):
    site = tmp_path / "gpu-onnx" / "site"
    (site / "onnxruntime").mkdir(parents=True)
    (site / "nvidia" / "cublas" / "lib").mkdir(parents=True)
    root = tmp_path / "gpu-onnx"
    (root / "state.json").write_text(json.dumps({"status": "installed"}))
    # Installed but NOT enabled: still nothing (the toggle is the only switch).
    out = subprocess.run(
        ["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"],
        env={**os.environ, "DATA_DIR": str(tmp_path), "PYTHONPATH": "", "LD_LIBRARY_PATH": ""},
        capture_output=True, text=True, check=True).stdout
    assert "gpu-onnx" not in out
    (root / "enabled.json").write_text(json.dumps({"enabled": True}))
    lines = dict(l.split("=", 1) for l in subprocess.run(
        ["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"],
        env={**os.environ, "DATA_DIR": str(tmp_path), "PYTHONPATH": "", "LD_LIBRARY_PATH": ""},
        capture_output=True, text=True, check=True).stdout.splitlines() if "=" in l)
    assert str(site) in lines.get("PYTHONPATH", "")
    assert str(site / "nvidia" / "cublas" / "lib") in lines.get("LD_LIBRARY_PATH", "")


def test_shipped_dependency_files_never_mention_the_runtime():
    # The 3.4 GB CUDA set is pip-installed into the data volume at runtime.
    # If it ever leaks into the image files, every user pays — this is the tripwire.
    for name in ("requirements.txt", "Dockerfile"):
        with open(os.path.join(SERVICE_DIR, name)) as f:
            body = f.read().lower()
        for needle in ("onnxruntime-gpu", "nvidia", "cudnn", "cuda"):
            assert needle not in body, f"{name} mentions {needle!r}"
