"""Camera pan compensation + pitch calibration.

The broadcast camera pans, so a single static homography is wrong. We:
 1. chain frame-to-frame homographies (Shi-Tomasi + pyramidal LK + RANSAC),
    masking out moving players (from SAM3 detections) and the crowd,
 2. compose with one hand-calibrated reference homography (image -> pitch
    meters) specified in data/calibration.json:
      {"ref_frame": 45, "points": [{"px": [x,y], "pitch": [X,Y]}, ...]}
 3. emit out/homography.json {H_per_frame: {frame_idx: 3x3}} used by 03_features.

Usage: python pipeline/02b_homography.py
"""
import cv2
import numpy as np

from common import DATA, FRAMES, OUT, load_json, save_json


def player_mask(shape, dets, dilate=12):
    m = np.full(shape, 255, dtype=np.uint8)
    h, w = shape
    m[: int(0.32 * h), :] = 0                      # crowd region: unreliable
    for d in dets:
        x0, y0, x1, y1 = [int(v) for v in d["box"]]
        cv2.rectangle(m, (max(x0 - dilate, 0), max(y0 - dilate, 0)),
                      (min(x1 + dilate, w - 1), min(y1 + dilate, h - 1)), 0, -1)
    return m


def main():
    det = load_json(OUT / "detections.json")
    calib = load_json(DATA / "calibration.json")
    ref = calib["ref_frame"]
    img_pts = np.array([p["px"] for p in calib["points"]], dtype=np.float64)
    pitch_pts = np.array([p["pitch"] for p in calib["points"]], dtype=np.float64)
    H0, err = cv2.findHomography(img_pts, pitch_pts, 0)
    proj = cv2.perspectiveTransform(img_pts.reshape(-1, 1, 2), H0).reshape(-1, 2)
    resid = np.linalg.norm(proj - pitch_pts, axis=1)
    print(f"[homog] reference frame {ref}: {len(img_pts)} landmarks, residual "
          f"mean={resid.mean():.2f}m max={resid.max():.2f}m")

    n = len(det["frames"])
    grays, masks = [], []
    for fr in det["frames"]:
        g = cv2.imread(str(FRAMES / f"frame_{fr['i']:04d}.jpg"), cv2.IMREAD_GRAYSCALE)
        grays.append(g)
        masks.append(player_mask(g.shape, fr["detections"]))

    # frame-to-frame homographies
    lk = dict(winSize=(31, 31), maxLevel=4,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))
    H_step = [np.eye(3)] * n     # H_step[t]: frame t -> frame t-1
    for t in range(1, n):
        p0 = cv2.goodFeaturesToTrack(grays[t], maxCorners=600, qualityLevel=0.01,
                                     minDistance=12, mask=masks[t], blockSize=7)
        if p0 is None or len(p0) < 20:
            H_step[t] = np.eye(3); continue
        p1, st, _ = cv2.calcOpticalFlowPyrLK(grays[t], grays[t - 1], p0, None, **lk)
        ok = st.ravel() == 1
        if ok.sum() < 20:
            H_step[t] = np.eye(3); continue
        H, inl = cv2.findHomography(p0[ok], p1[ok], cv2.RANSAC, 3.0)
        H_step[t] = H if H is not None else np.eye(3)

    # chain to reference frame
    H_to_ref = {ref: np.eye(3)}
    acc = np.eye(3)
    for t in range(ref + 1, n):          # forward: t -> ref
        acc = acc @ H_step[t] if t == ref + 1 else acc
        # recompute cleanly: H_{t->ref} = H_{t-1->ref} @ H_step[t]
        H_to_ref[t] = H_to_ref[t - 1] @ H_step[t]
    for t in range(ref - 1, -1, -1):     # backward: t -> ref uses inverse steps
        H_to_ref[t] = H_to_ref[t + 1] @ np.linalg.inv(H_step[t + 1])

    H_pitch = {t: (H0 @ H_to_ref[t]).tolist() for t in range(n)}
    # sanity: track a fixed pitch point across frames
    c = np.array([[det["width"] / 2, det["height"] * 0.7]], dtype=np.float64).reshape(-1, 1, 2)
    drift = [cv2.perspectiveTransform(c, np.array(H_pitch[t]))[0, 0] for t in (0, n // 2, n - 1)]
    print(f"[homog] image center-bottom maps to pitch: t0={np.round(drift[0],1)} "
          f"mid={np.round(drift[1],1)} end={np.round(drift[2],1)}")
    save_json(OUT / "homography.json",
              {"H_per_frame": H_pitch, "note": f"pan-compensated, ref={ref}, resid={resid.mean():.2f}m"})
    print(f"[homog] saved {n} per-frame homographies")


if __name__ == "__main__":
    main()
