# syntax=docker/dockerfile:1
# SportSim on RunPod H100 — SAM3 video segmentation + large-scale evolution
# Build from the REPO ROOT:  docker build -f runpod/Dockerfile -t you/sportsim:h100 .
# Base: PyTorch 2.9.1 / CUDA 12.9 / Ubuntu 24.04 (Python 3.12); H100 = sm90.
FROM runpod/pytorch:1.0.7-cu1290-torch291-ubuntu2404

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/workspace/.cache/huggingface \
    TORCH_HOME=/workspace/.cache/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 git rsync \
    && rm -rf /var/lib/apt/lists/*

COPY runpod/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

WORKDIR /app/SportSim
COPY pipeline/ pipeline/
COPY runpod/ runpod/

RUN chmod +x runpod/entrypoint.sh
# RunPod's /start.sh stays the service manager (SSH/Jupyter); batch runs beside it
CMD ["/app/SportSim/runpod/entrypoint.sh"]
