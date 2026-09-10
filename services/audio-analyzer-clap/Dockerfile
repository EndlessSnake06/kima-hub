# CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity
FROM python:3.10-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# CPU thread limiting for PyTorch and numerical libraries
# Prevents workers from using all CPU cores
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    TORCH_NUM_THREADS=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies. Torch is installed from the CPU-only index:
# the PyPI default wheel drags in nvidia CUDA libraries (~2.5GB) that this
# analyzer can never use (CPU-only, `cpus`-limited, no GPU mounts), and the
# base image has no room for them (the build failed the layer
# export with "no space left on device" until this change). The CPU wheel
# also keeps the deployed image small for every user.
COPY requirements.txt .
# Torch from the CPU-only wheel index: the PyPI default drags in nvidia CUDA
# libraries (~2.5GB) this CPU-only analyzer can never use (no GPU mounts,
# `cpus`-limited), which also blew the layer export on that build.
# Arch-aware: 2.6.0 is the newest amd64 cp310 CPU wheel, but torchaudio 2.6.0
# has NO aarch64 wheel -- arm64-host builds must use the newer train that ships
# both arches (2.14.0/2.11.0/0.29.0 all have cp310 linux aarch64 cpu wheels).
# --extra-index-url (not --index-url) keeps pip able to fetch build deps.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        pip install --no-cache-dir \
            --extra-index-url https://download.pytorch.org/whl/cpu \
            "torch==2.14.0+cpu" "torchaudio==2.11.0+cpu" "torchvision==0.29.0+cpu"; \
    else \
        pip install --no-cache-dir \
            --extra-index-url https://download.pytorch.org/whl/cpu \
            "torch==2.6.0+cpu" "torchaudio==2.6.0+cpu" "torchvision==0.21.0+cpu"; \
    fi
RUN pip install --no-cache-dir -r requirements.txt

# Create models directory
RUN mkdir -p /app/models

# Download CLAP model at build time
# Using music_audioset checkpoint for music-specific embeddings
RUN curl -L -o /app/models/music_audioset_epoch_15_esc_90.14.pt \
    "https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt"

# Verify model loads correctly
RUN python -c "import laion_clap; model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base'); model.load_ckpt('/app/models/music_audioset_epoch_15_esc_90.14.pt'); print('CLAP model verified successfully')"

# Copy application code -- ALL of it. onnx_backend.py is imported by
# analyzer.py at module load (analyzer.py:77), so a fresh image that omits it
# cannot import at all; and the validated ONNX audio encoder must land at
# /app/models/hf_audio.onnx so onnx_backend's default path resolves in-image.
COPY analyzer.py .
COPY onnx_backend.py .
COPY models/hf_audio.onnx /app/models/hf_audio.onnx
# The ONNX TEXT encoder (Xenova clap-htsat-unfused text_model.onnx, ~501MB).
# The analyzer's text path (vibe search + the four zero-shot detectors) is
# pure-ONNX under CLAP_BACKEND=onnx with 1.0000 parity to laion_clap
# (text_parity_gate.py, 2026-09-10). If missing, ONNX-mode text calls fail.
COPY models/text_model.onnx /app/models/text_model.onnx
# Deploy note: both ONNX models are
# gitignored (models/ dir) and MUST be present in the build context -- the
# test-server deploy path carries them (rsync of the models/ dir). Do NOT
# switch these COPYs to curl-at-build from HuggingFace: the HF
# onnx/audio_model.onnx currently FAILS audio parity (cosine 0.49-0.71 vs the
# validated export's 1.0000, measured 2026-09-10) -- it is a different model.
# The validated weights exist only as the deploy artifact.

# Verify the ONNX backend actually initializes from the shipped model. This is
# the "no silent torch fallback" gate: if onnxruntime or the model were broken,
# the image build fails HERE instead of shipping an image that claims ONNX and
# runs torch. The model's sha256 (37df17af…) is pinned;
# audio_model_patched.onnx from the POC scratch is a BROKEN draft and must
# never be COPY'd in its place.
RUN python -c "from onnx_backend import OnnxCLAPBackend; b = OnnxCLAPBackend(); b.load_model(); print('[CLAP] ONNX backend verified: ' + b.model_path)"
# Verify the ONNX TEXT backend too (tokenizer + text model) so a broken text
# export fails the build, not the first vibe-search query.
RUN python -c "from onnx_backend import OnnxTextCLAPBackend, ONNX_TEXT_MODEL_PATH; b = OnnxTextCLAPBackend(ONNX_TEXT_MODEL_PATH); b.load_model(); print('[CLAP] ONNX text backend verified: ' + b.model_path)"

# Create non-root user
RUN useradd -m -u 1000 analyzer && \
    chown -R analyzer:analyzer /app

USER analyzer

# Health check that imports laion_clap
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import laion_clap; print('OK')" || exit 1

CMD ["python", "analyzer.py"]