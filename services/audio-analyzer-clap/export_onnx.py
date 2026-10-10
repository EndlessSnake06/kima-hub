#!/usr/bin/env python3
"""
Exports HF ClapAudioModelWithProjection (laion/clap-htsat-unfused) to ONNX.
Inputs: log-mel [1, 1, 1001, 64] and `is_longer`. Opset 17 and the dynamic
axes are fixed; the shipped model (sha 37df17af...) depends on them.
Usage: python3 export_onnx.py [--src ckpt_dir] [--out path], or set ONNX_OUT.
"""
import argparse
import os
import hashlib
import torch
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
    with open(OUT, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    assert digest == EXPECTED_SHA256, (
        f"export sha256 mismatch: {digest} != {EXPECTED_SHA256} ({OUT})"
    )
    print(f"saved {OUT} ({size} bytes, sha256={digest})")


if __name__ == "__main__":
    main()
