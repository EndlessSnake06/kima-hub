"""
The ONNX CLAP backend's 512-d embeddings match the HF torch reference
(laion/clap-htsat-unfused) on the shipped fixtures: cosine >= 0.99 each.
"""
import hashlib
import os
import numpy as np
import unittest

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES = [
    os.path.join(SERVICE_DIR, 'test_fixtures', 'sine440.wav'),
    os.path.join(SERVICE_DIR, 'test_fixtures', 'white.wav'),
    os.path.join(SERVICE_DIR, 'test_fixtures', 'sine880.wav'),
]
# HF torch reference model + processor (cached locally). The processor files
# (preprocessor_config.json, merges.txt) live in ref_model alongside the weights,
# so fall back to it when a separate processor dir was not unpacked.
REF_MODEL_DIR = os.path.join(SERVICE_DIR, 'cache', 'ref_model')
_ref_proc_dir = os.path.join(SERVICE_DIR, 'cache', 'ref_proc')
REF_PROC_DIR = _ref_proc_dir if os.path.isdir(_ref_proc_dir) else REF_MODEL_DIR

# The shipped model file, pinned by sha256 in setUp so a swapped export fails
# loudly.
SHIPPED_ONNX_MODEL = os.path.join(SERVICE_DIR, 'models', 'hf_audio.onnx')
SCRATCH_ONNX_MODEL = os.path.join(SERVICE_DIR, 'cache', 'hf_audio.onnx')
ONNX_MODEL_PATH = (SHIPPED_ONNX_MODEL if os.path.exists(SHIPPED_ONNX_MODEL)
                   else SCRATCH_ONNX_MODEL)
ONNX_MODEL_SHA256 = (
    '37df17afb9881569c4f50e5b691167aa54586418059701a74a54934514969972')

# >= 0.99 is safe, 0.97-0.99 caution, below 0.97 a failure.
VERDICT_THRESHOLD = 0.99


def cosine(a, b):
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb + 1e-12))


class TestOnxParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Hard failures, not skips: a parity check that skips when its inputs are missing proves nothing.
        try:
            import onnxruntime  # noqa: F401
        except ImportError as exc:
            raise AssertionError(
                'onnxruntime is required for the parity check, not optional'
            ) from exc

        missing = [p for p in FIXTURES if not os.path.exists(p)]
        if missing:
            raise AssertionError(f'parity fixtures missing: {missing}')

        if not os.path.exists(ONNX_MODEL_PATH):
            raise AssertionError(
                f'ONNX model under test not found at {ONNX_MODEL_PATH}')

        with open(ONNX_MODEL_PATH, 'rb') as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        if digest != ONNX_MODEL_SHA256:
            raise AssertionError(
                'the model under test is not the validated export: sha256 '
                f'{digest} != {ONNX_MODEL_SHA256} ({ONNX_MODEL_PATH}). '
                'Parity numbers measured on a different export are not evidence '
                'about what ships.')

        from onnx_backend import OnnxCLAPBackend
        cls.backend = OnnxCLAPBackend(model_path=ONNX_MODEL_PATH)

    def _load(self, path):
        # One 10 s window, as the analyzer feeds it. Longer audio would make the
        # reference processor take a random crop on every run.
        import librosa
        return librosa.load(path, sr=48000, mono=True, res_type='soxr_vhq',
                            duration=10.0)[0]

    def _torch_reference(self, audio):
        """HF torch reference: ClapProcessor + ClapAudioModelWithProjection."""
        import torch
        import torch.nn.functional as F
        from transformers import ClapProcessor, ClapAudioModelWithProjection
        model = ClapAudioModelWithProjection.from_pretrained(
            REF_MODEL_DIR).eval()
        proc = ClapProcessor.from_pretrained(REF_PROC_DIR)
        inp = proc(audio=torch.from_numpy(audio).float(),
                   sampling_rate=48000, return_tensors='pt')
        with torch.no_grad():
            emb = model(**inp)[0].float()
        return F.normalize(emb, dim=-1)[0].detach().cpu().numpy()

    def test_dimensions_are_512(self):
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            emb = self.backend.embed_audio(self._load(path))
            self.assertEqual(emb.shape, (512,), f'{os.path.basename(path)} shape')

    def test_normalization_unit_norm(self):
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            emb = self.backend.embed_audio(self._load(path))
            self.assertAlmostEqual(float(np.linalg.norm(emb)), 1.0, places=5)

    def test_audio_parity_threshold(self):
        """ONNX embeddings match the torch reference."""
        sims = {}
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            audio = self._load(path)
            emb_onnx = self.backend.embed_audio(audio)
            emb_ref = self._torch_reference(audio)
            sims[os.path.basename(path)] = cosine(emb_ref, emb_onnx)
            self.assertEqual(emb_ref.shape, (512,), f'{path} ref shape')
            self.assertGreaterEqual(sims[os.path.basename(path)],
                                    VERDICT_THRESHOLD,
                                    f'ONNX vs HF parity below SAFE for {path}')
        print('cosine(HF-torch, onnx-backend) per fixture:', sims)
        self.assertGreaterEqual(min(sims.values()), VERDICT_THRESHOLD,
                                'ONNX vs HF parity below SAFE threshold')


if __name__ == '__main__':
    unittest.main(verbosity=2)
