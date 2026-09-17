"""
Torch-free CLAP mel front-end (vendored from HF ClapFeatureExtractor).

Why this exists: transformers gates `ClapFeatureExtractor` behind PyTorch
(both 4.57.6 and 5.8.1 raise ImportError without torch installed), but the
actual mel math is pure numpy living in `transformers.audio_utils`
(mel_filter_bank / spectrogram / window_function) — deliberately NOT gated,
per the ImportError message: "only tokenizers, configuration and file/data
utilities can be used" without torch. This module reproduces
`ClapFeatureExtractor._get_input_mel` for exactly the paths the ONNX backend
exercises, so the shipped image needs no torch and no HF cache for the audio
side.

Equivalence contract (proven in test_clap_mel.py):
  clap_mel.get_input_mel(audio) == ClapFeatureExtractor(...)._get_input_mel(
      audio, max_length=480000, truncation="rand_trunc", padding="repeatpad")
bit-for-bit, because it calls the same audio_utils primitives with the same
arguments derived from laion/clap-htsat-unfused's preprocessor_config.json.

Only the <= max_length paths are implemented (the backend slices clips to
10s before calling); longer inputs raise, rather than silently diverging
from HF's random-crop behavior.
"""
import json
import os
from typing import Optional

import numpy as np
from transformers.audio_utils import mel_filter_bank, spectrogram, window_function

# Defaults = laion/clap-htsat-unfused preprocessor_config.json @ 8fa0f1c6
# (sha256 9739f58296aa6f9ac18008fd0150fb2649bc554985fbde86d0a4041c882ac753).
_DEFAULTS = {
    "feature_size": 64,
    "fft_window_size": 1024,
    "frequency_min": 50,
    "frequency_max": 14000,
    "hop_length": 480,
    "max_length_s": 10,
    "sampling_rate": 48000,
    "truncation": "rand_trunc",
    "padding": "repeatpad",
}


class ClapMelExtractor:
    """Numpy-only equivalent of ClapFeatureExtractor's mel path."""

    def __init__(self, config_path: Optional[str] = None, **overrides):
        cfg = dict(_DEFAULTS)
        if config_path and os.path.exists(config_path):
            with open(config_path) as f:
                cfg.update(json.load(f))
        cfg.update(overrides)

        self.feature_size = int(cfg["feature_size"])
        self.fft_window_size = int(cfg["fft_window_size"])
        self.hop_length = int(cfg["hop_length"])
        self.sampling_rate = int(cfg["sampling_rate"])
        self.nb_max_samples = int(cfg["max_length_s"]) * self.sampling_rate
        self.truncation = str(cfg["truncation"])
        self.padding = str(cfg["padding"])

        self.nb_frequency_bins = (self.fft_window_size >> 1) + 1
        # rand_trunc path uses the slaney-filtered bank (see HF
        # _np_extract_fbank_features docstring: non-fusion truncation uses
        # the librosa-default/slaney filters).
        self.mel_filters_slaney = mel_filter_bank(
            num_frequency_bins=self.nb_frequency_bins,
            num_mel_filters=self.feature_size,
            min_frequency=float(cfg["frequency_min"]),
            max_frequency=float(cfg["frequency_max"]),
            sampling_rate=self.sampling_rate,
            norm="slaney",
            mel_scale="slaney",
        )
        self._window = window_function(self.fft_window_size, "hann")

    def _fbank(self, waveform: np.ndarray) -> np.ndarray:
        """Log-mel in dB, [num_frames, feature_size] — HF returns .T of this."""
        return spectrogram(
            waveform,
            self._window,
            frame_length=self.fft_window_size,
            hop_length=self.hop_length,
            power=2.0,
            mel_filters=self.mel_filters_slaney,
            log_mel="dB",
        ).T

    def get_input_mel(self, waveform: np.ndarray) -> np.ndarray:
        """[1, num_frames, feature_size] log-mel for a clip <= max_length."""
        max_length = self.nb_max_samples
        if waveform.shape[0] > max_length:
            raise ValueError(
                f"clap_mel: waveform longer than max_length ({waveform.shape[0]} "
                f"> {max_length}); slice first — HF's rand_trunc would random-crop"
            )
        if self.truncation not in ("rand_trunc",):
            raise NotImplementedError(
                f"clap_mel: truncation={self.truncation!r} not vendored "
                "(only rand_trunc, the shipped checkpoint's mode)"
            )

        if waveform.shape[0] < max_length and self.padding == "repeatpad":
            n_repeat = int(max_length / waveform.shape[0])
            waveform = np.tile(waveform, n_repeat)
            waveform = np.pad(
                waveform, (0, max_length - waveform.shape[0]),
                mode="constant", constant_values=0,
            )
        elif waveform.shape[0] < max_length:
            raise NotImplementedError(
                f"clap_mel: padding={self.padding!r} not vendored"
            )

        return self._fbank(waveform)[None, :]
