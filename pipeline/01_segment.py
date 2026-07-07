"""Segment soccer players and the ball in a video clip with SAM 3 (text-prompted).

Runs per-frame promptable concept segmentation, saving instance masks (PNG,
instance-id coded) plus per-instance metadata JSON for downstream tracking.

Usage:
  python pipeline/01_segment.py --video data/raw/clip.mp4 --fps 5 --max-frames 120 \
      --repo jetjodh/sam3 --player-prompt "soccer player" --ball-prompt "ball"
"""
import argparse
import os
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import cv2
import numpy as np
import torch
from PIL import Image

from common import FRAMES, MASKS, OUT, save_json, device


def extract_frames(video_path, fps, max_frames, max_side):
    cap = cv2.VideoCapture(str(video_path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    stride = max(1, round(src_fps / fps))
    frames, idx = [], 0
    while len(frames) < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % stride == 0:
            h, w = frame.shape[:2]
            scale = min(1.0, max_side / max(h, w))
            if scale < 1.0:
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            frames.append((idx / src_fps, frame))
        idx += 1
    cap.release()
    return frames, src_fps / stride


def mean_jersey_color(frame_bgr, mask):
    """Mean Lab color of the upper half of a mask (jersey region)."""
    ys, xs = np.nonzero(mask)
    if len(ys) < 10:
        return None
    y_mid = int(ys.min() + 0.45 * (ys.max() - ys.min()))
    sel = ys <= y_mid
    if sel.sum() < 10:
        sel = np.ones_like(ys, dtype=bool)
    lab = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2Lab)
    px = lab[ys[sel], xs[sel]].astype(np.float64)
    return px.mean(axis=0).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent / "models" / "sam3"))
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--max-frames", type=int, default=120)
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--player-prompt", default="soccer player")
    ap.add_argument("--ball-prompt", default="ball")
    ap.add_argument("--player-threshold", type=float, default=0.4)
    ap.add_argument("--ball-threshold", type=float, default=0.35)
    ap.add_argument("--dtype", default="float32", choices=["float32", "bfloat16"])
    args = ap.parse_args()

    dev = device()
    print(f"[segment] device={dev} dtype={args.dtype}")
    from transformers import Sam3Model, Sam3Processor

    model = Sam3Model.from_pretrained(args.repo, dtype=getattr(torch, args.dtype)).to(dev).eval()
    processor = Sam3Processor.from_pretrained(args.repo)

    frames, eff_fps = extract_frames(args.video, args.fps, args.max_frames, args.max_side)
    print(f"[segment] {len(frames)} frames @ ~{eff_fps:.2f} fps effective")

    all_meta = {"video": str(args.video), "fps": eff_fps, "frames": []}
    t0 = time.time()
    for fi, (ts, frame) in enumerate(frames):
        img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        h, w = frame.shape[:2]
        inst_id = 0
        id_mask = np.zeros((h, w), dtype=np.uint16)
        detections = []
        for prompt, thr, kind in (
            (args.player_prompt, args.player_threshold, "player"),
            (args.ball_prompt, args.ball_threshold, "ball"),
        ):
            inputs = processor(images=img, text=prompt, return_tensors="pt").to(dev)
            with torch.inference_mode():
                outputs = model(**inputs)
            res = processor.post_process_instance_segmentation(
                outputs, threshold=thr, mask_threshold=0.5, target_sizes=[(h, w)]
            )[0]
            masks = res["masks"].cpu().numpy().astype(bool)
            boxes = res["boxes"].float().cpu().numpy()
            scores = res["scores"].float().cpu().numpy()
            for m, b, s in zip(masks, boxes, scores):
                area = int(m.sum())
                if area < (4 if kind == "ball" else 40):
                    continue
                inst_id += 1
                id_mask[m] = inst_id
                x0, y0, x1, y1 = [float(v) for v in b]
                det = {
                    "id": inst_id,
                    "kind": kind,
                    "score": float(s),
                    "box": [x0, y0, x1, y1],
                    "area": area,
                    "foot": [(x0 + x1) / 2.0, y1],  # ground contact point
                    "centroid": [float(np.mean(np.nonzero(m)[1])), float(np.mean(np.nonzero(m)[0]))],
                }
                if kind == "player":
                    det["jersey_lab"] = mean_jersey_color(frame, m)
                detections.append(det)
        cv2.imwrite(str(MASKS / f"mask_{fi:04d}.png"), id_mask)
        cv2.imwrite(str(FRAMES / f"frame_{fi:04d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        all_meta["frames"].append({"i": fi, "t": ts, "detections": detections})
        n_players = sum(1 for d in detections if d["kind"] == "player")
        n_balls = sum(1 for d in detections if d["kind"] == "ball")
        el = time.time() - t0
        print(f"[segment] frame {fi+1}/{len(frames)}: {n_players} players, {n_balls} ball | {el/(fi+1):.1f}s/frame", flush=True)

    all_meta["width"], all_meta["height"] = frames[0][1].shape[1], frames[0][1].shape[0]
    save_json(OUT / "detections.json", all_meta)
    print(f"[segment] saved {OUT/'detections.json'} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
