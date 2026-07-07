"""Closed-loop team simulation with evolved parameters + engine applications.

Produces sim.json for the visualization:
  * replay:   observed tracks (ground truth)
  * shadow:   full-team simulation launched from the clip's initial state —
              every player simulated with their evolved SDE params, ball live
  * dream:    long free-running simulation beyond the clip (the engine
              "dreams" the game forward)
  * transfer: which opponent player would best replace the host team's
              weakest-fit player (formation-integrity + occupancy scores)
  * tactics:  CMA-ES counter-strategy search over a 4-dim tactical vector
              against the frozen opponent models (territory + possession)

Usage: python pipeline/06_simulate.py
"""
import importlib
import time

import numpy as np

from common import OUT, load_json, save_json

M = importlib.import_module("04_model")
E = importlib.import_module("05_evolve")

MU_BALL = 0.65      # ball rolling deceleration m/s^2
R_POSS = 1.8
PASS_HAZ, PRESS_HAZ = 0.5, 1.0


def sim_match(phys, rhos, teams, x0, v0, ball0, steps, dt, seed=0,
              beta_scale=None, rho_offset=None, press_gain=None):
    """All-N closed-loop rollout. phys: (N,7). Returns xs (S+1,N,2), ball (S+1,2), events."""
    N = len(phys)
    rng = np.random.default_rng(seed)
    k_home, gamma, k_ball, sigma, v_max = phys[:, 0], phys[:, 1], phys[:, 2], phys[:, 3], phys[:, 4]
    beta = phys[:, 5:7].copy()
    rho = rhos.copy()
    if beta_scale is not None:
        for tm in (0, 1):
            beta[teams == tm] *= beta_scale[tm]
    if rho_offset is not None:
        for tm in (0, 1):
            rho[teams == tm] += rho_offset[tm]
    press = np.ones(N) if press_gain is None else np.where(teams == 0, press_gain[0], press_gain[1])

    x, v = x0.copy(), v0.copy()
    s = np.ones(N)
    ball, ball_v = ball0.copy(), np.zeros(2)
    owner, own_count = -1, 0
    xs = [x.copy()]; bs = [ball.copy()]; events = []
    possession = np.zeros(2)
    for k in range(steps):
        # anchor + forces (vectorized over N)
        h = (1 - beta) * rho + beta * np.clip(ball[None], 0, M.PITCH)[0]
        a = k_home[:, None] * (h - x) - gamma[:, None] * v
        rb = ball[None] - x
        nb = np.linalg.norm(rb, axis=1, keepdims=True) + 1e-9
        # pressing: players on the non-possessing team feel amplified ball pull
        opp_press = np.where((owner >= 0) & (teams != (teams[owner] if owner >= 0 else -1)), press, 1.0)
        a += (k_ball * opp_press)[:, None] * (nb / (nb + M.R0)) * rb / nb
        # designated chasers: each team's nearest player fetches a loose ball
        if owner < 0:
            for tm in (0, 1):
                idx = np.nonzero(teams == tm)[0]
                if len(idx):
                    ch = idx[nb[idx, 0].argmin()]
                    a[ch] += 3.5 * rb[ch] / nb[ch, 0]
        diff = x[:, None] - x[None]                       # (N,N,2)
        dist = np.linalg.norm(diff, axis=2) + 1e-9
        w = np.where((dist < 3 * M.R_SEP) & (dist > 1e-6), np.exp(-dist / M.R_SEP), 0.0)
        np.fill_diagonal(w, 0.0)
        a += M.K_SEP * (w[..., None] * diff / dist[..., None]).sum(axis=1)
        a[:, 0] += M.K_WALL * (np.exp(-x[:, 0] / M.L_WALL) - np.exp(-(M.PITCH[0] - x[:, 0]) / M.L_WALL))
        a[:, 1] += M.K_WALL * (np.exp(-x[:, 1] / M.L_WALL) - np.exp(-(M.PITCH[1] - x[:, 1]) / M.L_WALL))
        an = np.linalg.norm(a, axis=1, keepdims=True)
        a *= np.minimum(1.0, M.A_MAX / (an + 1e-9))
        v = v + a * dt + sigma[:, None] * np.sqrt(dt) * rng.standard_normal((N, 2))
        cap = v_max * np.power(s, M.P_STAM)
        sp = np.linalg.norm(v, axis=1)
        v *= np.minimum(1.0, cap / (sp + 1e-9))[:, None]
        x = np.clip(x + v * dt, 0.0, M.PITCH)
        srel = sp / np.maximum(v_max, 1e-6)
        s = np.clip(s + (-M.C_FAT * srel + M.C_REC * (1 - srel)) * dt, 0.1, 1.0)

        # ball
        d = np.linalg.norm(x - ball[None], axis=1)
        near = int(d.argmin())
        if d[near] < R_POSS:
            own_count = own_count + 1 if near == owner or owner < 0 else 1
            if own_count >= 2 and owner != near:
                if owner >= 0 and teams[owner] != teams[near]:
                    events.append({"k": k, "type": "turnover", "to_team": int(teams[near])})
                owner = near
            if owner == near:
                dirv = v[near] / (np.linalg.norm(v[near]) + 1e-9)
                ball = x[near] + dirv * 0.6
                ball_v = v[near].copy()
                nearest_opp = np.min(d[teams != teams[near]]) if (teams != teams[near]).any() else 99
                haz = PASS_HAZ * (2.0 if nearest_opp < 3.0 else 1.0)
                if rng.random() < 1 - np.exp(-haz * dt):
                    mates = np.nonzero((teams == teams[near]) & (np.arange(N) != near))[0]
                    if len(mates):
                        dm = np.linalg.norm(x[mates] - x[near], axis=1)
                        opp_x = x[teams != teams[near]]
                        openness = np.array([np.min(np.linalg.norm(opp_x - x[m2], axis=1)) for m2 in mates])
                        logit = -dm / 12.0 + openness / 6.0
                        pw = np.exp(logit - logit.max()); pw /= pw.sum()
                        tgt = int(mates[rng.choice(len(mates), p=pw)])
                        dvec = x[tgt] - x[near]
                        dl = np.linalg.norm(dvec) + 1e-9
                        speed = float(np.clip(np.sqrt(2 * MU_BALL * dl) + 3.0, 5.0, 20.0))
                        ball_v = dvec / dl * speed
                        events.append({"k": k, "type": "pass", "from": int(near), "to": tgt})
                        owner, own_count = -1, 0
        else:
            owner, own_count = -1, 0
        if owner < 0:
            spb = np.linalg.norm(ball_v)
            if spb > 0.1:
                ball_v -= ball_v / spb * min(MU_BALL * dt, spb)
            ball = ball + ball_v * dt
            for ax in (0, 1):
                if ball[ax] < 0 or ball[ax] > M.PITCH[ax]:
                    ball[ax] = np.clip(ball[ax], 0, M.PITCH[ax]); ball_v[ax] *= -0.4
        if owner >= 0:
            possession[teams[owner]] += dt
        xs.append(x.copy()); bs.append(ball.copy())
    return np.array(xs), np.array(bs), events, possession


def pairwise_dist_hist(xs, teams, tm, bins=None):
    idx = np.nonzero(teams == tm)[0]
    ds = []
    for t in range(0, len(xs), 5):
        p = xs[t, idx]
        d = np.linalg.norm(p[:, None] - p[None], axis=2)
        ds.append(d[np.triu_indices(len(idx), 1)])
    return np.concatenate(ds) if ds else np.array([0.0])


def main():
    t0_all = time.time()
    feat = load_json(OUT / "features.json")
    evo = load_json(OUT / "evolution.json")
    dt = feat["dt"]
    obs, teams_arr, ball, t_grid = E.build_arrays(feat)
    fitted = {p["tid"]: p for p in evo["players"]}
    tids = [p["tid"] for p in feat["players"]]
    keep = [i for i, tid in enumerate(tids) if tid in fitted]
    obs = obs[:, keep]
    teams = np.array([feat["players"][i]["team"] for i in keep])
    phys = np.array([[fitted[tids[i]]["params"][n] for n in M.PARAM_NAMES] for i in keep])
    rhos = np.array([fitted[tids[i]]["rho"] for i in keep])
    N = len(keep)
    print(f"[sim] {N} fitted players ({np.sum(teams==0)} vs {np.sum(teams==1)})")

    # initial state: first frame where most players visible
    vis = (~np.isnan(obs).any(axis=2)).sum(axis=1)
    t_start = int(np.argmax(vis >= max(3, int(0.8 * N))))
    x0 = np.array([obs[t_start, j] if not np.isnan(obs[t_start, j]).any() else rhos[j] for j in range(N)])
    v0 = np.zeros((N, 2))
    ball0 = ball[t_start] if ball is not None and not np.isnan(ball[t_start]).any() else x0.mean(0)
    T_clip = obs.shape[0] - t_start - 1

    # shadow: same duration as clip, from observed initial state
    sxs, sbs, sev, sposs = sim_match(phys, rhos, teams, x0, v0, ball0, T_clip, dt, seed=3)
    # divergence curve shadow vs observed
    div = []
    for t in range(T_clip + 1):
        ref = obs[t_start + t]
        m = ~np.isnan(ref).any(axis=1)
        div.append(float(np.linalg.norm(sxs[t][m] - ref[m], axis=1).mean()) if m.any() else None)

    # dream: 60 seconds free-running from the observed kickoff state
    dream_steps = int(60.0 / dt)
    dxs, dbs, dev, dposs = sim_match(phys, rhos, teams, x0, v0, ball0,
                                     dream_steps, dt, seed=9)

    # ---- transfer-fit: replace host team's worst-fit player
    host = 0 if np.sum(teams == 0) >= np.sum(teams == 1) else 1
    host_idx = [j for j in range(N) if teams[j] == host]
    away_idx = [j for j in range(N) if teams[j] != host]
    worst = max(host_idx, key=lambda j: fitted[tids[keep[j]]]["final_F"])
    base_hist = pairwise_dist_hist(sxs, teams, host)
    transfer = {"slot_tid": tids[keep[worst]], "host_team": int(host), "candidates": []}
    for cand in away_idx:
        phys2 = phys.copy(); phys2[worst] = phys[cand]
        integ, occ = [], []
        for seed in range(4):
            cxs, cbs, _, _ = sim_match(phys2, rhos, teams, x0, v0, ball0, T_clip, dt, seed=20 + seed)
            integ.append(E.w1(pairwise_dist_hist(cxs, teams, host), base_hist))
            occ.append(E.js_occupancy(cxs[:, host_idx].reshape(-1, 2), sxs[:, host_idx].reshape(-1, 2)))
        transfer["candidates"].append({
            "tid": tids[keep[cand]],
            "formation_disruption": round(float(np.mean(integ)), 3),
            "occupancy_shift": round(float(np.mean(occ)), 4),
            "fit_score": round(float(1.0 / (1.0 + np.mean(integ) + 3 * np.mean(occ))), 4),
        })
    transfer["candidates"].sort(key=lambda c: -c["fit_score"])

    # ---- counter-strategy: evolve host tactical vector vs frozen opponent
    import cma
    away = 1 - host
    attack_sign = 1.0 if np.nanmean(rhos[teams == host][:, 0]) < M.PITCH[0] / 2 else -1.0

    def tactic_fitness(tv):
        line, width, bscale, pgain = tv
        rho2 = rhos.copy()
        rho_off = np.zeros((2, 2))
        rho_off[host] = [attack_sign * line * 15.0, 0.0]
        rho2m = rho2.copy()
        hostm = teams == host
        cy = rho2m[hostm][:, 1].mean()
        rho2m[hostm, 1] = cy + (rho2m[hostm, 1] - cy) * (0.7 + 0.6 * width)
        scores = []
        for seed in range(3):
            txs, tbs, _, tposs = sim_match(phys, rho2m, teams, x0, v0, ball0, T_clip, dt,
                                           seed=50 + seed,
                                           beta_scale=np.where(np.arange(2) == host, 0.5 + bscale, 1.0),
                                           rho_offset=rho_off,
                                           press_gain=np.where(np.arange(2) == host, 0.5 + 2.0 * pgain, 1.0))
            territory = attack_sign * (np.mean(tbs[:, 0]) - M.PITCH[0] / 2) / (M.PITCH[0] / 2)
            poss_share = tposs[host] / max(tposs.sum(), 1e-6)
            scores.append(-(territory + 0.5 * poss_share))
        return float(np.mean(scores))

    es = cma.CMAEvolutionStrategy([0.5] * 4, 0.25, {"bounds": [0.0, 1.0], "popsize": 10, "seed": 5, "verbose": -9})
    tactics_log = []
    for g in range(15):
        sols = es.ask()
        fs = [tactic_fitness(s) for s in sols]
        es.tell(sols, fs)
        b = int(np.argmin(fs))
        tactics_log.append({"g": g, "best": round(-min(fs), 4), "mean": round(-float(np.mean(fs)), 4),
                            "vector": {"line_height": round(float(sols[b][0]), 3),
                                       "width": round(float(sols[b][1]), 3),
                                       "ball_reactivity": round(float(sols[b][2]), 3),
                                       "pressing": round(float(sols[b][3]), 3)}})
        print(f"[tactics] gen {g}: best score {-min(fs):.3f}")

    out = {
        "dt": dt, "t_start": t_start, "pitch": [M.PITCH[0], M.PITCH[1]],
        "tids": [tids[k] for k in keep], "teams": teams.tolist(),
        "params": {tids[keep[j]]: {n: float(phys[j, i]) for i, n in enumerate(M.PARAM_NAMES)} for j in range(N)},
        "rho": np.round(rhos, 2).tolist(),
        "observed": [[None if np.isnan(obs[t, j]).any() else [round(float(obs[t, j, 0]), 2), round(float(obs[t, j, 1]), 2)]
                      for j in range(N)] for t in range(obs.shape[0])],
        "ball_observed": [None if ball is None or np.isnan(ball[t]).any() else [round(float(ball[t, 0]), 2), round(float(ball[t, 1]), 2)]
                          for t in range(obs.shape[0])] if ball is not None else None,
        "shadow": {"start": t_start, "xs": np.round(sxs, 2).tolist(), "ball": np.round(sbs, 2).tolist(),
                   "events": sev, "possession": np.round(sposs, 1).tolist(), "divergence": div},
        "dream": {"xs": np.round(dxs[::2], 2).tolist(), "ball": np.round(dbs[::2], 2).tolist(),
                  "events": dev, "possession": np.round(dposs, 1).tolist(), "dt": dt * 2},
        "transfer": transfer,
        "tactics": tactics_log,
    }
    save_json(OUT / "sim.json", out)
    dv_last = next((d for d in reversed(div) if d is not None), float("nan"))
    print(f"[sim] shadow divergence @end: {dv_last:.1f} m | dream events: {len(dev)} | "
          f"transfer best: tid={transfer['candidates'][0]['tid'] if transfer['candidates'] else '—'} | "
          f"{time.time()-t0_all:.0f}s")


if __name__ == "__main__":
    main()
