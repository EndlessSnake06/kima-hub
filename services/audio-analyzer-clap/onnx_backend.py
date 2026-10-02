"""
ONNX backend for the CLAP analyzer, so it runs without PyTorch. Audio: 48 kHz
mono, 10 s chunks, the HF log-mel (clap_mel.py) as [1, 1, 1001, 64] into
audio_model.onnx, then 512-d and L2-normalised (test_onnx_parity.py).
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


def plan_providers(gpu_wanted: bool, available) -> list:
    """CUDA is requested only when the toggle
    AND the install say so, and only if this onnxruntime can actually offer it.
    Every other path is exactly ['CPUExecutionProvider'] — the promise that
    nobody who leaves the toggle off pays anything (Test 5)."""
    if gpu_wanted and 'CUDAExecutionProvider' in available:
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']
    return ['CPUExecutionProvider']


class OnnxCLAPBackend:
    """Thin wrapper over onnxruntime's clap audio encoder."""

    def __init__(self, model_path: str = ONNX_MODEL_PATH):
        self.model_path = model_path
        self._sess = None
        self._fe = None
        # Non-zero means a torch embedding stood in for ONNX, which a parity
        # check against torch would wrongly score as a pass.
        self.torch_fallback_count = 0

    def load_model(self) -> None:
        if self._sess is not None:
            return
        import onnxruntime as ort
        import gpu_runtime
        providers = plan_providers(gpu_runtime.request_gpu(),
                                   ort.get_available_providers())
        want_cuda = providers[0] == 'CUDAExecutionProvider'
        self._sess = ort.InferenceSession(self.model_path, providers=providers)
        if want_cuda:
            active = self._sess.get_providers()
            if active and active[0] == 'CUDAExecutionProvider':
                gpu_runtime.record_provider(True)
                logger.info(f'ONNX CLAP audio session active on CUDA '
                            f'(providers={active})')
            else:
                gpu_runtime.record_provider(False, f'session providers: {active}')
                logger.warning(
                    f'gpu-onnx: CUDA requested but session did not go active '
                    f'(providers={active}) — embeddings still correct, CPU speed')
        self._in_name = self._sess.get_inputs()[0].name
        self._out_name = self._sess.get_outputs()[0].name
        # transformers gates ClapFeatureExtractor behind PyTorch, so the mel
        # comes from clap_mel, built on the ungated audio_utils primitives.
        import clap_mel
        config_path = os.path.join(os.path.dirname(self.model_path),
                                   'preprocessor_config.json')
        self._fe = clap_mel.ClapMelExtractor(config_path=config_path)
        logger.info(f'ONNX CLAP backend loaded from {self.model_path} '
                    f'(torch-free mel via clap_mel)')

    def _mel_chunk(self, audio: np.ndarray) -> np.ndarray:
        """Use HF ClapFeatureExtractor to compute the log-mel for a 10s chunk.

        Returns [1001, 64] — exactly what HF ClapFeatureExtractor produces for
        audio of <= 10s with the default truncation/padding.
        """
        clip = audio[:MAX_SAMPLES]
        return self._fe.get_input_mel(clip)[0]  # [1001, 64]

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

    def embed_audio(self, audio: np.ndarray,
                    allow_torch_fallback: bool = False) -> np.ndarray:
        """512-d L2-normalised embedding of a 48 kHz mono clip. An ONNX failure
        raises: only a parity harness may pass allow_torch_fallback, and it
        must then check torch_fallback_count.
        """
        self.load_model()
        inp = self._prepare_input(audio)
        try:
            out = self._sess.run([self._out_name], {self._in_name: inp})[0]
            vec = out[0]
            vec = vec / (np.linalg.norm(vec) + EPS)
            return vec.astype(np.float32)
        except Exception as e:
            if not allow_torch_fallback:
                raise RuntimeError(
                    f'ONNX audio embedding failed ({e}) and the torch fallback is '
                    'off. This image runs the ONNX backend; a failed window is a '
                    'failed window and must not be replaced with a substitute '
                    'vector. Pass allow_torch_fallback=True only in a harness that '
                    'is explicitly comparing the two.'
                ) from e
            logger.warning(
                f'ONNX embed failed ({e}); falling back to torch reference '
                'embedding (explicitly requested)'
            )
            self.torch_fallback_count += 1
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

# laion_clap and the Xenova export both use the roberta-base tokenizer, not
# laion/clap-htsat-unfused's. Prompts truncate at laion_clap's 77 tokens.
TEXT_MAX_LENGTH = 77


class OnnxTextCLAPBackend:
    """Text encoder on the Xenova text_model.onnx. The graph has no
    attention_mask, so each prompt is encoded alone at its true length, which
    matches laion_clap's masked result (test_text_parity.py).
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
        """Return [n, 512] L2-normalized text embeddings.

        One prompt per run, unpadded: with no attention_mask input, padding a
        batch to a common length would change every shorter prompt's vector.
        """
        self.load_model()
        rows = []
        for text in texts:
            ids = self._tok(
                [text],
                padding=False,
                truncation=True,
                max_length=TEXT_MAX_LENGTH,
                return_tensors='np',
            )['input_ids'].astype(np.int64)
            rows.append(self._sess.run([self._out_name], {self._in_name: ids})[0][0])
        out = np.stack(rows)
        norm = np.linalg.norm(out, axis=1, keepdims=True)
        return (out / np.maximum(norm, 1e-12)).astype(np.float32)
