#!/usr/bin/env python
"""Build-time + ops verification of the CLAP ONNX runtime stack.

Run inside the built image (or on the testbed) with HF_HUB_OFFLINE=1 so the
baked Hugging Face cache is the ONLY source -- this proves the image boots
without network access to huggingface.co.

Checks:
  1. AUDIO: embed the three tracked fixtures through onnx_backend (the exact
     module the analyzer imports) and require cosine >= 0.999 against
     expected_onnx_embeddings.npy, which was produced by the VALIDATED
     pipeline (shipped hf_audio.onnx sha 37df17af..., pocs toolchain,
     torch_fallback_count == 0). Catches preprocessing/runtime-stack drift
     (transformers/numpy/onnxruntime versions) that a sha gate cannot.
  2. torch_fallback_count must be 0 -- ONNX did the work.
  3. TEXT: load the Xenova text_model.onnx + baked roberta-base tokenizer,
     embed two prompts, assert shape/norm and that they are distinguishable.

Usage: python3 verify_runtime.py <fixtures_dir>
Exit 0 = PASS (prints per-fixture cosines); anything else = FAIL.
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from onnx_backend import OnnxCLAPBackend, OnnxTextCLAPBackend  # noqa: E402

import librosa  # noqa: E402

MIN_COS = 0.999


def main() -> int:
    fixtures = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'test_fixtures')
    expected = np.load(os.path.join(fixtures, 'expected_onnx_embeddings.npy'))
    names = ['sine440.wav', 'white.wav', 'sine880.wav']

    audio_backend = OnnxCLAPBackend()
    audio_backend.load_model()
    ok = True
    for i, name in enumerate(names):
        wav = os.path.join(fixtures, name)
        if not os.path.exists(wav):
            print(f'FAIL: fixture missing: {wav}')
            return 1
        sig, _sr = librosa.load(wav, sr=48000, mono=True)
        emb = audio_backend.embed_audio(sig)
        cos = float(np.dot(emb, expected[i]) /
                    (np.linalg.norm(emb) * np.linalg.norm(expected[i]) + 1e-12))
        status = 'PASS' if cos >= MIN_COS else 'FAIL'
        print(f'[{status}] audio {name}: cosine={cos:.6f} (min {MIN_COS})')
        ok &= cos >= MIN_COS
    if audio_backend.torch_fallback_count != 0:
        print(f'FAIL: torch_fallback_count={audio_backend.torch_fallback_count} (must be 0)')
        ok = False
    else:
        print('[PASS] torch_fallback_count=0 (pure ONNX)')

    text_backend = OnnxTextCLAPBackend()
    text_backend.load_model()
    embs = text_backend.embed_text(['sound of rain on a roof', 'heavy distorted electric guitar'])
    if embs.shape != (2, 512):
        print(f'FAIL: text embeddings shape {embs.shape} != (2, 512)')
        ok = False
    else:
        norms = np.linalg.norm(embs, axis=1)
        cos_tt = float(np.dot(embs[0], embs[1]))
        if not np.all(np.abs(norms - 1.0) < 1e-3):
            print(f'FAIL: text norms {norms} not unit')
            ok = False
        elif cos_tt > 0.999:
            print(f'FAIL: text prompts indistinguishable (cos={cos_tt:.6f})')
            ok = False
        else:
            print(f'[PASS] text backend: shape (2,512), unit norms, cos(rain,guitar)={cos_tt:.4f}')

    print('VERIFY-RUNTIME:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
