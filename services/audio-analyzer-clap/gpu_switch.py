"""
Whether a process's GPU switch wants the shared GPU runtime, and whether the process started with it. The
env wrapper (gpu_env.sh) decides from this before Python starts; each analyzer asks again while it runs and
restarts itself between tracks when the answer changed, so flipping a switch takes effect on its own.
Stdlib only: the wrapper runs it in every image.
"""
import json
import os
import sys
import time

# A process acts on a switch change only after running this long: the all-in-one image's supervisor counts an
# exit within a program's startsecs (at most 30 s) as a failed start, and stops restarting it after three.
SETTLE_SECONDS = 30
_started = time.monotonic()


def _root() -> str:
    return os.path.join(os.getenv('DATA_DIR', '/data'), 'gpu-onnx')


def runtime_for(switch: str):
    """(site dir, CUDA library dirs) when `switch` ('soundVectors' or 'analysis') is on and the runtime is
    installed, else None."""
    root = _root()
    try:
        with open(os.path.join(root, 'state.json')) as f:
            state = json.load(f)
        with open(os.path.join(root, 'enabled.json')) as f:
            enabled = json.load(f)
    except (OSError, ValueError):
        return None
    site = os.path.join(root, 'site')
    if not (isinstance(enabled, dict) and isinstance(state, dict) and enabled.get(switch)
            and state.get('status') == 'installed' and os.path.isdir(os.path.join(site, 'onnxruntime'))):
        return None
    nvidia = os.path.join(site, 'nvidia')
    libs = sorted(
        os.path.join(nvidia, pkg, 'lib') for pkg in (os.listdir(nvidia) if os.path.isdir(nvidia) else [])
        if os.path.isdir(os.path.join(nvidia, pkg, 'lib'))
    )
    return site, libs


def started_with_runtime() -> bool:
    """True when the wrapper put the GPU runtime on this process's path at start."""
    return os.getenv('KIMA_GPU_RUNTIME') == '1'


def restart_needed(switch: str) -> bool:
    """The switch, or the runtime's install, changed since this process started, and it has run long enough
    for an exit to count as a finished run."""
    if time.monotonic() - _started < SETTLE_SECONDS:
        return False
    return (runtime_for(switch) is not None) != started_with_runtime()


if __name__ == '__main__':
    found = runtime_for(sys.argv[1] if len(sys.argv) > 1 else 'soundVectors')
    if found:
        print('%s\t%s' % (found[0], ':'.join(found[1])))
