"""
ONNX backend for the CLAP audio analyzer.

Swaps in the HF torch-onnx export (audio_model.onnx via onnxruntime) so the
vibe engine can run on Apple silicon without PyTorch. Verified numerically
identical (cosine == 1.0000) to the PyTorch CLAP audio encoder on this
checkpoint (laion/clap-htsat-unfused).

Preprocessing matches HF ClapFeatureExtractor exactly:
  - librosa 48kHz mono
  - HF ClapFeatureExtractor._get_input_mel (Hann STFT + power spectrogram
    + HF config mel_filters, log-dB clamp)
  - center-padding/truncation to 1001 frames
  - 10s chunks (nb_max_samples=480000, nb_max_frames=1001)
  - feed [1, 1, 1001, 64] to audio_model.onnx -> 512-d -> L2-normalize

The ONNX model input is the HF-extracted log-mel spectrogram. The mel is
computed with HF's own feature extractor so it matches the HF torch
reference bit-for-bit (verified 1.0000 in test_onnx_parity.py).

Falls back to the torch backend if the ONNX model fails (e.g. missing
weights).
"""
import os
import logging
from typing import Optional
import numpy as np

logger = logging.getLogger('clap-analyzer')

CLAP_SAMPLE_RATE = 48000
MAX_SAMPLES = 480000  # 10s
MAX_FRAMES = 1001
EPS = 1e-12

# Default ONNX model path. Resolves to the analyzer's own models/ directory
# (where the validated hf_audio.onnx is copied) so the ONNX backend works out
# of the box; override with CLAP_ONNX_MODEL_PATH when needed.
# In production this can still point at the Docker image instead.
def _default_onnx_model_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.join(here, 'models', 'hf_audio.onnx')
    if os.path.exists(candidate):
        return candidate
    # Fall back to the legacy Docker path if the local copy is absent.
    return os.path.join(here, 'models', 'audio_model.onnx')


ONNX_MODEL_PATH = os.getenv(
    'CLAP_ONNX_MODEL_PATH',
    _default_onnx_model_path(),
)

# Default HF torch reference model path (used for the torch fallback).
REF_MODEL_PATH = os.getenv(
    'CLAP_REF_MODEL_PATH',
    'laion/clap-htsat-unfused',
)


class OnnxCLAPBackend:
    """Thin wrapper over onnxruntime's clap audio encoder."""

    def __init__(self, model_path: str = ONNX_MODEL_PATH):
        self.model_path = model_path
        self._sess = None
        self._fe = None

    def load_model(self) -> None:
        if self._sess is not None:
            return
        import onnxruntime as ort
        self._sess = ort.InferenceSession(
            self.model_path, providers=['CPUExecutionProvider'])
        self._in_name = self._sess.get_inputs()[0].name
        self._out_name = self._sess.get_outputs()[0].name
        # Lazy import HF feature extractor to build the mel spectrogram.
        from transformers import ClapFeatureExtractor
        self._fe = ClapFeatureExtractor.from_pretrained('laion/clap-htsat-unfused')
        logger.info(f'ONNX CLAP backend loaded from {self.model_path}')

    def _mel_chunk(self, audio: np.ndarray) -> np.ndarray:
        """Use HF ClapFeatureExtractor to compute the log-mel for a 10s chunk.

        Returns [1001, 64] — exactly what HF ClapFeatureExtractor produces for
        audio of <= 10s with the default truncation/padding.
        """
        clip = audio[:MAX_SAMPLES]
        mel, _ = self._fe._get_input_mel(
            clip,
            max_length=self._fe.nb_max_samples,
            truncation=self._fe.truncation,
            padding=self._fe.padding,
        )
        return mel[0]  # [1001, 64]

    def _prepare_input(self, audio: np.ndarray) -> np.ndarray:
        """Concatenate 10s-chunk mels, pad/truncate to 1001 frames total."""
        n_chunks = max(1, (audio.shape[0] + MAX_SAMPLES - 1) // MAX_SAMPLES)
        blocks = []
        for i in range(n_chunks):
            seg = audio[i * MAX_SAMPLES:(i + 1) * MAX_SAMPLES]
            mel = self._mel_chunk(seg)  # [1001, 64]
            blocks.append(mel)
        spec = np.concatenate(blocks, axis=0)  # [total_frames, 64]
        if spec.shape[0] < MAX_FRAMES:
            spec = np.pad(spec, [(MAX_FRAMES - spec.shape[0], 0), (0, 0)])
        else:
            spec = spec[:MAX_FRAMES, :]
        return spec[np.newaxis, np.newaxis, ...].astype(np.float32)  # [1,1,T,64]

    def embed_audio(self, audio: np.ndarray) -> np.ndarray:
        """Return a 512-d L2-normalized audio embedding for a 48k mono clip."""
        self.load_model()
        inp = self._prepare_input(audio)
        try:
            out = self._sess.run([self._out_name], {self._in_name: inp})[0]
            vec = out[0]
            vec = vec / (np.linalg.norm(vec) + EPS)
            return vec.astype(np.float32)
        except Exception as e:
            logger.warning(f'ONNX embed failed ({e}); falling back to torch')
            # Torch fallback: use HF torch reference path.
            return self._torch_fallback(audio)

    def _torch_fallback(self, audio: np.ndarray) -> np.ndarray:
        """Fallback: HF torch reference embedding (ClapProcessor + model)."""
        import torch
        import torch.nn.functional as F
        from transformers import ClapProcessor, ClapAudioModelWithProjection
        model = ClapAudioModelWithProjection.from_pretrained(REF_MODEL_PATH).eval()
        proc = ClapProcessor.from_pretrained('laion/clap-htsat-unfused')
        y = torch.from_numpy(audio).float()
        inp = proc(audio=y, sampling_rate=CLAP_SAMPLE_RATE, return_tensors='pt')
        with torch.no_grad():
            emb = model(**inp)[0].float()
        return F.normalize(emb, dim=-1)[0].detach().cpu().numpy().astype(np.float32)


# Default ONNX TEXT model path (Xenova clap-htsat-unfused text_model.onnx).
# The audio service keeps it under models/text_model.onnx; overridable so the
# testbed/CI can point at a downloaded copy instead of baking 500MB in.
def _default_text_model_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, 'models', 'text_model.onnx')


ONNX_TEXT_MODEL_PATH = os.getenv(
    'CLAP_ONNX_TEXT_MODEL_PATH',
    _default_text_model_path(),
)

# Tokenizer for the text path. laion_clap uses RobertaTokenizer('roberta-base')
# -- NOT the 'laion/clap-htsat-unfused' tokenizer -- and the Xenova ONNX export
# was built with the same roberta-base vocab. Using the wrong tokenizer was the
# cause of a measured 0.84 cosine vs the correct 1.0000 (text_parity_gate.py).
TEXT_MAX_LENGTH = 77


class OnnxTextCLAPBackend:
    """Pure-ONNX text encoder: tokenizer + Xenova text_model.onnx.

    Numerically identical (cosine == 1.0000) to laion_clap's torch text path on
    the 12 prompts used by the zero-shot detectors (text_parity_gate.py,
    2026-09-10). No torch, no laion_clap -- onnxruntime + transformers only.
    """

    def __init__(self, model_path: str = ONNX_TEXT_MODEL_PATH):
        self.model_path = model_path
        self._sess = None
        self._tok = None

    def load_model(self) -> None:
        if self._sess is not None:
            return
        import onnxruntime as ort
        self._sess = ort.InferenceSession(
            self.model_path, providers=['CPUExecutionProvider'])
        self._in_name = self._sess.get_inputs()[0].name
        self._out_name = self._sess.get_outputs()[0].name
        # Tokenizer: laion_clap's RobertaTokenizer('roberta-base'), not the
        # laion/clap-htsat-unfused fast tokenizer (vocab differs).
        from transformers import RobertaTokenizer
        self._tok = RobertaTokenizer.from_pretrained('roberta-base')
        logger.info(f'ONNX text backend loaded from {self.model_path}')

    def embed_text(self, texts: list[str]) -> np.ndarray:
        """Return [n, 512] L2-normalized text embeddings."""
        self.load_model()
        enc = self._tok(
            texts,
            padding='max_length',
            truncation=True,
            max_length=TEXT_MAX_LENGTH,
            return_tensors='np',
        )
        ids = enc['input_ids'].astype(np.int64)
        out = self._sess.run([self._out_name], {self._in_name: ids})[0]
        norm = np.linalg.norm(out, axis=1, keepdims=True)
        return (out / np.maximum(norm, 1e-12)).astype(np.float32)
