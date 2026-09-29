#!/bin/bash
# GPU-onnx env wrapper.
# Exports PYTHONPATH/LD_LIBRARY_PATH for the installed CUDA runtime, if the
# toggle says so, then execs the real command. Must run before Python
# starts: glibc fixes LD_LIBRARY_PATH at process start.
ROOT="${DATA_DIR:-/data}"
ROOT="${ROOT%/}/gpu-onnx"

if [ -f "$ROOT/state.json" ] && [ -f "$ROOT/enabled.json" ]; then
    EVAL=$(python3 - "$ROOT" <<'PY'
import json, os, sys
root = sys.argv[1]
try:
    state = json.load(open(os.path.join(root, 'state.json')))
    enabled = json.load(open(os.path.join(root, 'enabled.json')))
except (OSError, ValueError):
    sys.exit(0)
if enabled.get('enabled') and state.get('status') == 'installed' \
        and os.path.isdir(os.path.join(root, 'site', 'onnxruntime')):
    site = os.path.join(root, 'site')
    libs = sorted(
        os.path.join(site, 'nvidia', p, 'lib')
        for p in os.listdir(os.path.join(site, 'nvidia'))
        if os.path.isdir(os.path.join(site, 'nvidia', p, 'lib'))
    )
    print('%s\t%s' % (site, ':'.join(libs)))
PY
    )
    if [ -n "$EVAL" ]; then
        SITE_DIR="${EVAL%%$'\t'*}"
        LIB_DIRS="${EVAL#*$'\t'}"
        export PYTHONPATH="$SITE_DIR${PYTHONPATH:+:$PYTHONPATH}"
        export LD_LIBRARY_PATH="$LIB_DIRS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        echo "gpu-onnx: runtime active from $SITE_DIR"
    fi
fi

exec "$@"