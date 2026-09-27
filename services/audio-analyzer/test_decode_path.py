"""Tests for the single ffmpeg decode path.

The analyzer must decode every track with ONE ffmpeg command that reads
exactly the analysed window (first 90 s), tolerates a bad frame, downmixes
any channel count to stereo, and handles any codec ffmpeg can read. The old
design probed with a whole-file ``-xerror`` gate (``_is_decodable``) and
then re-decoded with Essentia's ``MonoLoader``; that gate failed closed on
the 6-channel eac3 m4a and the Opus file while both decode fine under the
single-path design, and ``validate_audio``'s silence/NaN/short gates
measured nothing the analysis needs.

These tests drive the REAL ``analyzer._decode_to_stereo`` — they generate
synthetic fixtures with ffmpeg (6-channel eac3, 6-channel aac m4a, opus, a
corrupted mp3, a 120-second file) and assert on the samples, channel count,
window length and command that the function actually produces.

Run from the service dir:
    cd services/audio-analyzer && python3.12 -m pytest -q test_decode_path.py
"""

import shutil
import subprocess
import sys
import types

import numpy as np
import pytest


def _install_psycopg2_stub() -> None:
    """Provide a dummy psycopg2/psycopg2.extras so the real analyzer imports
    without a database driver installed."""
    extras = types.ModuleType("psycopg2.extras")
    extras.RealDictCursor = dict
    extras.DictCursor = dict
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.extras = extras
    psycopg2.connect = lambda *a, **k: None
    sys.modules["psycopg2"] = psycopg2
    sys.modules["psycopg2.extras"] = extras


_install_psycopg2_stub()

import analyzer  # noqa: E402

FFMPEG = shutil.which("ffmpeg")

pytestmark = pytest.mark.skipif(
    FFMPEG is None, reason="ffmpeg not installed on this machine"
)

# The contract under test: one call returns the decoded window plus the
# evidence to record with it:
#   (samples, sample_rate, channels, duration, command, rc, stderr, class)


def _decode(path, duration=90):
    """Call the single decode path; fail loudly if it does not exist yet."""
    fn = getattr(analyzer, "_decode_to_stereo", None)
    if fn is None:
        pytest.fail(
            "analyzer._decode_to_stereo does not exist: the two-decoder "
            "design (_is_decodable gate + MonoLoader) is still in place"
        )
    return fn(path, duration=duration)


def _ffmpeg_generate(args, out_path):
    """Run ffmpeg to synthesize a fixture; returns the path."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"] + args,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, f"fixture generation failed: {proc.stderr}"
    return out_path


@pytest.fixture(scope="module")
def eac3_6ch(tmp_path_factory):
    """6-channel E-AC3 — the class of file MonoLoader refused with
    'more than 2 channels' and the header gate condemned."""
    path = tmp_path_factory.mktemp("fixtures") / "surround.mkv"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*480*t)"
            "|0.3*sin(2*PI*520*t)|0.3*sin(2*PI*560*t)"
            "|0.3*sin(2*PI*600*t)|0.3*sin(2*PI*640*t)"
            ":duration=4:channel_layout=5.1",
            "-c:a", "eac3",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def aac_6ch_m4a(tmp_path_factory):
    """6-channel AAC in an m4a container — the real prod shape is a
    6-channel eac3 m4a; ffmpeg cannot mux eac3 into m4a, so this is the
    closest synthesizable stand-in for the container + channel count."""
    path = tmp_path_factory.mktemp("fixtures") / "six.m4a"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i",
            "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*480*t)"
            "|0.3*sin(2*PI*520*t)|0.3*sin(2*PI*560*t)"
            "|0.3*sin(2*PI*600*t)|0.3*sin(2*PI*640*t)"
            ":duration=4:channel_layout=5.1",
            "-c:a", "aac", "-b:a", "192k",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def opus_file(tmp_path_factory):
    """Opus — the other file the header gate passed but MonoLoader's
    decoder path mishandled; must analyse through the single path."""
    path = tmp_path_factory.mktemp("fixtures") / "opus.ogg"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=3",
            "-c:a", "libopus",
            str(path),
        ],
        str(path),
    )


@pytest.fixture(scope="module")
def long_file(tmp_path_factory):
    """120-second file — only the first 90 s may be read."""
    path = tmp_path_factory.mktemp("fixtures") / "long.flac"
    return _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=120",
            str(path),
        ],
        str(path),
    )


@pytest.fixture
def corrupt_file(tmp_path_factory):
    """A valid mp3 with its middle overwritten by random bytes — the
    single decode path must still return samples (tolerant of a bad
    frame), not reject the track."""
    import os
    path = tmp_path_factory.mktemp("fixtures") / "corrupt.mp3"
    _ffmpeg_generate(
        [
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=8",
            "-c:a", "libmp3lame",
            str(path),
        ],
        str(path),
    )
    with open(path, "r+b") as fh:
        fh.seek(4096)
        fh.write(bytes(range(256)) * 16)  # guaranteed-garbage middle
    assert os.path.getsize(str(path)) > 4096
    return str(path)


class TestSingleDecodePath:
    def test_decodes_6ch_eac3(self, eac3_6ch):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            eac3_6ch
        )
        assert channels == 2, f"expected stereo downmix, got {channels}ch"
        assert samples.shape[0] == 2
        assert duration > 3.0, f"expected ~4s decoded, got {duration}"
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert np.isfinite(samples).all()
        # A real decode must produce real signal, not silence-filled junk.
        assert np.abs(samples).max() > 0.01

    def test_decodes_opus(self, opus_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            opus_file
        )
        assert channels <= 2
        assert duration > 2.0, f"expected ~3s decoded, got {duration}"
        assert rc == 0, f"decode returned {rc}: {stderr}"
        assert np.isfinite(samples).all()

    def test_tolerates_bad_frame(self, corrupt_file):
        # The whole point of the redesign: a corrupt frame must not stop
        # the analysis. The decode still yields samples covering the file.
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            corrupt_file
        )
        assert duration > 5.0, (
            f"corrupt file yielded only {duration}s — expected tolerance"
        )
        assert np.isfinite(samples).all()
        # Whatever the classifier says, the decode itself must not have
        # aborted: samples exist and the window was read.
        assert cls in ("DAMAGED", "UNSUPPORTED", "MULTICANNEL",
                       "INCONCLUSIVE")

    def test_downmixes_more_than_two_channels(self, eac3_6ch, aac_6ch_m4a):
        for path in (eac3_6ch, aac_6ch_m4a):
            samples, sr, channels, duration, command, rc, stderr, cls = (
                _decode(path)
            )
            assert channels == 2, (
                f"{path}: 6-channel input must downmix to stereo, "
                f"got {channels}"
            )
            assert samples.shape[0] == 2
            assert duration > 3.0

    def test_reads_first_90_second_window(self, long_file):
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            long_file
        )
        assert rc == 0, f"decode returned {rc}: {stderr}"
        # The analysed window is exactly the first 90 s — a 120 s file
        # must yield ~90 s, never the whole thing (that was the waste).
        assert 89.0 <= duration <= 90.5, (
            f"expected the first 90s window, got {duration}s"
        )
        assert samples.shape[1] <= int(90.5 * sr)

    def test_no_is_decodable_gate_remains(self):
        # The gate and its helper must be gone, not merely bypassed.
        assert not hasattr(analyzer, "_is_decodable"), (
            "_is_decodable still exists as a module-level helper"
        )
        assert not hasattr(analyzer.AudioAnalyzer, "_is_decodable"), (
            "AudioAnalyzer._is_decodable still exists"
        )

    def test_no_validate_audio_gate_remains(self):
        assert not hasattr(analyzer.AudioAnalyzer, "validate_audio"), (
            "validate_audio still exists — its short/NaN/silence gates "
            "measure nothing the analysis needs"
        )
        import inspect
        src = inspect.getsource(analyzer.AudioAnalyzer.load_audio)
        assert "_is_decodable" not in src, (
            "load_audio still consults the pre-decode gate"
        )
        assert "validate_audio" not in src, (
            "load_audio still calls validate_audio"
        )

    def test_single_command_per_decode(self, opus_file):
        # One command, recorded verbatim — the caller must be able to
        # reproduce the decode from the recorded argv.
        samples, sr, channels, duration, command, rc, stderr, cls = _decode(
            opus_file
        )
        assert isinstance(command, (list, tuple))
        assert str(command[0]).endswith("ffmpeg")
        assert "-err_detect" in command, (
            "decode must tolerate bad frames via -err_detect ignore_err"
        )
        assert "-xerror" not in command, (
            "-xerror would abort on the first bad frame — the opposite "
            "of tolerant"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))