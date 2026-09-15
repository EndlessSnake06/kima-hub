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

# The ONNX audio encoder UNDER TEST. This is deliberately the artifact that
# ships (models/hf_audio.onnx), not a scratch copy: parity numbers are only
# meaningful about the file users actually run. The sha256 below is the pinned,
# validated export; the check in setUp turns a swapped or re-exported model into
# a loud failure instead of a silently different measurement.
SHIPPED_ONNX_MODEL = os.path.join(SERVICE_DIR, 'models', 'hf_audio.onnx')
SCRATCH_ONNX_MODEL = os.path.join(SERVICE_DIR, 'cache', 'hf_audio.onnx')
ONNX_MODEL_PATH = (SHIPPED_ONNX_MODEL if os.path.exists(SHIPPED_ONNX_MODEL)
                   else SCRATCH_ONNX_MODEL)
ONNX_MODEL_SHA256 = (
    '37df17afb9881569c4f50e5b691167aa54586418059701a74a54934514969972')

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
        # Hard failures, deliberately not skips. A parity harness that quietly
        # skips when its inputs are missing turns "verified 1.0000 parity" into a
        # claim nobody can reproduce -- and this harness's own fixtures briefly
        # looked missing, which is exactly how an unverifiable number survives.
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

        digest = hashlib.sha256(
            open(ONNX_MODEL_PATH, 'rb').read()).hexdigest()
        if digest != ONNX_MODEL_SHA256:
            raise AssertionError(
                'the model under test is not the validated export: sha256 '
                f'{digest} != {ONNX_MODEL_SHA256} ({ONNX_MODEL_PATH}). '
                'Parity numbers measured on a different export are not evidence '
                'about what ships.')

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
        """ONNX backend embeddings must match the HF torch reference.

        The fallback counter is checked on every fixture because a silent torch
        fallback would make this comparison torch-versus-torch: it would score a
        perfect 1.0 with the ONNX engine completely broken. The number this test
        prints is only worth reading if ONNX did the work.
        """
        sims = {}
        for path in FIXTURES:
            if not os.path.exists(path):
                continue
            audio = self._load(path)
            fallbacks_before = self.backend.torch_fallback_count
            emb_onnx = self.backend.embed_audio(audio)
            self.assertEqual(
                self.backend.torch_fallback_count, fallbacks_before,
                f'{os.path.basename(path)}: ONNX embed fell back to torch, so this '
                'comparison is torch-versus-torch and proves nothing')
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
