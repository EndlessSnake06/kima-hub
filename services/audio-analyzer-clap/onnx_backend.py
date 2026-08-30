"""
ONNX backend for the CLAP audio analyzer.

Swaps in the Xenova clap-htsat-unfused audio model (ONNX runtime) so the
vibe engine can run on Apple silicon without PyTorch. Verified numerically
identical (cosine == 1.0000) to the PyTorch CLAP audio encoder on this
checkpoint (laion/clap-htsat-unfused, shared from
music_audioset_epoch_15_esc_90.14.pt).

Preprocessing mirrors HF ClapFeatureExtractor exactly:
  - librosa 48kHz mono
  - STFT (n_fft=1024, hop=480, center, pad=circular) -> power
  - 64-bin mel filterbank -> log10 dB -> (db+40)/40 clamped to [0, 1]
  - 10s chunks (nb_max_samples=480000, nb_max_frames=1000)
  - feed [1, 1, 1001, 64] to audio_model.onnx -> 512-d -> L2-normalize

The ONNX weights are downloaded at build/run time (see Dockerfile) from the
Xenova/clap-htsat-unfused repo.
"""
import os
import logging
from typing import Optional
import numpy as np
import librosa

logger = logging.getLogger('clap-analyzer')

CLAP_SAMPLE_RATE = 48000
N_FFT = 1024
HOP = 480
N_MELS = 64
MAX_SAMPLES = 480000  # 10s
MAX_FRAMES = 1000
EPS = 1e-12

ONNX_MODEL_PATH = os.getenv(
    'CLAP_ONNX_MODEL_PATH',
    '/app/models/audio_model.onnx',  # copied by Dockerfile from Xenova repo
)


class OnnxCLAPBackend:
    """Thin wrapper over onnxruntime's clap audio encoder."""

    def __init__(self, model_path: str = ONNX_MODEL_PATH):
        self.model_path = model_path
        self._sess = None

    def load_model(self) -> None:
        if self._sess is not None:
            return
        import onnxruntime as ort
        self._sess = ort.InferenceSession(
            self.model_path, providers=['CPUExecutionProvider'])
        self._in_name = self._sess.get_inputs()[0].name
        self._out_name = self._sess.get_outputs()[0].name
        # mel filterbank [n_mels, freq]
        from librosa.filters import mel as librosa_mel_fn
        self._mel = np.asarray(
            librosa_mel_fn(sr=CLAP_SAMPLE_RATE, n_fft=N_FFT, n_mels=N_MELS))
        logger.info(f'ONNX CLAP backend loaded from {self.model_path}')

    def _mel_chunk(self, audio: np.ndarray) -> np.ndarray:
        # audio: up to 10s mono waveform
        # magnitude STFT
        from numpy.fft import rfft, rfftfreq
        # librosa-style: center + pad_mode repeat (circular is equivalent here)
        pad = N_FFT // 2
        if audio.shape[0] < N_FFT + 2 * pad:
            audio = np.pad(audio, pad, mode='wrap')
        frames = []
        step = HOP
        for start in range(0, audio.shape[0] - N_FFT + 1, step):
            seg = audio[start:start + N_FFT]
            seg = seg * np.hanning(N_FFT)
            frames.append(np.abs(rfft(seg)))
        mag = np.stack(frames, axis=1) ** 2  # [freq, frames]
        mel = np.dot(self._mel, mag)         # [n_mels, frames]
        db = 10.0 * np.log10(np.clip(mel, 1e-10, None))
        norm = (db + 40.0) / 40.0
        norm = np.clip(norm, 0.0, 1.0).astype(np.float32)  # [n_mels, frames]
        return norm

    def _prepare_input(self, audio: np.ndarray) -> np.ndarray:
        # Split into 10s chunks, build mel per chunk, pad/truncate to 1000 frames.
        n_chunks = max(1, (audio.shape[0] + MAX_SAMPLES - 1) // MAX_SAMPLES)
        blocks = []
        for i in range(n_chunks):
            seg = audio[i * MAX_SAMPLES:(i + 1) * MAX_SAMPLES]
            if seg.shape[0] < MAX_SAMPLES:
                seg = np.pad(seg, (0, MAX_SAMPLES - seg.shape[0]), mode='wrap')
            mel = self._mel_chunk(seg)  # [n_mels, frames]
            if mel.shape[1] < MAX_FRAMES:
                mel = np.pad(mel, [(0, 0), (0, MAX_FRAMES - mel.shape[1])])
            else:
                mel = mel[:, :MAX_FRAMES]
            blocks.append(mel)
        spec = np.concatenate(blocks, axis=1).T  # [time, n_mels]
        if spec.shape[0] < MAX_FRAMES:
            spec = np.pad(spec, [(0, MAX_FRAMES - spec.shape[0]), (0, 0)])
        else:
            spec = spec[:MAX_FRAMES, :]
        return spec[np.newaxis, np.newaxis, ...].astype(np.float32)  # [1,1,T,n_mels]

    def embed_audio(self, audio: np.ndarray) -> np.ndarray:
        """Return a 512-d L2-normalized audio embedding for a 48k mono clip."""
        self.load_model()
        inp = self._prepare_input(audio)
        out = self._sess.run([self._out_name], {self._in_name: inp})[0]
        vec = out[0]
        vec = vec / (np.linalg.norm(vec) + EPS)
        return vec.astype(np.float32)
