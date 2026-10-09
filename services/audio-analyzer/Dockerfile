# Audio Analyzer Service - Essentia signal analysis with MusiCNN on ONNX Runtime.
# Built from the repository root (docker-compose.yml), so it can carry the shared
# GPU wrapper from the CLAP service.

# Essentia's MusiCNN model and its ten heads, checksum-verified, converted to ONNX
# and gated: the build fails unless the ONNX graphs answer as Essentia's TensorFlow
# does (convert_musicnn.py). Only the ONNX files reach the image, so it carries no
# TensorFlow. The graphs are the same on every platform; the stage runs as x86_64
# because Essentia-TensorFlow publishes no other Linux wheel.
FROM --platform=linux/amd64 python:3.11-slim AS musicnn-onnx-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir 'tensorflow-cpu==2.13.1' 'onnxruntime==1.22.0' 'requests' \
    && pip3 install --no-cache-dir --no-deps 'tf2onnx==1.16.1' 'onnx==1.14.1' 'essentia-tensorflow==2.1b6.dev1389'
COPY services/audio-analyzer/fetch_models.sh services/audio-analyzer/models.sha256 \
     services/audio-analyzer/musicnn_onnx.py services/audio-analyzer/convert_musicnn.py ./
# onnxruntime 1.22.0 is the GPU runtime's version; the shipped image checks its own below.
RUN sh fetch_models.sh pb \
    && python3 convert_musicnn.py convert pb onnx \
    && python3 convert_musicnn.py reference pb answers.npz \
    && python3 convert_musicnn.py gate onnx answers.npz

FROM python:3.11-slim

ENV TZ=UTC \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    THREADS_PER_WORKER=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The versions the main image ships. Essentia declares numpy>=1.25 but runs on the
# images' numpy 1.24.4 (the sound-vector parity pin); the gate below proves it.
RUN pip3 install --no-cache-dir 'numpy==1.24.4' 'onnxruntime==1.30.0' pyyaml six redis psycopg2-binary \
    && pip3 install --no-cache-dir --no-deps 'essentia==2.1b6.dev1389'

# MusiCNN and its heads as ONNX, checked again on this image's own ONNX Runtime. The
# answers stay: the analyzer checks its GPU session against them at every start.
COPY --from=musicnn-onnx-builder /build/onnx/ /app/models/
COPY --from=musicnn-onnx-builder /build/answers.npz /app/models/musicnn-answers.npz
COPY services/audio-analyzer/convert_musicnn.py services/audio-analyzer/musicnn_onnx.py /tmp/musicnn-gate/
RUN cd /tmp/musicnn-gate && python3 convert_musicnn.py gate /app/models /app/models/musicnn-answers.npz \
    && rm -rf /tmp/musicnn-gate

# analyzer.py imports classifier and musicnn_onnx at load. The wrapper puts the shared
# GPU runtime on the path when "GPU for audio analysis" is on.
COPY services/audio-analyzer/analyzer.py services/audio-analyzer/classifier.py services/audio-analyzer/musicnn_onnx.py \
     services/audio-analyzer-clap/gpu_switch.py ./
COPY services/audio-analyzer-clap/gpu_env.sh /app/gpu_env.sh

# /gpu-onnx is where compose mounts the shared GPU runtime volume; a new or empty volume takes this folder's owner.
RUN useradd -m -u 1000 analyzer && \
    mkdir -p /gpu-onnx && \
    chown -R analyzer:analyzer /app /gpu-onnx

USER analyzer

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD pgrep -f "python.*analyzer" || exit 1

ENV KIMA_GPU_FOR=analysis
ENTRYPOINT ["/app/gpu_env.sh"]
CMD ["python3", "analyzer.py"]
