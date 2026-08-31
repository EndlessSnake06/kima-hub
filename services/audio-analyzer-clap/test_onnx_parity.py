"""
Parity test: proves the ONNX CLAP backend produces 512-d embeddings
numerically consistent with the HF torch ClapAudioModelWithProjection
(laion/clap-htsat-unfused) on the shipped fixtures.

The ONNX backend (onnx_backend.OnnxCLAPBackend) is the HF-torch reference
(cache/ref_model via ClapProcessor) on one side. For every fixture we
embed via BOTH and require cosine >= 0.99 (SAFE).

This is a CROSS-backend check: it compares two independent embedding
pipelines, so it can actually FAIL (unlike the old self-sim test).
"""
import os
import numpy as np
import unittest

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES = [
    os.path.join(SERVICE_DIR, 'test_fixtures', 'sine440.wav'),
    os.path.join(SERVICE_DIR, 'test_fixtures', 'white.wav'),
    os.path.join(SERVICE_DIR, 'test_fixtures', 'sine880.wav'),
]
# HF torch reference model + processor (cached locally).
REF_MODEL_DIR = os.path.join(SERVICE_DIR, 'cache', 'ref_model')
REF_PROC_DIR = os.path.join(SERVICE_DIR, 'cache', 'ref_proc')
# HF onnx export of the audio encoder (cached locally).
ONNX_MODEL_PATH = os.path.join(SERVICE_DIR, 'cache', 'hf_audio.onnx')

# Threshold: >=0.99 SAFE, 0.97-0.99 CAUTION, <0.97 KILL.
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
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            cls.skipReason = 'onnxruntime not installed; skipping parity test'
            raise unittest.SkipTest(cls.skipReason)
        if not all(os.path.exists(p) for p in FIXTURES):
            raise unittest.SkipTest('fixtures missing')
        if not os.path.exists(ONNX_MODEL_PATH):
            raise unittest.SkipTest(f'ONNX model not found at {ONNX_MODEL_PATH}')
        from onnx_backend import OnnxCLAPBackend
        cls.backend = OnnxCLAPBackend(model_path=ONNX_MODEL_PATH)

    def _load(self, path):
        import librosa
        return librosa.load(path, sr=48000, mono=True, res_type='soxr_vhq')[0]

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
        """ONNX backend embeddings must match the HF torch reference."""
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
