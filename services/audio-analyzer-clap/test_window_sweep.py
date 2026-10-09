"""compute_window_offsets over a dense duration sweep: offsets >= 0, no window past the end of a
track at least one window long, no overlap, exactly 5 windows from 50 s, sorted ascending."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import compute_window_offsets  # noqa: E402

WIN = 10.0
EPS = 1e-6


def _violations(duration: float) -> list:
    offsets = compute_window_offsets(duration, 5, WIN)
    found = []
    for i, start in enumerate(offsets):
        if start < -EPS:
            found.append(f"negative offset {start}")
        # A track shorter than one window is read whole (the loader clamps).
        if duration >= WIN and start + WIN > duration + 0.5:
            found.append(f"window at {start} reads past the end")
        if i > 0 and start < offsets[i - 1] + WIN - EPS:
            found.append(f"windows {i - 1} and {i} overlap")
    if any(b < a - EPS for a, b in zip(offsets, offsets[1:])):
        found.append("not sorted")
    if duration >= 50.0 and len(offsets) != 5:
        found.append(f"{len(offsets)} windows, expected 5")
    return found


def test_every_length_up_to_an_hour_gets_valid_windows():
    failures = {}
    duration = 0.001
    while duration <= 3600:
        found = _violations(duration)
        if found:
            failures[duration] = found
        duration = round(duration + 0.1, 6)
    assert not failures, f"{len(failures)} lengths fail, first: {next(iter(failures.items()))}"
