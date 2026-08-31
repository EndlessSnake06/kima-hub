#!/usr/bin/env python3
"""
Unit tests for the five-window placement strategy.

These tests cover the pure `compute_window_offsets` function only -- no model,
no audio file, no network. Run with:

    python3 test_window_offsets.py

The assertions are plain `assert`s so the exit code doubles as the test result
(a plain `python3 test_window_offsets.py` run needs no pytest installed).
"""
from analyzer import compute_window_offsets

WINDOW_COUNT = 5
WINDOW_SECONDS = 10.0


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


# ---------------------------------------------------------------------------
# Long tracks (>= 50s): the nominal 10/30/50/70/90% placement.
# ---------------------------------------------------------------------------

def test_offsets_match_10_30_50_70_90_percent():
    offsets = compute_window_offsets(duration=100.0)
    assert len(offsets) == WINDOW_COUNT, f"expected {WINDOW_COUNT} offsets, got {len(offsets)}"
    expected = [10.0, 30.0, 50.0, 70.0, 90.0]
    for got, exp in zip(offsets, expected):
        assert approx(got, exp), f"offset {got} != expected {exp}"


def test_last_window_ends_at_track_end_long_track():
    # A 100s track: the 5th window (start 90s, 10s long) must end at 100s.
    offsets = compute_window_offsets(duration=100.0)
    assert approx(offsets[-1] + WINDOW_SECONDS, 100.0), \
        f"last window ends at {offsets[-1] + WINDOW_SECONDS}, expected 100.0"


def test_windows_non_overlapping_long_track():
    # A 120s track: five 10s windows must not overlap each other.
    offsets = compute_window_offsets(duration=120.0)
    for start, end in zip(offsets, offsets[1:]):
        assert end >= start + WINDOW_SECONDS - 1e-9, \
            f"windows overlap on 120s track: {offsets}"


def test_window_start_never_past_track_end():
    # For any long track, no window may start after the end of the file.
    for duration in (50.0, 100.0, 150.0, 200.0, 500.0):
        offsets = compute_window_offsets(duration=duration)
        for o in offsets:
            assert o <= duration + 1e-9, f"window start {o} > duration {duration}"


def test_exactly_fifty_seconds():
    # A 50s track is the boundary: five 10s windows at 10/30/50/70/90%. The
    # last (start 45) would read to 55s, so it clamps to 40 to stay in bounds.
    offsets = compute_window_offsets(duration=50.0)
    assert offsets == [5.0, 15.0, 25.0, 35.0, 40.0], f"got {offsets}"
    # No window reads past the file end.
    for o in offsets:
        assert o + WINDOW_SECONDS <= 50.0 + 1e-9, f"window {o} reads past end"


# ---------------------------------------------------------------------------
# Short tracks (< 50s): non-overlapping windows that fit, no out-of-bounds.
# ---------------------------------------------------------------------------

def test_short_track_windows_within_bounds():
    # A 40s track: every window must start at <= 30s so the 10s clip stays in.
    offsets = compute_window_offsets(duration=40.0)
    for o in offsets:
        assert o <= 40.0 - WINDOW_SECONDS + 1e-9, \
            f"window start {o} would read past end for 40s track"


def test_short_track_last_window_ends_at_track_end():
    # A 40s track: the last window must end exactly at 40s.
    offsets = compute_window_offsets(duration=40.0)
    assert approx(offsets[-1] + WINDOW_SECONDS, 40.0), \
        f"last window ends at {offsets[-1] + WINDOW_SECONDS}, expected 40.0"


def test_short_track_no_overlap():
    # A 40s track: windows must not overlap each other.
    offsets = compute_window_offsets(duration=40.0)
    for start, end in zip(offsets, offsets[1:]):
        assert end >= start + WINDOW_SECONDS - 1e-9, \
            f"windows overlap on 40s track: {offsets}"


def test_short_track_place_what_fits():
    # A 40s track holds exactly 4 non-overlapping 10s windows.
    offsets = compute_window_offsets(duration=40.0)
    assert len(offsets) == 4, f"expected 4 windows for 40s track, got {offsets}"


def test_short_track_place_3_windows():
    # A 30s track holds exactly 3 non-overlapping 10s windows.
    offsets = compute_window_offsets(duration=30.0)
    assert len(offsets) == 3, f"expected 3 windows for 30s track, got {offsets}"
    assert approx(offsets[-1] + WINDOW_SECONDS, 30.0), \
        f"last window ends at {offsets[-1] + WINDOW_SECONDS}, expected 30.0"


def test_short_track_place_1_window():
    # A 15s track holds only one non-overlapping 10s window.
    offsets = compute_window_offsets(duration=15.0)
    assert len(offsets) == 1, f"expected 1 window for 15s track, got {offsets}"
    assert approx(offsets[0], 0.0), f"single window should start at 0, got {offsets}"


def test_short_track_place_1_window_just_under():
    # A 19s track: still only one full 10s window fits.
    offsets = compute_window_offsets(duration=19.0)
    assert len(offsets) == 1, f"expected 1 window for 19s track, got {offsets}"


# ---------------------------------------------------------------------------
# Edge cases.
# ---------------------------------------------------------------------------

def test_zero_duration_returns_full_count():
    offsets = compute_window_offsets(duration=0.0)
    assert len(offsets) == WINDOW_COUNT, f"expected {WINDOW_COUNT} offsets, got {len(offsets)}"
    for o in offsets:
        assert o == 0.0, f"zero-duration track should place all windows at 0, got {offsets}"


def test_custom_count_and_window_size():
    # 4 windows of 20s over a 100s track (>= 80s, so the normal branch).
    offsets = compute_window_offsets(duration=100.0, count=4, window_seconds=20.0)
    assert len(offsets) == 4
    assert approx(offsets[-1] + 20.0, 100.0), f"last window ends at {offsets[-1] + 20.0}, expected 100.0"


def test_custom_count_short_track_fits_fewer():
    # 4 windows of 20s over a 30s track: only one full 20s window fits.
    offsets = compute_window_offsets(duration=30.0, count=4, window_seconds=20.0)
    assert len(offsets) == 1, f"expected 1 window for 30s/20s windows, got {offsets}"


def test_single_window():
    offsets = compute_window_offsets(duration=100.0, count=1, window_seconds=10.0)
    assert offsets == [0.0], f"single window should be [0.0], got {offsets}"


def test_return_type_and_length():
    offsets = compute_window_offsets(duration=120.0)
    assert isinstance(offsets, list)
    assert len(offsets) == WINDOW_COUNT
    for o in offsets:
        assert isinstance(o, float)


def test_all_offsets_nonnegative():
    for duration in (5.0, 25.0, 50.0, 100.0):
        for o in compute_window_offsets(duration=duration):
            assert o >= 0.0, f"negative offset {o} for duration {duration}"


def test_last_window_never_reads_past_end():
    # Every returned window, plus its length, must stay within the file.
    for duration in (10.0, 30.0, 40.0, 50.0, 100.0):
        for o in compute_window_offsets(duration=duration):
            assert o + WINDOW_SECONDS <= duration + 1e-9, \
                f"window at {o} reads past end for {duration}s track"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for t in tests:
        t()
        passed += 1
        print(f"PASS {t.__name__}")
    print(f"\n{passed}/{len(tests)} tests passed")
    if passed != len(tests):
        raise SystemExit(1)
