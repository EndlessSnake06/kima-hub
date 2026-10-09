"""A GPU switch takes effect on its own: each analyzer asks whether its switch, or the runtime's install,
changed since it started, and restarts between tracks when it did. Every image ships the rule beside the
wrapper and the analyzers."""
import json
import os
import re
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(SERVICE_DIR))
sys.path.insert(0, SERVICE_DIR)

import gpu_runtime  # noqa: E402
import gpu_switch  # noqa: E402


def _settled(monkeypatch):
    monkeypatch.setattr(gpu_switch, "_started", __import__("time").monotonic() - gpu_switch.SETTLE_SECONDS)


def _data(tmp_path, monkeypatch, *, switches, installed):
    root = tmp_path / "gpu-onnx"
    (root / "site" / "nvidia" / "cublas" / "lib").mkdir(parents=True, exist_ok=True)
    runtime = root / "site" / "onnxruntime"
    if installed:
        runtime.mkdir(exist_ok=True)
    elif runtime.exists():
        runtime.rmdir()
    (root / "state.json").write_text(json.dumps({"status": "installed" if installed else "installing"}))
    (root / "enabled.json").write_text(json.dumps({"enabled": any(switches.values()), **switches}))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return root


def test_the_runtime_is_wanted_only_when_its_switch_is_on_and_it_is_installed(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    site, libs = gpu_switch.runtime_for("soundVectors")
    assert site.endswith("site") and libs[0].endswith(os.path.join("cublas", "lib"))
    assert gpu_switch.runtime_for("analysis") is None
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": True}, installed=False)
    assert gpu_switch.runtime_for("soundVectors") is None


def test_nothing_is_wanted_without_the_files(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert gpu_switch.runtime_for("soundVectors") is None


def test_a_restart_is_needed_exactly_when_the_wanted_runtime_differs_from_the_one_started_with(tmp_path, monkeypatch):
    _settled(monkeypatch)
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    assert gpu_switch.restart_needed("soundVectors") is True
    assert gpu_switch.restart_needed("analysis") is False
    monkeypatch.setenv("KIMA_GPU_RUNTIME", "1")
    assert gpu_switch.restart_needed("soundVectors") is False
    assert gpu_switch.restart_needed("analysis") is True


def test_the_sound_vector_analyzer_waits_for_an_install_or_removal_to_finish(tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_switch", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    _settled(monkeypatch)
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    monkeypatch.setattr(gpu_runtime, "busy", lambda: True)
    assert analyzer.gpu_switch_changed() is False
    monkeypatch.setattr(gpu_runtime, "busy", lambda: False)
    assert analyzer.gpu_switch_changed() is True


def test_every_image_ships_the_rule_beside_the_wrapper_and_the_analyzers():
    def copies(dockerfile):
        with open(os.path.join(REPO, dockerfile)) as f:
            instructions = re.sub(r"\\\n\s*", " ", f.read())
        return re.findall(r"^COPY .*gpu_switch\.py.*$", instructions, re.M)
    all_in_one = " ".join(copies("Dockerfile"))
    assert "/app/audio-analyzer-clap/" in all_in_one and "/app/audio-analyzer/" in all_in_one
    assert copies("services/audio-analyzer/Dockerfile"), "the analysis image lacks gpu_switch.py"
    assert copies("services/audio-analyzer-clap/Dockerfile"), "the sound-vector image lacks gpu_switch.py"


def test_a_start_forgets_the_last_start_s_gpu_answer(tmp_path, monkeypatch):
    root = _data(tmp_path, monkeypatch, switches={"soundVectors": False, "analysis": True}, installed=True)
    _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.record_provider(True)
    assert json.loads((root / "state.json").read_text())["provider"]["active"] is True
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_start", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    monkeypatch.setattr(analyzer, "BullMQVibeWorker", lambda *a, **k: type("W", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "TextEmbedHandler", lambda *a, **k: type("T", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "ControlHandler", lambda *a, **k: type("C", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "load_configured_workers", lambda: 1)
    monkeypatch.setattr(analyzer.time, "sleep", lambda s: (_ for _ in ()).throw(KeyboardInterrupt()))
    analyzer.main()
    assert json.loads((root / "state.json").read_text())["provider"]["active"] is False
    assert json.loads((root / "state.json").read_text())["provider"]["measured"] is False
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "torch")
    analyzer.main()
    provider = json.loads((root / "state.json").read_text())["provider"]
    assert provider["measured"] is True and provider["active"] is False, "a torch start left the page applying"


def _runtime_at(tmp_path, monkeypatch):
    root = tmp_path / "gpu-onnx"
    root.mkdir(exist_ok=True)
    for name, value in (("ROOT", root), ("SITE", root / "site"), ("STATE_PATH", root / "state.json"),
                        ("ENABLED_PATH", root / "enabled.json")):
        monkeypatch.setattr(gpu_runtime, name, str(value))
    monkeypatch.setattr(gpu_runtime, "_install_thread", None)
    return root


def _want(root, on):
    (root / "enabled.json").write_text(json.dumps({"enabled": on, "soundVectors": on, "analysis": False}))


def _fake_steps(root, monkeypatch, gate=None, remove_fails=False):
    import shutil
    import threading
    ran = []

    def install():
        ran.append("install")
        if gate:
            gate.wait(5)
        (root / "site" / "onnxruntime").mkdir(parents=True, exist_ok=True)
        gpu_runtime.update_state(status="installed")
        return "installed"

    def remove():
        ran.append("remove")
        if gate:
            gate.wait(5)
        if remove_fails:
            gpu_runtime.update_state(status="failed", detail="removal failed")
            return "failed"
        shutil.rmtree(root / "site", ignore_errors=True)
        gpu_runtime.update_state(status="idle")
        return "removed"

    monkeypatch.setattr(gpu_runtime, "_install", install)
    monkeypatch.setattr(gpu_runtime, "_remove", remove)
    return ran, threading


def _settle():
    import time
    deadline = time.time() + 5
    while gpu_runtime.busy() and time.time() < deadline:
        time.sleep(0.01)
    assert not gpu_runtime.busy()


def test_switching_off_during_a_download_removes_the_runtime_once_the_download_ends(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gate = __import__("threading").Event()
    ran, _ = _fake_steps(root, monkeypatch, gate=gate)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    _want(root, False)
    assert gpu_runtime.dispatch("remove") == "busy"
    gate.set()
    _settle()
    assert ran == ["install", "remove"]
    assert not (root / "site").exists()


def test_switching_on_during_a_removal_downloads_the_runtime_once_the_removal_ends(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    gate = __import__("threading").Event()
    ran, _ = _fake_steps(root, monkeypatch, gate=gate)
    _want(root, False)
    assert gpu_runtime.dispatch("remove") == "started"
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "busy"
    gate.set()
    _settle()
    assert ran == ["remove", "install"]
    assert gpu_runtime.is_installed()


def test_a_removal_sent_while_the_analyzer_was_down_happens_at_its_start(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, False)
    assert gpu_runtime.reconcile() == "remove"
    _settle()
    assert ran == ["remove"] and not (root / "site").exists()


def test_a_start_retries_an_install_its_predecessor_was_killed_in(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.update_state(status="installing", startedEpoch=__import__("time").time())
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, True)
    assert gpu_runtime.reconcile() == "install"
    _settle()
    assert ran == ["install"] and gpu_runtime.is_installed()


def test_a_removal_that_leaves_files_fails_once_instead_of_repeating(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    removals = []
    monkeypatch.setattr(gpu_runtime.shutil, "rmtree", lambda path, ignore_errors=False: removals.append(path))
    _want(root, False)
    gpu_runtime.dispatch("remove")
    _settle()
    assert removals.count(str(root / "site")) == 1
    assert gpu_runtime.read_state()["status"] == "failed"
    assert gpu_runtime.read_state()["reason"] == "removal_failed"


def test_a_failed_step_is_not_repeated_and_a_failed_download_waits_for_a_restart_or_a_click(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    ran, _ = _fake_steps(root, monkeypatch, remove_fails=True)
    _want(root, False)
    gpu_runtime.dispatch("remove")
    _settle()
    assert ran == ["remove"]
    _want(root, True)
    assert gpu_runtime._next_action(retry_failed=False) is None
    assert gpu_runtime._next_action(retry_failed=True) == "install"


def test_a_restart_finishes_running_jobs_within_their_lock_while_search_keeps_answering(monkeypatch):
    import importlib.util
    import threading
    import time as real_time
    spec = importlib.util.spec_from_file_location("clap_analyzer_drain", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    search_stop = []
    seen = []

    class StuckJobs:
        def __init__(self, _analyzer, stop, concurrency):
            self.stop = stop

        def start(self):
            self.stop.wait()
            seen.append(not search_stop[0].is_set())
            threading.Event().wait()

    class Search:
        def __init__(self, _analyzer, stop):
            search_stop.append(stop)

        def start(self):
            search_stop[0].wait()

    class Control:
        def __init__(self, stop, worker=None):
            self.stop = stop

        def start(self):
            self.stop.wait()

    class Clock:
        time = staticmethod(real_time.time)
        sleep = staticmethod(lambda s: real_time.sleep(min(s, 0.01)))

    monkeypatch.setattr(analyzer, "BullMQVibeWorker", StuckJobs)
    monkeypatch.setattr(analyzer, "TextEmbedHandler", Search)
    monkeypatch.setattr(analyzer, "ControlHandler", Control)
    monkeypatch.setattr(analyzer, "load_configured_workers", lambda: 1)
    monkeypatch.setattr(analyzer, "gpu_switch_changed", lambda: True)
    monkeypatch.setattr(analyzer, "JOB_LOCK_MS", 300)
    monkeypatch.setattr(analyzer, "time", Clock)
    monkeypatch.setattr(analyzer.signal, "signal", lambda *a: None)
    started = real_time.time()
    analyzer.main()
    assert real_time.time() - started < 3, "a stuck job held the restart past its lock"
    assert seen == [True], "search stopped before the running jobs were done"


def test_a_new_process_waits_before_acting_on_a_switch_so_its_exit_is_not_a_failed_start(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    monkeypatch.setattr(gpu_switch, "_started", __import__("time").monotonic())
    assert gpu_switch.restart_needed("soundVectors") is False
    _settled(monkeypatch)
    assert gpu_switch.restart_needed("soundVectors") is True


def test_the_wait_covers_every_analyzer_program_s_start_window_in_the_all_in_one_image():
    with open(os.path.join(REPO, "Dockerfile")) as f:
        dockerfile = f.read()
    windows = {name: int(secs) for name, secs in re.findall(
        r"\[program:(audio-analyzer[\w-]*)\][^\[]*?startsecs=(\d+)", dockerfile)}
    assert set(windows) == {"audio-analyzer", "audio-analyzer-clap"}
    assert all(gpu_switch.SETTLE_SECONDS >= secs for secs in windows.values()), windows


def test_a_process_without_the_runtime_never_asks_for_a_gpu_session(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    assert gpu_runtime.request_gpu() is False
    monkeypatch.setenv("KIMA_GPU_RUNTIME", "1")
    assert gpu_runtime.request_gpu() is True


def test_a_start_leaves_a_running_install_alone(tmp_path, monkeypatch):
    import threading
    root = _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.update_state(status="installing", startedEpoch=__import__("time").time())
    _want(root, True)
    hold = threading.Event()
    running = threading.Thread(target=hold.wait, daemon=True)
    running.start()
    monkeypatch.setattr(gpu_runtime, "_install_thread", running)
    assert gpu_runtime.reconcile() == "busy"
    assert gpu_runtime.read_state()["status"] == "installing"
    hold.set()


def test_a_data_folder_that_cannot_be_written_costs_the_answer_never_the_analyzer(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    _want(root, True)
    root.chmod(0o555)
    try:
        gpu_runtime.record_provider(False, "not measured since this start", measured=False)
        assert gpu_runtime.dispatch("install") == "started"
        _settle()
        assert gpu_runtime._install_thread is None, "the failed install ran again"
    finally:
        root.chmod(0o755)
    assert not any(p.name.startswith(".install-") for p in root.iterdir())


def test_compose_s_shared_gpu_volume_is_a_folder_every_image_gives_to_its_user():
    def text(path):
        with open(os.path.join(REPO, path)) as f:
            return re.sub(r"\\\n\s*", " ", f.read())
    compose = text("docker-compose.yml")
    mounts = set(re.findall(r"gpu_runtime_data:(\S+)", compose))
    assert mounts == {"/app/gpu-onnx", "/gpu-onnx"}, mounts
    assert re.search(r"mkdir -p [^&]*/app/gpu-onnx.*chown -R node:node /app", text("backend/Dockerfile"))
    for image in ("services/audio-analyzer/Dockerfile", "services/audio-analyzer-clap/Dockerfile"):
        body = text(image)
        assert re.search(r"mkdir -p /gpu-onnx.*chown -R analyzer:analyzer [^\n]*/gpu-onnx", body), image
        assert body.index("chown -R analyzer:analyzer /app /gpu-onnx") < body.index("USER analyzer"), image


def test_the_sound_vector_worker_keeps_its_heartbeat_while_it_finishes_running_jobs(monkeypatch):
    import asyncio
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_close", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    monkeypatch.setattr(analyzer, "HEARTBEAT_SECONDS", 0.05)
    beats = []

    class Redis:
        def set(self, key, value):
            beats.append(key)

    class SlowClose:
        async def close(self):
            await asyncio.sleep(0.4)

    worker = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    worker._redis_client, worker._active_concurrency = Redis(), 1
    asyncio.run(worker._close(SlowClose()))
    assert beats.count("clap:worker:heartbeat") >= 3, beats


def test_a_runtime_without_cuda_libraries_adds_no_empty_entry_to_the_library_path(tmp_path, monkeypatch):
    import subprocess
    root = tmp_path / "gpu-onnx"
    (root / "site" / "onnxruntime").mkdir(parents=True)
    (root / "state.json").write_text(json.dumps({"status": "installed"}))
    (root / "enabled.json").write_text(json.dumps({"enabled": True, "soundVectors": True, "analysis": False}))
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    for start in (None, "/opt/lib"):
        run_env = dict(env, DATA_DIR=str(tmp_path), **({"LD_LIBRARY_PATH": start} if start else {}))
        out = subprocess.run(["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"], env=run_env,
                             capture_output=True, text=True, check=True).stdout
        lines = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        assert lines.get("KIMA_GPU_RUNTIME") == "1"
        assert lines.get("LD_LIBRARY_PATH") == start, lines.get("LD_LIBRARY_PATH")
