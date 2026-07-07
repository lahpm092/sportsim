"""H100 batch segmentation: SAM3 TRUE video tracking (persistent object IDs).

Unlike the Mac PoC (per-frame PCS + Hungarian association), the H100 path uses
Sam3VideoModel's streaming tracker — text-prompted, temporally consistent IDs,
bf16, CUDA kernels for mask NMS. Emits the same detections.json/masks contract
consumed by pipeline/02_track.py (tracking degrades to a passthrough) and the
rest of the local pipeline.

Usage (on pod):
  python runpod/run_segment.py --videos /workspace/clips --out /workspace/runs \
      --fps 10 --max-side 1280 [--repo facebook/sam3|jetjodh/sam3]
"""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch


def read_frames(path, fps, max_side):
    cap = cv2.VideoCapture(str(path))
    src = cap.get(cv2.CAP_PROP_FPS) or 25.0
    stride = max(1, round(src / fps))
    frames, ts, i = [], [], 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if i % stride == 0:
            h, w = f.shape[:2]
            s = min(1.0, max_side / max(h, w))
            if s < 1.0:
                f = cv2.resize(f, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
            frames.append(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
            ts.append(i / src)
        i += 1
    cap.release()
    return np.stack(frames), ts, src / stride


def jersey_lab(rgb, mask):
    ys, xs = np.nonzero(mask)
    if len(ys) < 10:
        return None
    ymid = int(ys.min() + 0.45 * (ys.max() - ys.min()))
    sel = ys <= ymid
    if sel.sum() < 10:
        sel = np.ones_like(ys, bool)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2Lab)
    return lab[ys[sel], xs[sel]].astype(float).mean(0).tolist()


def segment_video(video, outdir, args, model, processor, device):
    frames, ts, eff_fps = read_frames(video, args.fps, args.max_side)
    T, H, W = frames.shape[:3]
    print(f"[{video.name}] {T} frames {W}x{H} @ {eff_fps:.1f}fps")
    session = processor.init_video_session(
        video=frames, inference_device=device, processing_device="cpu",
        video_storage_device="cpu", dtype=torch.bfloat16)
    processor.add_text_prompt(session, [args.player_prompt, args.ball_prompt])

    (outdir / "masks").mkdir(parents=True, exist_ok=True)
    (outdir / "frames").mkdir(exist_ok=True)
    meta = {"video": str(video), "fps": eff_fps, "width": W, "height": H, "frames": []}
    t0 = time.time()
    for out in model.propagate_in_video_iterator(inference_session=session,
                                                 max_frame_num_to_track=T, show_progress_bar=True):
        proc = processor.postprocess_outputs(session, out)
        fi = out.frame_idx
        rgb = frames[fi]
        obj_ids = proc["object_ids"].tolist()
        masks = proc["masks"].cpu().numpy().astype(bool)
        boxes = proc["boxes"].cpu().numpy()
        scores = proc["scores"].cpu().numpy() if proc.get("scores") is not None else np.ones(len(obj_ids))
        p2o = {k: set(v) for k, v in proc.get("prompt_to_obj_ids", {}).items()}
        id_mask = np.zeros((H, W), np.uint16)
        dets = []
        for oid, m, b, s in zip(obj_ids, masks, boxes, scores):
            kind = "ball" if oid in p2o.get(args.ball_prompt, set()) else "player"
            area = int(m.sum())
            if area < (4 if kind == "ball" else 40):
                continue
            id_mask[m] = oid + 1
            x0, y0, x1, y1 = map(float, b)
            d = {"id": int(oid + 1), "track_id": int(oid), "kind": kind, "score": float(s),
                 "box": [x0, y0, x1, y1], "area": area, "foot": [(x0 + x1) / 2, y1],
                 "centroid": [float(np.nonzero(m)[1].mean()), float(np.nonzero(m)[0].mean())]}
            if kind == "player":
                d["jersey_lab"] = jersey_lab(rgb, m)
            dets.append(d)
        cv2.imwrite(str(outdir / "masks" / f"mask_{fi:04d}.png"), id_mask)
        cv2.imwrite(str(outdir / "frames" / f"frame_{fi:04d}.jpg"),
                    cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
        meta["frames"].append({"i": fi, "t": ts[fi], "detections": dets})
    with open(outdir / "detections.json", "w") as f:
        json.dump(meta, f)
    print(f"[{video.name}] done in {time.time()-t0:.0f}s -> {outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True, help="directory of clips or single file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", default="jetjodh/sam3", help="facebook/sam3 if you have gated access")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--player-prompt", default="soccer player")
    ap.add_argument("--ball-prompt", default="ball")
    args = ap.parse_args()

    from transformers import Sam3VideoModel, Sam3VideoProcessor
    device = "cuda"
    model = Sam3VideoModel.from_pretrained(args.repo, dtype=torch.bfloat16).to(device).eval()
    processor = Sam3VideoProcessor.from_pretrained(args.repo)

    src = Path(args.videos)
    vids = sorted(src.glob("*.mp4")) + sorted(src.glob("*.webm")) if src.is_dir() else [src]
    for v in vids:
        outdir = Path(args.out) / v.stem
        if (outdir / "detections.json").exists():
            print(f"[skip] {v.name} already segmented")
            continue
        segment_video(v, outdir, args, model, processor, device)


if __name__ == "__main__":
    main()
