# CI-only proof job (nightly musicnn-reproof). Re-derives the vendored ONNX
# from the committed .pb sources and gates it against the vendored reference
# answers. Not used by any shipped image: the images COPY the vendored ONNX
# and run the same gate, without TensorFlow.
FROM python:3.11-slim
WORKDIR /reprove

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config curl ca-certificates \
        libeigen3-dev libfftw3-dev libyaml-dev libsamplerate0-dev \
    && rm -rf /var/lib/apt/lists/*

# numpy 1.24.3 first: TF 2.13.1's arm64 wheel accepts at most 1.24.3.
# tf2onnx/onnx --no-deps mirrors the release toolchain pins.
RUN pip3 install --no-cache-dir 'numpy==1.24.3' \
    && pip3 install --no-cache-dir 'tensorflow==2.13.1' 'onnxruntime==1.22.0' 'requests' \
    && pip3 install --no-cache-dir --no-deps 'tf2onnx==1.16.1' 'onnx==1.14.1'

# Essentia dev1389 from source: the reference pass needs TensorflowInputMusiCNN.
RUN curl -fsSL --retry 5 -o essentia.tar.gz \
        'https://github.com/MTG/essentia/archive/36ec3d929402d491cbbb1120c54631e8c205b0ff.tar.gz' \
    && mkdir essentia-src && tar xzf essentia.tar.gz -C essentia-src --strip-components=1 \
    && cd essentia-src \
    && python3 waf configure --mode=release --with-python \
    && python3 waf -j"$(nproc)" \
    && python3 waf install \
    && ldconfig \
    && cd /reprove && rm -rf essentia-src essentia.tar.gz

COPY pb/ ./pb/
COPY models/ ./models/
COPY convert_musicnn.py musicnn_onnx.py ./

# Verify the committed .pb sources against their checksums, convert them to a
# fresh onnx/ directory, and gate the FRESH conversion against the VENDORED
# reference answers. Then gate the VENDORED onnx on the same answers: both
# must pass, which ties the committed artifacts to the committed sources.
RUN cd /reprove \
    && (cd pb && sha256sum -c onnx-source.sha256) \
    && (cd models && sha256sum -c MANIFEST.sha256) \
    && python3 convert_musicnn.py convert pb fresh-onnx \
    && python3 convert_musicnn.py gate fresh-onnx models/musicnn-answers.npz \
    && python3 convert_musicnn.py gate models models/musicnn-answers.npz
