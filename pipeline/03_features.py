"""Symbolic abstraction: temporal masks -> pitch tracks -> behavioral symbols.

Per player:
  * resampled pitch trajectory (uniform dt, homography-projected, SG-smoothed)
  * symbolic token stream: 33-symbol alphabet (stationary + 8 directions x 4
    speed bands) in ATTACK-NORMALIZED coordinates, +/-10% band hysteresis,
    explicit gap token for occlusion (never fabricate through gaps)
  * behavioral motifs: shared codebook of frequent 2/3-grams pooled across all
    players (min support), per-player Laplace-smoothed TF-IDF fingerprints,
    Dirichlet-smoothed bigram transition matrix
  * style vector: pace, discipline, ball affinity, cooperation, aggression
    (stamina = null: unidentifiable from a ~20s clip, by design)

Usage: python pipeline/03_features.py
"""
import numpy as np
from scipy.signal import savgol_filter

from common import OUT, PITCH_L, PITCH_W, load_json, save_json

DT = 0.2
TOKEN_WIN = 0.4          # seconds per symbolic token
V_STILL = 0.5            # m/s below which direction is meaningless
BANDS = [0.5, 2.0, 4.0, 5.5]   # stationary | walk | jog | run | sprint
HYST = 0.10
GAP = -1
V_SPIKE, A_SPIKE = 11.0, 12.0
CODEBOOK_MIN = 3


def load_homography():
    p = OUT / "homography.json"
    if p.exists():
        d = load_json(p)
        return {int(k): np.array(v, dtype=np.float64) for k, v in d["H_per_frame"].items()}, d.get("note", "")
    return None, "no homography — normalized image coords"


def project(H_map, frame_idx, pts, width, height):
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if H_map is None:
        out = np.empty_like(pts)
        out[:, 0] = pts[:, 0] / width * PITCH_L
        out[:, 1] = pts[:, 1] / height * PITCH_W
        return out
    H = H_map.get(frame_idx)
    if H is None:  # nearest available
        keys = np.array(sorted(H_map.keys()))
        H = H_map[int(keys[np.argmin(np.abs(keys - frame_idx))])]
    ones = np.ones((len(pts), 1))
    q = (H @ np.hstack([pts, ones]).T).T
    return q[:, :2] / q[:, 2:3]


def resample(obs, H_map, width, height, t_grid, src_fps):
    """Project each observation with ITS frame's homography, then resample."""
    t = np.array([o["t"] for o in obs])
    pitch_pts = np.vstack([project(H_map, o["fi"], o["foot"], width, height) for o in obs])
    x = np.interp(t_grid, t, pitch_pts[:, 0], left=np.nan, right=np.nan)
    y = np.interp(t_grid, t, pitch_pts[:, 1], left=np.nan, right=np.nan)
    # kill grid points > 0.5s from any real observation (no fabrication through gaps)
    gapmask = np.array([np.abs(t - g).min() > 0.5 for g in t_grid])
    x[gapmask] = np.nan; y[gapmask] = np.nan
    return np.stack([x, y], axis=1)


def sg_smooth(xy):
    out = xy.copy()
    ok = ~np.isnan(xy).any(axis=1)
    idx = np.nonzero(ok)[0]
    if len(idx) >= 7:
        seg = xy[idx]
        out[idx] = savgol_filter(seg, 7, 2, axis=0)
    return out


def kinematics(xy, dt):
    valid = ~np.isnan(xy).any(axis=1)
    filled = np.where(valid[:, None], xy, 0.0)
    vel = np.gradient(filled, dt, axis=0)
    acc = np.linalg.norm(np.gradient(vel, dt, axis=0), axis=1)
    sp = np.linalg.norm(vel, axis=1)
    good = valid & (sp <= V_SPIKE) & (acc <= A_SPIKE)
    vel[~good] = np.nan
    return vel, good


def tokenize(vel, good, attack_dir, dt):
    per = max(1, int(round(TOKEN_WIN / dt)))
    toks, prev_band = [], 0
    for i in range(0, len(vel) - per + 1, per):
        w_good = good[i:i + per]
        if w_good.mean() < 0.5:
            toks.append(GAP); prev_band = 0
            continue
        v = np.nanmean(vel[i:i + per][w_good], axis=0) * np.array([attack_dir, 1.0])
        sp = np.linalg.norm(v)
        band = int(np.searchsorted(BANDS, sp))
        # hysteresis: stay in prev band unless clearly past the boundary
        if band != prev_band and prev_band > 0:
            edge = BANDS[min(prev_band, band, len(BANDS) - 1)]
            if abs(sp - edge) < HYST * edge:
                band = prev_band
        prev_band = band
        if band == 0:
            toks.append(0)
        else:
            octant = int(((np.arctan2(v[1], v[0]) + np.pi) / (2 * np.pi) * 8)) % 8
            toks.append(1 + (band - 1) * 8 + octant)   # 1..32
    return toks


def build_codebook(all_tokens):
    counts = {}
    for toks in all_tokens.values():
        for n in (2, 3):
            for i in range(len(toks) - n + 1):
                g = tuple(toks[i:i + n])
                if GAP in g or len(set(g)) == 1:
                    continue
                counts[g] = counts.get(g, 0) + 1
    return [list(g) for g, c in sorted(counts.items(), key=lambda kv: -kv[1]) if c >= CODEBOOK_MIN]


def fingerprint(toks, codebook):
    v = np.full(len(codebook), 0.5)          # Laplace alpha
    for gi, g in enumerate(codebook):
        n = len(g)
        for i in range(len(toks) - n + 1):
            if toks[i:i + n] == g:
                v[gi] += 1
    return v / v.sum()


def bigram_matrix(toks, k=33, alpha=0.1):
    Mx = np.full((k, k), alpha)
    for a, b in zip(toks[:-1], toks[1:]):
        if a != GAP and b != GAP:
            Mx[a, b] += 1
    return Mx / Mx.sum(axis=1, keepdims=True)


def xcorr_peak(v1, v2, max_lag, dt):
    """Peak cosine cross-correlation of two velocity series within +/-max_lag."""
    best = 0.0
    L = int(max_lag / dt)
    for lag in range(-L, L + 1):
        a = v1[max(0, lag):len(v1) + min(0, lag)]
        b = v2[max(0, -lag):len(v2) + min(0, -lag)]
        ok = ~(np.isnan(a).any(axis=1) | np.isnan(b).any(axis=1))
        if ok.sum() < 5:
            continue
        num = (a[ok] * b[ok]).sum()
        den = np.linalg.norm(a[ok]) * np.linalg.norm(b[ok]) + 1e-9
        best = max(best, num / den)
    return best


def main():
    data = load_json(OUT / "tracks.json")
    W, Hh, fps = data["width"], data["height"], data["fps"]
    H_map, H_note = load_homography()
    t_end = data["n_frames"] / fps
    t_grid = np.arange(0, t_end, DT)
    T = len(t_grid)

    ball_xy = None
    if data["ball"]:
        ball_xy = sg_smooth(resample(data["ball"]["obs"], H_map, W, Hh, t_grid, fps))

    tracks = {}
    for tr in data["players"]:
        if tr["team"] not in (0, 1):
            continue
        xy = sg_smooth(resample(tr["obs"], H_map, W, Hh, t_grid, fps))
        if (~np.isnan(xy).any(axis=1)).sum() >= 10:
            tracks[tr["tid"]] = (tr["team"], xy)

    # attack direction heuristic: team with centroid on left attacks +x
    cents = {tm: np.nanmean(np.stack([xy for t_, xy in tracks.values() if t_ == tm]), axis=(0, 1))
             for tm in (0, 1)}
    attack = {tm: (1.0 if cents[tm][0] < PITCH_L / 2 else -1.0) for tm in (0, 1)}

    # possession phase with hysteresis (needs ball)
    phase = np.full(T, 2, dtype=int)  # 2 = unknown/dead
    if ball_xy is not None:
        ids = list(tracks.keys())
        stack = np.stack([tracks[i][1] for i in ids])          # (N,T,2)
        d = np.linalg.norm(stack - ball_xy[None], axis=2)      # (N,T)
        d = np.where(np.isnan(d), np.inf, d)
        nearest = d.argmin(axis=0)
        near_ok = d.min(axis=0) < 8.0
        holder_team = np.array([tracks[ids[n]][0] for n in nearest])
        cur = 2
        for t in range(T):
            if near_ok[t]:
                if t + 1 < T and near_ok[min(t + 1, T - 1)] and holder_team[min(t + 1, T - 1)] == holder_team[t]:
                    cur = holder_team[t]
            phase[t] = cur

    vels, goods = {}, {}
    for tid, (team, xy) in tracks.items():
        vels[tid], goods[tid] = kinematics(xy, DT)

    all_tokens = {tid: tokenize(vels[tid], goods[tid], attack[tracks[tid][0]], DT)
                  for tid in tracks}
    codebook = build_codebook(all_tokens)
    fps_ = {tid: fingerprint(all_tokens[tid], codebook) for tid in tracks}
    # TF-IDF across players
    Fm = np.stack([fps_[tid] for tid in tracks]) if codebook else np.zeros((len(tracks), 0))
    if codebook:
        idf = np.log(len(tracks) / (1e-9 + (Fm > Fm.mean(0, keepdims=True)).sum(0)))
        Fm = Fm * np.maximum(idf, 0.1)[None]

    players = []
    tids = list(tracks.keys())
    for ii, tid in enumerate(tids):
        team, xy = tracks[tid]
        vel, good = vels[tid], goods[tid]
        sp = np.linalg.norm(vel, axis=1)
        spv = sp[good]
        # discipline: spread around own mean position relative to team centroid
        tc = np.nanmean(np.stack([t2[1] for t2 in tracks.values() if t2[0] == team]), axis=0)
        rel = xy - tc
        disc = float(np.nanstd(np.linalg.norm(rel - np.nanmean(rel, axis=0), axis=1)))
        ball_aff, aggr = 0.0, 0.0
        if ball_xy is not None:
            db = np.linalg.norm(xy - ball_xy, axis=1)
            ball_aff = float(np.nanmean((db < 10.0)[good])) if good.any() else 0.0
            # closing speed on ball during opponent possession
            opp = phase == (1 - team)
            m = opp & good & ~np.isnan(db)
            if m.sum() > 5:
                closing = np.clip(-np.gradient(np.nan_to_num(db, nan=np.nanmean(db)), DT), 0.0, 9.0)
                aggr = float(closing[m].mean())
        mates = [t2 for t2 in tids if tracks[t2][0] == team and t2 != tid]
        coop = float(np.mean([xcorr_peak(vel, vels[m2], 1.0, DT) for m2 in mates])) if mates else 0.0
        players.append({
            "tid": tid, "team": team,
            "xy": [None if np.isnan(a[0]) else [round(float(a[0]), 2), round(float(a[1]), 2)] for a in xy],
            "anchor": np.round(np.nanmean(xy, axis=0), 2).tolist(),
            "attack_dir": attack[team],
            "style": {
                "pace": round(float(np.quantile(spv, 0.95)) if len(spv) else 0.0, 3),
                "avg_speed": round(float(spv.mean()) if len(spv) else 0.0, 3),
                "stamina": None,   # honest: unidentifiable from ~20s
                "discipline": round(disc, 3),
                "ball_affinity": round(ball_aff, 4),
                "cooperation": round(coop, 3),
                "aggression": round(aggr, 3),
            },
            "tokens": all_tokens[tid],
            "fingerprint": np.round(Fm[ii], 5).tolist() if codebook else [],
            "bigram": np.round(bigram_matrix(all_tokens[tid]), 4).tolist(),
        })

    # motif similarity matrix (cosine on TF-IDF fingerprints)
    sim = None
    if codebook and len(players) > 1:
        Fn = Fm / (np.linalg.norm(Fm, axis=1, keepdims=True) + 1e-12)
        sim = np.round(Fn @ Fn.T, 4).tolist()

    out = {
        "dt": DT, "t_grid": np.round(t_grid, 3).tolist(),
        "pitch": [PITCH_L, PITCH_W], "homography_note": H_note,
        "alphabet": {"size": 33, "bands": BANDS, "still_below": V_STILL, "gap": GAP,
                     "token_window_s": TOKEN_WIN},
        "codebook": codebook,
        "similarity": sim,
        "phase": phase.tolist(),
        "players": players,
        "ball": [None if np.isnan(a[0]) else [round(float(a[0]), 2), round(float(a[1]), 2)] for a in ball_xy] if ball_xy is not None else None,
    }
    save_json(OUT / "features.json", out)
    print(f"[features] {len(players)} players | {T} steps @ {DT}s | codebook={len(codebook)} motifs | {H_note}")
    for p in sorted(players, key=lambda p: (p["team"], p["tid"])):
        s = p["style"]
        nt = sum(1 for t in p["tokens"] if t != GAP)
        print(f"  tid={p['tid']:3d} team={p['team']} pace={s['pace']:4.1f} disc={s['discipline']:4.1f} "
              f"ball={s['ball_affinity']:.2f} coop={s['cooperation']:.2f} aggr={s['aggression']:.2f} toks={nt}")


if __name__ == "__main__":
    main()
