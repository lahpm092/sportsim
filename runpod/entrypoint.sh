#!/usr/bin/env bash
set -uo pipefail

/start.sh &                                    # RunPod services (SSH, Jupyter, proxy)

if [ -n "${HF_TOKEN:-}" ]; then
  hf auth login --token "$HF_TOKEN" || true    # only needed for gated facebook/sam3
fi
mkdir -p /workspace/clips /workspace/runs "$HF_HOME"

# Graceful checkpoint on spot/community interruption (~5s SIGTERM warning)
trap 'echo "SIGTERM: flagging interrupt"; touch /workspace/runs/INTERRUPTED' TERM

if [ "${AUTO_RUN:-0}" = "1" ]; then
  python /app/SportSim/runpod/run_segment.py --videos /workspace/clips --out /workspace/runs \
      --fps "${SEG_FPS:-10}" --repo "${SAM3_REPO:-jetjodh/sam3}" 2>&1 | tee -a /workspace/runs/segment.log
  for run in /workspace/runs/*/; do
    [ -f "$run/detections.json" ] || continue
    ( cd /app/SportSim/pipeline && \
      OUT_DIR="$run/out" python 02_track.py && python 03_features.py ) || true
    python /app/SportSim/runpod/run_evolve.py --run "$run" 2>&1 | tee -a /workspace/runs/evolve.log
  done
fi

wait
