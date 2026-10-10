"""
Build step: convert Essentia's MusiCNN graph and its heads to ONNX, then prove
the ONNX graphs answer as Essentia's TensorFlow does before the image ships them.

    python3 convert_musicnn.py convert <dir with the .pb files> <onnx dir>
    python3 convert_musicnn.py reference <dir with the .pb files> <answers.npz>
    python3 convert_musicnn.py gate <onnx dir> <answers.npz>

Three processes: the TensorFlow Python package and Essentia's bundled TensorFlow
cannot be loaded into one. `reference` records Essentia's TensorFlow answers for a
fixed 30 s signal; `gate` needs only Essentia and ONNX Runtime, so it runs in the
build stage (the GPU runtime's ONNX Runtime) and again in the shipped image (its
own), and fails the build unless every embedding has cosine >= 0.99999 to
Essentia's and every head output is within 1e-4. The image keeps the answers, and
the analyzer checks its GPU session against them at every start. On 16 library
tracks: cosine >= 0.99999976, heads within 1.0e-5. tf2onnx's MusiCNN graph differs byte
for byte between runs while its outputs are identical, so the gate checks
behaviour, not a hash.
"""

import os
import sys

import numpy as np

from musicnn_onnx import GRAPHS, MIN_COSINE, MusicnnOnnx, embedding_cosine, gate_signal, mel_patches

OUTPUTS = {name: ('model/dense/BiasAdd' if name == 'musicnn'
                  else 'model/Identity' if name in ('deam', 'emomusic')
                  else 'model/Softmax') for name in GRAPHS}


def convert(pb_dir: str, out_dir: str) -> None:
    import tensorflow as tf
    import tf2onnx
    import onnx
    os.makedirs(out_dir, exist_ok=True)
    for name, stem in GRAPHS.items():
        graph = tf.compat.v1.GraphDef()
        with open(os.path.join(pb_dir, stem + '.pb'), 'rb') as f:
            graph.ParseFromString(f.read())
        proto, _ = tf2onnx.convert.from_graph_def(
            graph, input_names=['model/Placeholder:0'], output_names=[OUTPUTS[name] + ':0'], opset=17)
        onnx.checker.check_model(proto)
        onnx.save(proto, os.path.join(out_dir, stem + '.onnx'))


def reference(pb_dir: str, answers: str) -> None:
    import essentia.standard as es
    audio = gate_signal()
    embedding = es.TensorflowPredictMusiCNN(
        graphFilename=os.path.join(pb_dir, GRAPHS['musicnn'] + '.pb'), output=OUTPUTS['musicnn'])(audio)
    heads = {head: es.TensorflowPredict2D(
        graphFilename=os.path.join(pb_dir, GRAPHS[head] + '.pb'), output=OUTPUTS[head])(embedding)
        for head in GRAPHS if head != 'musicnn'}
    np.savez(answers, musicnn=embedding, **heads)


def gate(onnx_dir: str, answers: str) -> None:
    import onnxruntime
    expected = np.load(answers)
    onnx_models = MusicnnOnnx(onnx_dir, use_gpu=False)
    if sorted(onnx_models.heads()) != sorted(k for k in expected.files if k != 'musicnn'):
        raise SystemExit(f'MusiCNN gate: heads {sorted(onnx_models.heads())} vs answers {sorted(expected.files)}')
    reference_embedding = expected['musicnn']
    try:
        cosine = embedding_cosine(onnx_models.body.run, answers)
    except ValueError as e:
        raise SystemExit(f'MusiCNN gate: {e}') from e
    if cosine < MIN_COSINE:
        raise SystemExit(f'MusiCNN gate: embedding cosine {cosine:.7f} < {MIN_COSINE}')
    for head in onnx_models.heads():
        diff = float(np.abs(onnx_models.predict(head, reference_embedding) - expected[head]).max())
        if diff > 1e-4:
            raise SystemExit(f'MusiCNN gate: {head} differs by {diff:.2e}')
    print(f'MusiCNN gate passed on onnxruntime {onnxruntime.__version__}: {reference_embedding.shape[0]} patches, '
          f'cosine >= {cosine:.7f}, {len(onnx_models.heads())} heads within 1e-4 '
          f'(input frames {mel_patches(gate_signal()).shape})')


if __name__ == '__main__':
    step, source, target = sys.argv[1:4]
    {'convert': convert, 'reference': reference, 'gate': gate}[step](source, target)
