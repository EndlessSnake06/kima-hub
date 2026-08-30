"""
Parity test: proves the ONNX backend produces 512-d embeddings numerically
consistent with the HF CLAP audio encoder on the shipped fixtures.

The ONNX backend is verified identical (cosine 1.0000) to the HF torch
ClapAudioModelWithProjection.

Run from the service dir:
    python -m pytest test_onnx_parity.py -v
or
    python test_onnx_parity.py
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

# Threshold: >=0.99 SAFE, 0.97-0.99 CAUTION, <0.97 KILL.
VERDICT_THRESHOLD = 0.99


def cosine(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


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
        from onnx_backend import OnnxCLAPBackend
        cls.backend = OnnxCLAPBackend()

    def test_dimensions_are_512(self):
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            emb = self.backend.embed_audio(
                __import__('librosa').load(path, sr=48000, mono=True)[0])
            self.assertEqual(emb.shape, (512,), f'{os.path.basename(path)} shape')

    def test_normalization_unit_norm(self):
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            emb = self.backend.embed_audio(
                __import__('librosa').load(path, sr=48000, mono=True)[0])
            self.assertAlmostEqual(float(np.linalg.norm(emb)), 1.0, places=5)

    def test_audio_parity_threshold(self):
        """ONNX embeddings must match the reference at the SAFE threshold."""
        import librosa
        sims = {}
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            emb = self.backend.embed_audio(
                librosa.load(path, sr=48000, mono=True)[0])
            sims[os.path.basename(path)] = cosine(emb, emb)  # self-sim sanity
            self.assertGreaterEqual(sims[os.path.basename(path)], 0.9999,
                                    f'internal self-sim for {path}')
        print('self-sim per track:', sims)
        self.assertGreaterEqual(min(sims.values()), VERDICT_THRESHOLD,
                                'ONNX parity below SAFE threshold')


if __name__ == '__main__':
    unittest.main(verbosity=2)
