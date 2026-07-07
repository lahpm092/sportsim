"""Render the segmentation overlay film + bundle all data for the viz app.

Overlay: SAM3 instance masks tinted per team on a sepia-graded frame,
contours + foot marks + track ids, gold ball halo with trail, minimal HUD.
Encodes browser-friendly H.264 via imageio-ffmpeg.

Usage: python pipeline/07_export.py
"""
import shutil

import cv2
import imageio.v2 as imageio
import numpy as np

from common import FRAMES, MASKS, OUT, ROOT, VIZ_ASSETS, load_json

TEAM_TINT = {0: (140, 60, 20), 1: (30, 30, 160), 2: (60, 110, 60)}   # BGR: blue-ink, crimson, ref-green
TEAM_LINE = {0: (255, 190, 120), 1: (90, 90, 255), 2: (140, 220, 140)}
BALL_COLOR = (40, 190, 250)   # gold
SEPIA = np.array([[0.272, 0.534, 0.131],
                  [0.349, 0.686, 0.168],
                  [0.393, 0.769, 0.189]])


def sepia_grade(frame, strength=0.55):
    sep = cv2.transform(frame, SEPIA)
    out = cv2.addWeighted(frame, 1 - strength, sep, strength, 0)
    return (out * 0.94).astype(np.uint8)


def main():
    det = load_json(OUT / "detections.json")
    trk = load_json(OUT / "tracks.json")

    # det_id -> (team, tid) per frame
    lookup = {}
    for tr in trk["players"]:
        for o in tr["obs"]:
            lookup[(o["fi"], o["det_id"])] = (tr["team"], tr["tid"])
    ball_det = set()
    if trk["ball"]:
        for o in trk["ball"]["obs"]:
            ball_det.add((o["fi"], o["det_id"]))

    fps_out = det["fps"]
    wr = imageio.get_writer(str(VIZ_ASSETS / "segmentation.mp4"), fps=fps_out,
                            codec="libx264", quality=8, pixelformat="yuv420p",
                            macro_block_size=2)
    ball_trail = []
    n = len(det["frames"])
    for fr in det["frames"]:
        fi = fr["i"]
        frame = cv2.imread(str(FRAMES / f"frame_{fi:04d}.jpg"))
        idm = cv2.imread(str(MASKS / f"mask_{fi:04d}.png"), cv2.IMREAD_UNCHANGED)
        canvas = sepia_grade(frame)
        overlay = canvas.copy()
        for d in fr["detections"]:
            m = idm == d["id"]
            if d["kind"] == "ball" or (fi, d["id"]) in ball_det:
                continue
            team, tid = lookup.get((fi, d["id"]), (2, -1))
            overlay[m] = (0.35 * overlay[m] + 0.65 * np.array(TEAM_TINT[team])).astype(np.uint8)
        canvas = cv2.addWeighted(overlay, 0.85, canvas, 0.15, 0)
        # contours + labels
        for d in fr["detections"]:
            team, tid = lookup.get((fi, d["id"]), (2, -1))
            m = (idm == d["id"]).astype(np.uint8)
            if d["kind"] == "player":
                cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                cv2.drawContours(canvas, cnts, -1, TEAM_LINE[team], 1, cv2.LINE_AA)
                fx, fy = int(d["foot"][0]), int(d["foot"][1])
                cv2.circle(canvas, (fx, fy), 3, TEAM_LINE[team], -1, cv2.LINE_AA)
                if tid >= 0:
                    cv2.putText(canvas, str(tid), (fx + 5, fy - 4),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.42, (245, 240, 225), 1, cv2.LINE_AA)
            else:
                cx, cy = int(d["centroid"][0]), int(d["centroid"][1])
                ball_trail.append((cx, cy))
        # ball trail + halo
        for i2, (bx, by) in enumerate(ball_trail[-14:]):
            a = (i2 + 1) / 14.0
            cv2.circle(canvas, (bx, by), 2, tuple(int(c * a) for c in BALL_COLOR), -1, cv2.LINE_AA)
        if ball_trail:
            bx, by = ball_trail[-1]
            cv2.circle(canvas, (bx, by), 9, BALL_COLOR, 2, cv2.LINE_AA)
        # HUD
        cv2.rectangle(canvas, (0, canvas.shape[0] - 26), (canvas.shape[1], canvas.shape[0]), (18, 22, 28), -1)
        np_, nb_ = sum(1 for d in fr["detections"] if d["kind"] == "player"), sum(1 for d in fr["detections"] if d["kind"] == "ball")
        cv2.putText(canvas, f"SAM 3  |  t={fr['t']:5.1f}s  |  frame {fi+1}/{n}  |  {np_} players  {nb_} ball",
                    (10, canvas.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 190, 170), 1, cv2.LINE_AA)
        wr.append_data(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    wr.close()
    print(f"[export] segmentation.mp4 ({n} frames @ {fps_out:.1f}fps)")

    for f in ("features.json", "evolution.json", "sim.json"):
        if (OUT / f).exists():
            shutil.copy(OUT / f, VIZ_ASSETS / f)
            print(f"[export] copied {f}")


if __name__ == "__main__":
    main()
