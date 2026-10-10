"""
ONNX backend for the CLAP analyzer, so it runs without PyTorch. Audio: 48 kHz
mono, 10 s chunks, the HF log-mel (clap_mel.py) as [1, 1, 1001, 64] into
audio_model.onnx, then 512-d and L2-normalised (test_onnx_parity.py).
"""
import os
import logging
import queue
import threading
from typing import Optional
import numpy as np

logger = logging.getLogger('clap-analyzer')

CLAP_SAMPLE_RATE = 48000
MAX_SAMPLES = 480000  # 10s
EPS = 1e-12

# The validated export the images copy next to the analyzer; CLAP_ONNX_MODEL_PATH overrides it.
ONNX_MODEL_PATH = os.getenv(
    'CLAP_ONNX_MODEL_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'hf_audio.onnx'),
)

def plan_providers(gpu_wanted: bool, available) -> list:
    """CUDA is requested only when the switch and the install both say so and this onnxruntime
    offers it. Every other path is exactly ['CPUExecutionProvider'], so nobody who leaves the
    switch off pays anything."""
    if gpu_wanted and 'CUDAExecutionProvider' in available:
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']
    return ['CPUExecutionProvider']


class OneThread:
    """Runs every call on one thread. ONNX Runtime gives each thread that calls a GPU session its
    own GPU workspace: 16 analyzer threads calling the sound model held 2.4 GB of an 8 GB card;
    one thread making the calls holds one. A call that gets no answer in CALL_TIMEOUT_S raises, so a
    hung GPU fails tracks instead of stopping the analyzer."""

    CALL_TIMEOUT_S = 120

    def __init__(self, name: str):
        self._requests: queue.Queue = queue.Queue()
        threading.Thread(target=self._loop, name=name, daemon=True).start()

    def _loop(self) -> None:
        while True:
            fn, args, reply, done = self._requests.get()
            try:
                reply['value'] = fn(*args)
            except BaseException as e:
                reply['error'] = e
            done.set()

    def call(self, fn, *args):
        reply: dict = {}
        done = threading.Event()
        self._requests.put((fn, args, reply, done))
        if not done.wait(self.CALL_TIMEOUT_S):
            raise TimeoutError(f'the GPU thread gave no answer in {self.CALL_TIMEOUT_S} s')
        if 'error' in reply:
            raise reply['error']
        return reply['value']


_gpu_thread: Optional[OneThread] = None
_gpu_thread_lock = threading.Lock()


def gpu_thread() -> OneThread:
    """The process's one GPU-calling thread, made on first use and kept when the model is
    unloaded and loaded again."""
    global _gpu_thread
    with _gpu_thread_lock:
        if _gpu_thread is None:
            _gpu_thread = OneThread('clap-gpu')
        return _gpu_thread


class OnnxCLAPBackend:
    """Thin wrapper over onnxruntime's clap audio encoder."""

    def __init__(self, model_path: str = ONNX_MODEL_PATH):
        self.model_path = model_path
        self._sess = None
        self._run = None
        self._fe = None

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
        on_gpu = self._sess.get_providers()[0] == 'CUDAExecutionProvider'
        self._run = (lambda gpu: lambda feeds: gpu.call(self._sess.run, [self._out_name], feeds))(
            gpu_thread()) if on_gpu else (lambda feeds: self._sess.run([self._out_name], feeds))
        # transformers gates ClapFeatureExtractor behind PyTorch, so the mel
        # comes from clap_mel, built on the ungated audio_utils primitives.
        import clap_mel
        config_path = os.path.join(os.path.dirname(self.model_path),
                                   'preprocessor_config.json')
        self._fe = clap_mel.ClapMelExtractor(config_path=config_path)
        logger.info(f'ONNX CLAP backend loaded from {self.model_path} '
                    f'(torch-free mel via clap_mel)')

    def _mel_chunk(self, audio: np.ndarray) -> np.ndarray:
        """Log-mel of the first 10 s, [1001, 64]: what HF's ClapFeatureExtractor gives for audio of
        10 s or less with its default truncation and padding."""
        clip = audio[:MAX_SAMPLES]
        return self._fe.get_input_mel(clip)[0]  # [1001, 64]

    def _prepare_input(self, audio: np.ndarray) -> np.ndarray:
        """The model's whole input: the log-mel of the first 10 s, [1, 1, 1001, 64]. Audio past 10 s
        (a 44.1 kHz source resampled can run a sample over) would only be cut away again."""
        return self._mel_chunk(audio)[np.newaxis, np.newaxis, ...].astype(np.float32)

    def embed_clips(self, clips: list) -> np.ndarray:
        """``(len(clips), 512)`` L2-normalised embeddings of 48 kHz mono clips in one
        model call: on the GPU one batch costs about what one clip does. The
        spectrograms are built first, on the calling thread; on the GPU the call
        itself is made by the one GPU thread."""
        self.load_model()
        batch = np.concatenate([self._prepare_input(clip) for clip in clips], axis=0)
        out = self._run({self._in_name: batch})[0]
        return (out / (np.linalg.norm(out, axis=1, keepdims=True) + EPS)).astype(np.float32)

    def embed_audio(self, audio: np.ndarray) -> np.ndarray:
        """512-d L2-normalised embedding of a 48 kHz mono clip."""
        return self.embed_clips([audio])[0]


# The text model (Xenova clap-htsat-unfused text_model.onnx) sits in models/;
# CLAP_ONNX_TEXT_MODEL_PATH points at a copy elsewhere.
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
