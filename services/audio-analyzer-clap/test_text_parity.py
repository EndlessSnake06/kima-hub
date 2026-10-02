"""
The ONNX text path equals the HF torch text encoder run with the real
attention mask. Xenova's text_model.onnx takes no mask, so padding tokens
must never reach it.
"""
import os
import unittest

import numpy as np

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REF_MODEL_DIR = os.path.join(SERVICE_DIR, 'cache', 'ref_model')
TEXT_MODEL = os.path.join(SERVICE_DIR, 'models', 'text_model.onnx')

# Mixed lengths on purpose: a one-word query, the zero-shot detector prompts,
# and a long description, so padding would differ per prompt in any batch.
PROMPTS = [
    'synthwave',
    'solo piano',
    'country music with banjo',
    'a song with vocals and singing',
    'an instrumental track with no vocals',
    'epic orchestral trailer music with choir and huge drums building to a '
    'climax',
]

PARITY_MIN = 0.9999


class TestTextParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Hard failures, not skips: a parity test that skips proves nothing.
        for path in (TEXT_MODEL, REF_MODEL_DIR):
            if not os.path.exists(path):
                raise AssertionError(f'text parity input missing: {path}')
        from onnx_backend import OnnxTextCLAPBackend
        cls.backend = OnnxTextCLAPBackend(model_path=TEXT_MODEL)

    def _masked_reference(self, texts):
        import torch
        from transformers import ClapModel, RobertaTokenizer
        model = ClapModel.from_pretrained(REF_MODEL_DIR).eval()
        tok = RobertaTokenizer.from_pretrained('roberta-base')
        enc = tok(texts, padding=True, truncation=True, max_length=77,
                  return_tensors='pt')
        with torch.no_grad():
            out = model.get_text_features(
                input_ids=enc['input_ids'],
                attention_mask=enc['attention_mask'])
        out = getattr(out, 'pooler_output', out).numpy()
        return out / np.linalg.norm(out, axis=1, keepdims=True)

    def test_onnx_text_equals_masked_reference(self):
        onnx = self.backend.embed_text(PROMPTS)
        ref = self._masked_reference(PROMPTS)
        cosines = (onnx * ref).sum(axis=1)
        for prompt, c in zip(PROMPTS, cosines):
            self.assertGreaterEqual(
                float(c), PARITY_MIN,
                f'ONNX text embedding diverges from masked reference '
                f'(cos={c:.4f}) for {prompt!r}')

    def test_embedding_independent_of_batch_companions(self):
        # A prompt's vector must not depend on which other prompts share the
        # call (padding to the longest would make it depend on them).
        alone = self.backend.embed_text([PROMPTS[0]])[0]
        batched = self.backend.embed_text(PROMPTS)[0]
        self.assertGreaterEqual(float(alone @ batched), PARITY_MIN)

    def test_shape_and_unit_norm(self):
        embs = self.backend.embed_text(PROMPTS)
        self.assertEqual(embs.shape, (len(PROMPTS), 512))
        np.testing.assert_allclose(np.linalg.norm(embs, axis=1), 1.0,
                                   atol=1e-5)


if __name__ == '__main__':
    unittest.main()
