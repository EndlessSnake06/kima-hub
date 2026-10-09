#!/bin/bash
# GPU runtime env wrapper. Puts the installed CUDA runtime on PYTHONPATH and
# LD_LIBRARY_PATH when this process's own switch is on (gpu_switch.py decides),
# then execs the real command; KIMA_GPU_RUNTIME=1 tells the process it has it.
# KIMA_GPU_FOR names the switch: soundVectors (the CLAP analyzer, the default)
# or analysis (the Essentia analyzer). Must run before Python starts: glibc
# fixes LD_LIBRARY_PATH at process start.
FOUND=$(python3 "$(dirname "$0")/gpu_switch.py" "${KIMA_GPU_FOR:-soundVectors}" 2>/dev/null)
if [ -n "$FOUND" ]; then
    SITE_DIR="${FOUND%%$'\t'*}"
    LIB_DIRS="${FOUND#*$'\t'}"
    export PYTHONPATH="$SITE_DIR${PYTHONPATH:+:$PYTHONPATH}"
    # An empty entry would put the working directory on the library path.
    if [ -n "$LIB_DIRS" ]; then
        export LD_LIBRARY_PATH="$LIB_DIRS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
    export KIMA_GPU_RUNTIME=1
    echo "gpu-onnx: runtime active from $SITE_DIR for ${KIMA_GPU_FOR:-soundVectors}"
fi

exec "$@"
