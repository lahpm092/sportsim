"""Build player/ball tracklets from per-frame SAM3 detections.

Hungarian assignment on a cost mixing box IoU, foot-point distance and jersey
color, with short-gap tolerance. Assigns teams by k-means on track-mean jersey
color (2 teams + outliers=referee/keeper).

Usage: python pipeline/02_track.py
"""
import numpy as np
from scipy.optimize import linear_sum_assignment

from common import OUT, load_json, save_json

MAX_MISS = 6          # frames a track survives unmatched
MIN_TRACK_LEN = 8     # drop shorter tracks
DIST_GATE = 0.08      # max normalized foot distance for a match


def iou(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / ua if ua > 0 else 0.0


def track(detmeta, kind):
    W, H = detmeta["width"], detmeta["height"]
    diag = np.hypot(W, H)
    tracks, active = [], []
    for fr in detmeta["frames"]:
        dets = [d for d in fr["detections"] if d["kind"] == kind]
        if active and dets:
            cost = np.full((len(active), len(dets)), 1e6)
            for i, tr in enumerate(active):
                last = tr["obs"][-1]
                for j, d in enumerate(dets):
                    dist = np.hypot(d["foot"][0] - last["foot"][0], d["foot"][1] - last["foot"][1]) / diag
                    gap = fr["i"] - last["fi"]
                    if dist > DIST_GATE * max(1, gap):
                        continue
                    c = dist * 3.0 + (1.0 - iou(d["box"], last["box"]))
                    if kind == "player" and d.get("jersey_lab") and last.get("jersey_lab"):
                        c += 0.004 * np.linalg.norm(np.array(d["jersey_lab"]) - np.array(last["jersey_lab"]))
                    cost[i, j] = c
            ri, ci = linear_sum_assignment(cost)
            matched_t, matched_d = set(), set()
            for i, j in zip(ri, ci):
                if cost[i, j] < 1e5:
                    d = dets[j]
                    active[i]["obs"].append({"fi": fr["i"], "t": fr["t"], "foot": d["foot"],
                                             "box": d["box"], "area": d["area"], "score": d["score"],
                                             "jersey_lab": d.get("jersey_lab"), "det_id": d["id"]})
                    matched_t.add(i); matched_d.add(j)
            for j, d in enumerate(dets):
                if j not in matched_d:
                    active.append({"obs": [{"fi": fr["i"], "t": fr["t"], "foot": d["foot"], "box": d["box"],
                                            "area": d["area"], "score": d["score"],
                                            "jersey_lab": d.get("jersey_lab"), "det_id": d["id"]}]})
            still = []
            for i, tr in enumerate(active):
                if i in matched_t or fr["i"] - tr["obs"][-1]["fi"] <= MAX_MISS:
                    still.append(tr)
                else:
                    tracks.append(tr)
            active = still
        elif dets:
            for d in dets:
                active.append({"obs": [{"fi": fr["i"], "t": fr["t"], "foot": d["foot"], "box": d["box"],
                                        "area": d["area"], "score": d["score"],
                                        "jersey_lab": d.get("jersey_lab"), "det_id": d["id"]}]})
    tracks.extend(active)
    tracks = [t for t in tracks if len(t["obs"]) >= (MIN_TRACK_LEN if kind == "player" else 3)]
    tracks.sort(key=lambda t: -len(t["obs"]))
    return tracks


def assign_teams(tracks):
    """K-means (k=3) on track-mean jersey Lab color; 2 largest clusters = teams."""
    feats, idxs = [], []
    for i, tr in enumerate(tracks):
        cols = [o["jersey_lab"] for o in tr["obs"] if o.get("jersey_lab")]
        if cols:
            feats.append(np.median(np.array(cols), axis=0))
            idxs.append(i)
    feats = np.array(feats)
    if len(feats) < 4:
        for tr in tracks:
            tr["team"] = 0
        return
    # simple k-means, k=3
    rng = np.random.default_rng(0)
    k = min(3, len(feats))
    centers = feats[rng.choice(len(feats), k, replace=False)]
    for _ in range(50):
        d = np.linalg.norm(feats[:, None] - centers[None], axis=2)
        lab = d.argmin(axis=1)
        new = np.array([feats[lab == j].mean(axis=0) if (lab == j).any() else centers[j] for j in range(k)])
        if np.allclose(new, centers):
            break
        centers = new
    counts = np.bincount(lab, minlength=k)
    order = np.argsort(-counts)
    team_of_cluster = {order[0]: 0, order[1]: 1}
    if k > 2:
        team_of_cluster[order[2]] = 2  # referee / keeper / outlier
    for fi_, i in enumerate(idxs):
        tracks[i]["team"] = int(team_of_cluster[lab[fi_]])
    for tr in tracks:
        tr.setdefault("team", 2)


def main():
    detmeta = load_json(OUT / "detections.json")
    players = track(detmeta, "player")
    balls = track(detmeta, "ball")
    assign_teams(players)
    for tid, tr in enumerate(players):
        tr["tid"] = tid
    result = {
        "width": detmeta["width"], "height": detmeta["height"], "fps": detmeta["fps"],
        "n_frames": len(detmeta["frames"]),
        "players": players,
        "ball": balls[0] if balls else None,
        "ball_fragments": len(balls),
    }
    save_json(OUT / "tracks.json", result)
    t0 = sum(1 for t in players if t["team"] == 0)
    t1 = sum(1 for t in players if t["team"] == 1)
    print(f"[track] {len(players)} player tracks (team0={t0}, team1={t1}, other={len(players)-t0-t1}), "
          f"ball fragments={len(balls)}")
    for tr in players[:24]:
        print(f"  tid={tr['tid']} team={tr['team']} len={len(tr['obs'])} "
              f"frames {tr['obs'][0]['fi']}-{tr['obs'][-1]['fi']}")


if __name__ == "__main__":
    main()
