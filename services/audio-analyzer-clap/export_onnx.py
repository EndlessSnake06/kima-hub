#!/usr/bin/env python3
"""
torch.onnx.export for the HF ClapAudioModelWithProjection (laion/clap-htsat-unfused).

Input is the HF log-mel spectrogram [1, 1, 1001, 64] (batch, channels, height,
width) plus the `is_longer` boolean flag.  Opset 17 and the dynamic axes below
are intentionally fixed: the shipped sha 37df17af... depends on them.

The output path is
parameterised via the --out CLI arg (default: this file's directory /
hf_audio.onnx).  The source checkpoint directory is parameterised via --src
(default: loaded by name from_pretrained("laion/clap-htsat-unfused")).

Usage:
    python3 export_onnx.py --src /path/to/ckpt --out hf_audio.onnx
    ONNX_OUT=hf_audio.onnx python3 export_onnx.py
"""
import argparse
import os
import hashlib
import torch
import transformers
from transformers import ClapAudioModelWithProjection

ROOT = os.path.dirname(os.path.abspath(__file__))

DEFAULT_OUT = os.path.join(ROOT, "hf_audio.onnx")

# sha256 of the validated export (opset 17 + these dynamic axes).
EXPECTED_SHA256 = (
    "37df17afb9881569c4f50e5b691167aa54586418059701a74a54934514969972"
)


class Wrapper(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x, is_longer=None):
        out = self.m(x, is_longer=is_longer)
        return out[0] if isinstance(out, tuple) else out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", default=None,
                    help="HF snapshot dir (files like config.json, "
                         "pytorch_model.bin); when omitted the model is loaded "
                         "by name from_pretrained('laion/clap-htsat-unfused').")
    ap.add_argument("--out", default=os.environ.get("ONNX_OUT", DEFAULT_OUT),
                    help="output ONNX path")
    args = ap.parse_args()

    OUT = args.out
    if args.src:
        model = ClapAudioModelWithProjection.from_pretrained(args.src).eval()
    else:
        model = ClapAudioModelWithProjection.from_pretrained(
            "laion/clap-htsat-unfused").eval()

    wrap = Wrapper(model)
    dummy = torch.zeros(1, 1, 1001, 64)
    dummy_longer = torch.zeros(1, dtype=torch.bool)
    torch.onnx.export(
        wrap, (dummy, dummy_longer), OUT,
        input_names=["input", "is_longer"], output_names=["output"],
        opset_version=17, dynamic_axes={
            "input": {0: "batch", 2: "time"},
            "is_longer": {0: "batch"},
            "output": {0: "batch"},
        },
        do_constant_folding=True,
    )

    size = os.path.getsize(OUT)
    digest = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    assert digest == EXPECTED_SHA256, (
        f"export sha256 mismatch: {digest} != {EXPECTED_SHA256} ({OUT})"
    )
    print(f"saved {OUT} ({size} bytes, sha256={digest})")


if __name__ == "__main__":
    main()
