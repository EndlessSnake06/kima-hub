"""
Installs and verifies the optional GPU ONNX runtime. The analyzer owns every
fact in state.json; the backend only writes the toggle and enabled.json.
Stdlib only at import, so nobody who leaves the toggle off pays for it.
"""

import ctypes
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
import threading
import time

ROOT = os.path.normpath(
    os.path.join(os.getenv('DATA_DIR', '/data'), 'gpu-onnx'))
SITE = os.path.join(ROOT, 'site')
STATE_PATH = os.path.join(ROOT, 'state.json')
ENABLED_PATH = os.path.join(ROOT, 'enabled.json')

PIP_TIMEOUT_S = 1800
PIP_ATTEMPTS = 3
STALE_INSTALLING_S = PIP_TIMEOUT_S * PIP_ATTEMPTS + 300

CUDA_DRIVER_MIN = 12040

# The set checked on an RTX 4060 Ti (cosine 1.0 against the CPU over 25 tracks). Transitive closure
# pinned with --no-deps so nothing here shadows the image's numpy/protobuf/flatbuffers.
PINS = [
    ('onnxruntime-gpu', '1.22.0'),
    ('nvidia-cuda-runtime-cu12', '12.9.79'),
    ('nvidia-cublas-cu12', '12.9.2.10'),
    ('nvidia-cudnn-cu12', '9.26.0.51'),
    ('nvidia-cufft-cu12', '11.4.1.4'),
    ('nvidia-curand-cu12', '10.3.10.19'),
    ('nvidia-nvjitlink-cu12', '12.9.86'),
    ('nvidia-cuda-nvrtc-cu12', '12.9.86'),
    ('coloredlogs', '15.0.1'),
    ('humanfriendly', '10.0'),
    ('mpmath', '1.3.0'),
    ('sympy', '1.14.0'),
]

# sha256 of each pinned wheel, keyed by normalized distribution name.
PIN_SHA256 = {
    'onnxruntime-gpu': 'd30c1512f22b1f01bacb4f177d49cbefd23e0f4bef56066f1282992d133e6ff8',
    'nvidia-cuda-runtime-cu12': '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
    'nvidia-cublas-cu12': 'e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702',
    'nvidia-cudnn-cu12': 'ce8603d4ea88d134be5a92c5e0833d513bea1ce0ee4bbc5d649fcb8718d51cbf',
    'nvidia-cufft-cu12': 'c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28',
    'nvidia-curand-cu12': '49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e',
    'nvidia-nvjitlink-cu12': 'e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9',
    'nvidia-cuda-nvrtc-cu12': '210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4',
    'coloredlogs': '612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934',
    'humanfriendly': '1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477',
    'mpmath': 'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c',
    'sympy': 'e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5',
}

PINNED_DISPLAY = ['%s==%s' % (n, v) for n, v in PINS]

_lock = threading.Lock()
_install_thread = None
_cancel = threading.Event()


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, payload):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_state():
    state = read_json(STATE_PATH)
    if not isinstance(state, dict):
        return {'status': 'idle'}
    if state.get('status') == 'installing' and \
            time.time() - float(state.get('startedEpoch') or 0) > STALE_INSTALLING_S:
        state = dict(state, status='failed', reason='install_failed',
                     detail='install child abandoned (analyzer restarted mid-install)')
        write_json_atomic(STATE_PATH, state)
    return state


def update_state(**fields):
    with _lock:
        state = dict(read_state())
        state.update(fields)
        state['updatedAt'] = _now()
        write_json_atomic(STATE_PATH, state)
        return state


def read_enabled():
    """Whether the runtime is wanted: either switch (sound vectors, audio analysis) is on."""
    projection = read_json(ENABLED_PATH)
    return bool(projection and projection.get('enabled'))


def is_installed():
    return read_state().get('status') == 'installed' and os.path.isdir(
        os.path.join(SITE, 'onnxruntime'))


def request_gpu():
    """True only when the sound-vector switch is on AND the runtime is installed."""
    projection = read_json(ENABLED_PATH)
    return bool(projection and projection.get('soundVectors')) and is_installed()


def nvidia_lib_dirs():
    base = os.path.join(SITE, 'nvidia')
    dirs = []
    try:
        for pkg in sorted(os.listdir(base)):
            lib = os.path.join(base, pkg, 'lib')
            if os.path.isdir(lib):
                dirs.append(lib)
    except OSError:
        pass
    return dirs


def record_provider(active, detail=None):
    update_state(provider={'active': bool(active), 'recordedAt': _now(),
                           'detail': detail})


def _dir_bytes(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(dirpath, name))
    return total


def _platform_ok():
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        return 'unsupported_platform', 'linux/x86_64 required, got %s/%s' % (
            sys.platform, platform.machine())
    if sys.version_info[:2] != (3, 11):
        return 'unsupported_platform', 'CPython 3.11 required (pinned wheels), got %d.%d' % sys.version_info[:2]
    return None


def _gpu_visible():
    if not os.path.exists('/dev/nvidia0'):
        return 'no_gpu', 'no /dev/nvidia0 — the container has no NVIDIA device access'
    try:
        libcuda = ctypes.CDLL('libcuda.so.1')
    except OSError:
        return 'no_gpu', 'libcuda.so.1 not loadable — driver not visible in this container'
    try:
        if libcuda.cuInit(0) != 0:
            return 'no_gpu', 'cuInit failed — driver refused the handshake'
        version = ctypes.c_int(0)
        if libcuda.cuDriverGetVersion(ctypes.byref(version)) != 0:
            return 'no_gpu', 'cuDriverGetVersion failed'
        if version.value < CUDA_DRIVER_MIN:
            return 'driver_too_old', 'driver reports CUDA %d, need >= %d' % (
                version.value, CUDA_DRIVER_MIN)
    except Exception as exc:
        return 'no_gpu', 'driver handshake error: %s' % exc
    return None


def _externally_managed() -> bool:
    return os.path.exists(os.path.join(sysconfig.get_paths()['stdlib'], 'EXTERNALLY-MANAGED'))


def _pip(args, env=None, timeout=PIP_TIMEOUT_S):
    cmd = [sys.executable, '-m', 'pip'] + args
    if _externally_managed():
        cmd += ['--disable-pip-version-check']
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)


def _pip_tail(proc):
    text = (proc.stdout or '') + (proc.stderr or '')
    return '\n'.join(text.strip().splitlines()[-20:])


def _download(wheels_dir):
    specs = ['%s==%s' % (n, v) for n, v in PINS]
    last = None
    for _ in range(PIP_ATTEMPTS):
        proc = _pip(['download', '--no-deps', '--only-binary=:all:',
                     '--timeout', '30', '--retries', '2',
                     '-d', wheels_dir] + specs)
        if proc.returncode == 0:
            return None
        last = proc
        text = (proc.stdout or '') + (proc.stderr or '')
        if 'Could not find a version' in text or 'No matching distribution' in text:
            return ('install_failed', 'index rejected the pinned set\n' + _pip_tail(proc))
    text = (last.stdout or '') + (last.stderr or '')
    if 'Connection' in text or 'NewConnectionError' in text or \
            'Max retries' in text or 'Temporary failure' in text or \
            'timed out' in text.lower():
        return ('no_network', _pip_tail(last))
    return ('install_failed', _pip_tail(last))


def _verify_checksums(wheels_dir):
    by_name = {}
    for fname in sorted(os.listdir(wheels_dir)):
        if not fname.endswith('.whl'):
            continue
        dist = fname.split('-')[0].lower().replace('_', '-')
        by_name[dist] = os.path.join(wheels_dir, fname)
    missing = [n for n, _ in PINS if n not in by_name]
    if missing:
        return 'checksum_mismatch', 'wheel missing after download: %s' % ', '.join(missing)
    total = 0
    for name, _ in PINS:
        path = by_name[name]
        digest = hashlib.sha256()
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                digest.update(chunk)
        expected = PIN_SHA256.get(name)
        if expected is None:
            return 'checksum_mismatch', 'no pinned sha256 for %s' % name
        if digest.hexdigest() != expected:
            return 'checksum_mismatch', '%s: got %s want %s' % (name, digest.hexdigest(), expected)
        total += os.path.getsize(path)
    return None, total


def _smoke_test(site_dir):
    libs = nvidia_lib_dirs()
    env = dict(os.environ, PYTHONPATH=site_dir)
    if libs:
        env['LD_LIBRARY_PATH'] = ':'.join(libs)
    try:
        proc = subprocess.run(
            [sys.executable, '-c',
             'import json, onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))'],
            capture_output=True, text=True, timeout=120, env=env)
    except subprocess.TimeoutExpired:
        return 'install_failed', 'post-install import test timed out'
    if proc.returncode != 0:
        return 'install_failed', 'post-install import failed\n' + _pip_tail(proc)
    try:
        providers = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return 'install_failed', 'post-install import test printed nothing usable'
    if 'CUDAExecutionProvider' not in providers:
        return 'install_failed', 'runtime installed but CUDA EP absent: %s' % providers
    return None, None


def _swap_site(tmp_site):
    old = SITE + '.old'
    shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(SITE):
        os.rename(SITE, old)
    try:
        os.rename(tmp_site, SITE)
    except OSError:
        if os.path.isdir(old):
            os.rename(old, SITE)
        raise
    shutil.rmtree(old, ignore_errors=True)


def _install():
    tmp_root = os.path.join(ROOT, '.install-%d' % int(time.time()))
    wheels_dir = os.path.join(tmp_root, 'wheels')
    tmp_site = os.path.join(tmp_root, 'site')
    os.makedirs(wheels_dir)
    try:
        update_state(status='installing', startedEpoch=time.time(),
                     startedAt=_now(), reason=None, detail=None)
        bad = _platform_ok()
        if bad:
            update_state(status='failed', reason=bad[0], detail=bad[1])
            return
        bad = _gpu_visible()
        if bad:
            update_state(status='failed', reason=bad[0], detail=bad[1])
            return
        if _cancel.is_set():
            update_state(status='idle', reason=None, detail='cancelled before download')
            return
        failure = _download(wheels_dir)
        if failure:
            update_state(status='failed', reason=failure[0], detail=failure[1])
            return
        if _cancel.is_set():
            update_state(status='idle', reason=None, detail='cancelled after download')
            return
        bad, nbytes = _verify_checksums(wheels_dir)
        if bad:
            update_state(status='failed', reason=bad, detail=str(nbytes))
            return
        args = ['install', '--no-deps', '--no-index', '--no-cache-dir',
                '--find-links', wheels_dir, '--target', tmp_site]
        if _externally_managed():
            args.append('--break-system-packages')
        specs = ['%s==%s' % (n, v) for n, v in PINS]
        proc = _pip(args + specs, timeout=600)
        if proc.returncode != 0:
            update_state(status='failed', reason='install_failed',
                         detail='pip --target failed\n' + _pip_tail(proc))
            return
        bad, tail = _smoke_test(tmp_site)
        if bad:
            update_state(status='failed', reason=bad, detail=tail)
            return
        _swap_site(tmp_site)
        update_state(status='installed', installedAt=_now(), reason=None, detail=None,
                     pinned=PINNED_DISPLAY, bytes=_dir_bytes(SITE))
    except Exception as exc:
        update_state(status='failed', reason='install_failed',
                     detail='unhandled installer error: %r' % exc)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
        update_state(installerDone=True)


def _remove():
    try:
        shutil.rmtree(SITE, ignore_errors=True)
        shutil.rmtree(os.path.join(ROOT, 'site.old'), ignore_errors=True)
        update_state(status='idle', reason=None, detail=None, pinned=None,
                     bytes=None, provider=None, installedAt=None)
    except Exception as exc:
        update_state(status='failed', reason='install_failed',
                     detail='removal failed: %r' % exc)


def dispatch(action):
    """Entry point for control messages and startup reconciliation."""
    global _install_thread
    with _lock:
        if _install_thread is not None and _install_thread.is_alive():
            if action == 'remove':
                _cancel.set()
            return 'busy'
        result = None
        if action == 'remove':
            result = 'started'
            target = _remove
        elif action == 'install':
            if not read_enabled():
                return 'skipped_disabled'
            if is_installed():
                return 'skipped_installed'
            _cancel.clear()
            result = 'started'
            target = _install
        else:
            return 'unknown_action'
        _install_thread = threading.Thread(target=target, name='gpu-runtime-install',
                                           daemon=True)
        _install_thread.start()
        return result


def reconcile():
    """Install if the projection says enabled and nothing is installed."""
    if read_enabled():
        state = read_state()
        if state.get('status') in ('idle', 'failed'):
            return dispatch('install')
    return 'nothing_to_do'