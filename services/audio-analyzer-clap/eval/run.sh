#!/usr/bin/env bash
# One command: build a throwaway environment from the analyzer's own
# requirements (so the shipped analyzer module imports exactly as in the image),
# add scipy for the statistics, and run the harness. Arguments pass through.
#   ./run.sh                     v1's shipped model on every set present
#   ./run.sh --models v1 engine  add the new engine's model (head-to-head)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec uv run --no-project --python 3.12 \
  --with-requirements "$here/../requirements.txt" \
  --with scipy --with pydantic-settings \
  python "$here/vibe_eval.py" "$@"
