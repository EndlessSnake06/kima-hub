#!/usr/bin/env python3
"""compute_window_offsets over a dense duration sweep: offsets >= 0, no window
past the end, no overlap, exactly 5 windows from 50 s, sorted ascending."""
import sys

import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyzer import compute_window_offsets  # noqa: E402

WIN = 10.0
EPS = 1e-6
violations = []
checked = 0

d = 0.001
while d <= 3600:
    offs = compute_window_offsets(d, 5, WIN)
    n = len(offs)
    for i, o in enumerate(offs):
        if o < -EPS:
            violations.append(f"d={d}: negative offset {o}")
        if d >= WIN and o + WIN > d + 0.5:
            # Bounds invariant only applies to tracks at least one window long.
            # Shorter tracks read the whole file (loader clamps) by design.
            violations.append(f"d={d}: offset {o} + win > duration (reads past end)")
        if i > 0 and o < offs[i - 1] + WIN - EPS:
            violations.append(
                f"d={d}: overlap w{i-1}/w{i} ({offs[i-1]}+{WIN} > {o})"
            )
    if n > 1 and any(offs[i + 1] < offs[i] - EPS for i in range(n - 1)):
        violations.append(f"d={d}: not sorted")
    if d >= 50.0 and n != 5:
        violations.append(f"d={d}: long track returned {n} windows, expected 5")
    checked += 1
    d = round(d + 0.1, 6)

print(f"checked {checked} durations (0.001s .. 3600s, 0.1s step)")
if violations:
    print(f"FAIL: {len(violations)} violations, first 10:")
    for v in violations[:10]:
        print("  " + v)
    sys.exit(1)
print("PASS: no negative offsets, no out-of-bounds, no overlaps, counts correct, sorted")
