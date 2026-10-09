#!/bin/bash
# GPU runtime env wrapper.
# Exports PYTHONPATH/LD_LIBRARY_PATH for the installed CUDA runtime when this
# process's own switch is on, then execs the real command. KIMA_GPU_FOR names
# the switch: soundVectors (the CLAP analyzer, the default) or analysis (the
# Essentia analyzer, which is also told so by KIMA_GPU_ANALYSIS=1). Must run
# before Python starts: glibc fixes LD_LIBRARY_PATH at process start.
ROOT="${DATA_DIR:-/data}"
ROOT="${ROOT%/}/gpu-onnx"

if [ -f "$ROOT/state.json" ] && [ -f "$ROOT/enabled.json" ]; then
    EVAL=$(python3 - "$ROOT" "${KIMA_GPU_FOR:-soundVectors}" <<'PY'
import json, os, sys
root, switch = sys.argv[1], sys.argv[2]
try:
    state = json.load(open(os.path.join(root, 'state.json')))
    enabled = json.load(open(os.path.join(root, 'enabled.json')))
except (OSError, ValueError):
    sys.exit(0)
if enabled.get(switch) and state.get('status') == 'installed' \
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
        if [ "${KIMA_GPU_FOR:-soundVectors}" = "analysis" ]; then export KIMA_GPU_ANALYSIS=1; fi
        echo "gpu-onnx: runtime active from $SITE_DIR for ${KIMA_GPU_FOR:-soundVectors}"
    fi
fi

exec "$@"