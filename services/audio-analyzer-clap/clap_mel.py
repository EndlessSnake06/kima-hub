"""
ClapFeatureExtractor._get_input_mel without PyTorch, built on the same
transformers.audio_utils primitives and laion/clap-htsat-unfused's config.
Only inputs up to max_length are supported; longer ones raise rather than
diverge from HF's random crop.
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
        if self.truncation != "rand_trunc":
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
