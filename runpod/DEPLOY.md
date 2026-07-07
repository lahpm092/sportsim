# SportSim on a RunPod H100

The Mac PoC runs SAM3 per-frame; this package upgrades to **true SAM3 video
tracking** (persistent IDs, bf16, CUDA mask-NMS kernels) and industrial-scale
evolution (pop 24 × 120 gens × 4 restarts × all players, parallel across vCPUs).

## 0. Build & push (from repo root)

```bash
docker build -f runpod/Dockerfile -t <you>/sportsim:h100 .
docker push <you>/sportsim:h100
```

## 1. Create a network volume (once) — pins to a datacenter

```bash
curl -s -X POST https://rest.runpod.io/v1/networkvolumes \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"sportsim-data","size":250,"dataCenterId":"US-KS-2"}'
```

## 2. Launch the H100 pod

```bash
runpodctl pod create \
  --name sportsim-h100 \
  --image "<you>/sportsim:h100" \
  --gpu-id "NVIDIA H100 80GB HBM3" \
  --cloud-type SECURE \
  --min-cuda-version 12.9 \
  --container-disk-in-gb 80 \
  --network-volume-id <VOLUME_ID> \
  --ports "8888/http,22/tcp" \
  --env '{"AUTO_RUN":"0","SAM3_REPO":"jetjodh/sam3"}' \
  --ssh --terminate-after 12h
```

REST equivalent: `POST https://rest.runpod.io/v1/pods` with
`{"gpuTypeIds":["NVIDIA H100 80GB HBM3"], "networkVolumeId":"...", ...}`.

Pricing (July 2026): H100 80GB ≈ $2.4–2.7/hr secure, ≈ $1.9/hr community.
Community is fine — the entrypoint checkpoint-flags SIGTERM interruptions.

## 3. Load clips and run

```bash
# push footage to the volume
rsync -avP clips/ root@<pod-ip>:/workspace/clips/   # or runpodctl send

# on the pod:
python /app/SportSim/runpod/run_segment.py --videos /workspace/clips --out /workspace/runs --fps 10
cd /app/SportSim/pipeline && python 02_track.py && python 02b_homography.py && python 03_features.py
python /app/SportSim/runpod/run_evolve.py --run /workspace/runs/<clip> --gens 120 --pop 24
python /app/SportSim/pipeline/06_simulate.py && python /app/SportSim/pipeline/07_export.py

# pull results back
rsync -avP root@<pod-ip>:/workspace/runs/<clip>/out/ ./out/
```

Set `--env '{"AUTO_RUN":"1"}'` to run the full sweep automatically on boot.

## Gotchas (learned the hard way)

- **Container disk is ephemeral** — anything worth keeping goes to `/workspace`
  (the network volume). That includes the HF cache (`HF_HOME` is set there).
- `facebook/sam3` is **gated (manual approval)**; the byte-identical ungated
  mirror `jetjodh/sam3` is the default. Set `HF_TOKEN` + `SAM3_REPO=facebook/sam3`
  once your access request is approved.
- Match `--min-cuda-version` to the image (cu1290) or the pod may land on an
  old driver host.
- Expose 22/tcp for rsync; 8888/http proxies JupyterLab through RunPod's gateway.
- Spot/community pods get ~5 s of SIGTERM before termination: the entrypoint
  writes `/workspace/runs/INTERRUPTED` so a relaunch can resume (run_segment
  skips clips whose `detections.json` already exists).

## Scaling expectations

- Segmentation: SAM3 video on H100 bf16 ≈ 2–4 fps of 1280×720 → a 20 s clip
  in ~1–2 min; a 90-min match at 10 fps ≈ 6–8 h (or shard across pods).
- Evolution: ~5 min per player at industrial settings × 22 players on 20 vCPUs
  ≈ 30 min per clip. GPU idles during evolution — pipeline segmentation of the
  next clip concurrently.
