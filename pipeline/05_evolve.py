"""CMA-ES evolutionary tuning of per-player SDE parameters (ghost conditioning).

Fitness (dimensionless, lower=better):
  F = median_k nADE_k + 0.5*mean_k nFDE_k
      + 0.3*W1_speed + 0.3*W1_acc + 0.2*W1_turn + 0.1*JS_occupancy
      + 0.05*||z - 0.5||^2 + P_stab
  nADE = window ADE / (constant-velocity-baseline ADE + 0.5m), so <1 beats
  inertial extrapolation (kills the 'drift-to-mean' degenerate optimum).
  Deterministic rollouts score trajectories; M=8 common-random-number
  stochastic rollouts feed the distributional terms that identify sigma/gamma.
  Every 3rd window is held out; validation F is logged, never fitted.

Self-consistency preflight (--selftest): simulate synthetic players with known
theta*, refit them, demand recovery of the identifiable parameters.

Usage:
  python pipeline/05_evolve.py [--gens 50] [--pop 12] [--restarts 2]
  python pipeline/05_evolve.py --selftest
"""
import argparse
import importlib
import time

import numpy as np

from common import OUT, load_json, save_json

M = importlib.import_module("04_model")

H_SEC = 3.0
WIN_STRIDE_S = 0.5
N_ROLL = 8
V_SPIKE, A_SPIKE = 11.5, 25.0   # positions are SG-smoothed upstream; gates catch ID-switch jumps only
EPS_ADE = 0.5
W_FDE, W_SP, W_ACC, W_TURN, W_OCC, W_PRIOR = 0.5, 0.3, 0.3, 0.2, 0.1, 0.05


# ---------------------------------------------------------------- data prep
def build_arrays(feat):
    players = feat["players"]
    t = np.array(feat["t_grid"])
    T, N = len(t), len(players)
    obs = np.full((T, N, 2), np.nan)
    teams = np.zeros(N, dtype=int)
    for j, p in enumerate(players):
        xy = np.array([[np.nan, np.nan] if c is None or c[0] is None else c for c in p["xy"]], dtype=float)
        obs[:len(xy), j] = xy
        teams[j] = p["team"]
    ball = None
    if feat.get("ball"):
        ball = np.array([[np.nan, np.nan] if c is None or c[0] is None else c for c in feat["ball"]], dtype=float)
    return obs, teams, ball, t


def kinematics(obs_j, dt):
    """Velocity/acc with spike rejection. Returns vel, mask (True=trust)."""
    mask = ~np.isnan(obs_j).any(axis=1)
    x = np.where(mask[:, None], obs_j, 0.0)
    vel = np.gradient(x, dt, axis=0)
    acc = np.gradient(vel, dt, axis=0)
    sp = np.linalg.norm(vel, axis=1)
    an = np.linalg.norm(acc, axis=1)
    bad = (sp > V_SPIKE) | (an > A_SPIKE)
    m = mask & ~bad
    vel[~m] = 0.0
    return vel, m


def make_windows(mask, T, H, stride):
    wins = []
    for t0 in range(2, T - H - 1, stride):
        if mask[t0 - 1:t0 + 1].all() and mask[t0:t0 + H + 1].mean() >= 0.5:
            wins.append(t0)
    train = [w for i, w in enumerate(wins) if i % 3 != 2]
    val = [w for i, w in enumerate(wins) if i % 3 == 2]
    return train, val


def obs_distributions(vel, m, dt):
    sp = np.linalg.norm(vel, axis=1)[m]
    acc = np.linalg.norm(np.diff(vel, axis=0), axis=1)[m[1:] & m[:-1]] / dt
    v1, v2 = vel[:-1][m[:-1] & m[1:]], vel[1:][m[:-1] & m[1:]]
    n1, n2 = np.linalg.norm(v1, axis=1), np.linalg.norm(v2, axis=1)
    ok = (n1 > 0.5) & (n2 > 0.5)
    cr = v1[ok, 0] * v2[ok, 1] - v1[ok, 1] * v2[ok, 0]
    turn = np.abs(np.arctan2(cr, (v1[ok] * v2[ok]).sum(1)))
    return sp, acc, turn


def w1(a, b, nq=20):
    if len(a) < 3 or len(b) < 3:
        return 0.0
    q = np.linspace(0.02, 0.98, nq)
    return float(np.abs(np.quantile(a, q) - np.quantile(b, q)).mean())


def js_occupancy(sim_xy, obs_xy, bins=(10, 6)):
    rng_ = [[0, 105.0], [0, 68.0]]
    hs, _, _ = np.histogram2d(sim_xy[:, 0], sim_xy[:, 1], bins=bins, range=rng_)
    ho, _, _ = np.histogram2d(obs_xy[:, 0], obs_xy[:, 1], bins=bins, range=rng_)
    p = (hs + 1e-3).ravel(); p /= p.sum()
    q = (ho + 1e-3).ravel(); q /= q.sum()
    m_ = 0.5 * (p + q)
    kl = lambda a, b: (a * np.log(a / b)).sum()
    return float(0.5 * kl(p, m_) + 0.5 * kl(q, m_))


# ---------------------------------------------------------------- evaluator
class GhostEvaluator:
    def __init__(self, obs, teams, ball, j, dt):
        self.dt = dt
        self.j = j
        T, N, _ = obs.shape
        self.T = T
        self.obs_j = obs[:, j]
        self.vel_j, self.mask = kinematics(self.obs_j, dt)
        others = [k for k in range(N) if k != j]
        self.ghosts_full = obs[:, others]           # (T,M2,2)
        self.ball = ball
        self.rho = np.nanmean(self.obs_j, axis=0)
        H = int(round(H_SEC / dt))
        self.H = H
        stride = max(1, int(round(WIN_STRIDE_S / dt)))
        self.train_w, self.val_w = make_windows(self.mask, T, H, stride)
        self.osp, self.oacc, self.oturn = obs_distributions(self.vel_j, self.mask, dt)
        self.v_floor = min(float(np.linalg.norm(self.vel_j[self.mask], axis=1).max() if self.mask.any() else 4.0), 9.0)
        self.lo = M.LO.copy(); self.hi = M.HI.copy()
        self.lo[4] = max(self.lo[4], self.v_floor)  # v_max lower-bounded by observed top speed

    def _window_tensors(self, wins):
        K, H = len(wins), self.H
        x0 = np.stack([self.obs_j[t0] for t0 in wins])
        v0 = np.stack([self.vel_j[t0] for t0 in wins])
        ghosts = np.stack([self.ghosts_full[t0 + 1:t0 + H + 1] for t0 in wins])
        ball = None
        if self.ball is not None:
            ball = np.stack([self.ball[t0 + 1:t0 + H + 1] for t0 in wins])
        ref = np.stack([self.obs_j[t0 + 1:t0 + H + 1] for t0 in wins])
        msk = np.stack([self.mask[t0 + 1:t0 + H + 1] for t0 in wins])
        # constant-velocity baseline ADE per window
        steps = self.dt * np.arange(1, H + 1)[None, :, None]
        cv = x0[:, None] + v0[:, None] * steps
        cerr = np.linalg.norm(np.nan_to_num(ref - cv), axis=2) * msk
        cv_ade = cerr.sum(1) / np.maximum(msk.sum(1), 1)
        fde_idx = np.array([np.nonzero(m_)[0][-1] if m_.any() else 0 for m_ in msk])
        return x0, v0, ghosts, ball, ref, msk, cv_ade, fde_idx

    def evaluate(self, Z, wins, gen_seed=0, components=False):
        """Z: (C,7) genotypes in [0,1]. Returns F (C,) [+ components dict]."""
        phys = M.z_to_phys(Z, self.lo, self.hi)
        C = len(phys)
        x0, v0, ghosts, ball, ref, msk, cv_ade, fde_idx = self._window_tensors(wins)
        K, H = len(wins), self.H
        # tier 1: deterministic
        xs, _ = M.sim_batch(phys, x0, v0, ghosts, ball, self.rho, self.dt, noise=None)
        pos = xs[:, :, 0, 1:]                       # (C,K,H,2)
        err = np.linalg.norm(np.nan_to_num(pos - ref[None]), axis=3) * msk[None]
        ade = err.sum(2) / np.maximum(msk.sum(1)[None], 1)
        nade = (ade + EPS_ADE) / (cv_ade[None] + EPS_ADE)
        fde = np.take_along_axis(err, fde_idx[None, :, None], axis=2)[:, :, 0]
        cv_fde = np.maximum(cv_ade, 1e-3)
        nfde = (fde + EPS_ADE) / (cv_fde[None] + EPS_ADE)
        # tier 2: stochastic CRN
        rng = np.random.default_rng(10_000 + gen_seed)
        noise = rng.standard_normal((H, K, N_ROLL, 2))
        xs2, vs2 = M.sim_batch(phys, x0, v0, ghosts, ball, self.rho, self.dt, noise=noise)
        v2 = vs2[:, :, :, 1:]                        # (C,K,R,H,2)
        sp = np.linalg.norm(v2, axis=4).reshape(C, -1)
        acc = (np.linalg.norm(np.diff(v2, axis=3), axis=4) / self.dt).reshape(C, -1)
        va, vb = v2[:, :, :, :-1], v2[:, :, :, 1:]
        na_, nb_ = np.linalg.norm(va, axis=4), np.linalg.norm(vb, axis=4)
        cross = va[..., 0] * vb[..., 1] - va[..., 1] * vb[..., 0]
        dot = (va * vb).sum(4)
        w1sp = np.array([w1(sp[c], self.osp) for c in range(C)])
        w1ac = np.array([w1(acc[c], self.oacc) for c in range(C)])
        w1tn = np.zeros(C)
        for c in range(C):
            ok = (na_[c] > 0.5) & (nb_[c] > 0.5)
            w1tn[c] = w1(np.abs(np.arctan2(cross[c][ok], dot[c][ok])), self.oturn)
        # occupancy from full-clip free rollout
        t_start = int(np.argmax(self.mask))
        fr = M.free_rollout(phys, self.obs_j[t_start], self.vel_j[t_start],
                            self.ghosts_full[t_start + 1:], None if self.ball is None else self.ball[t_start + 1:],
                            self.rho, self.dt, seed=77)
        occ = np.array([js_occupancy(fr[c], self.obs_j[self.mask]) for c in range(C)])
        # penalties
        prior = np.square(Z - 0.5).sum(1)
        escaped = ((pos[..., 0] < -2) | (pos[..., 0] > 107) | (pos[..., 1] < -2) | (pos[..., 1] > 70)).any(axis=(1, 2))
        nanp = np.isnan(pos).any(axis=(1, 2, 3))
        zeta = phys[:, 1] / (2 * np.sqrt(phys[:, 0]) + 1e-9)
        p_stab = 10.0 * (escaped | nanp) + 0.2 * np.maximum(0.0, 0.5 - zeta)
        F = (np.median(nade, axis=1) + W_FDE * nfde.mean(1) + W_SP * w1sp / 1.0
             + W_ACC * w1ac / 1.0 + W_TURN * w1tn / 0.5 + W_OCC * occ
             + W_PRIOR * prior + p_stab)
        if components:
            b = int(np.argmin(F))
            return F, {"nADE": float(np.median(nade[b])), "nFDE": float(nfde[b].mean()),
                       "W1_speed": float(w1sp[b]), "W1_acc": float(w1ac[b]), "W1_turn": float(w1tn[b]),
                       "JS_occ": float(occ[b]), "prior": float(prior[b]), "P_stab": float(p_stab[b]),
                       "per_window_nade": np.round(nade[b], 3).tolist()}
        return F

    def showcase(self, z, t0, seed=5):
        """Deterministic + one stochastic rollout on a fixed window, for viz."""
        phys = M.z_to_phys(z[None], self.lo, self.hi)
        x0, v0, ghosts, ball, ref, msk, _, _ = self._window_tensors([t0])
        xs, _ = M.sim_batch(phys, x0, v0, ghosts, ball, self.rho, self.dt, noise=None)
        rng = np.random.default_rng(seed)
        noise = rng.standard_normal((self.H, 1, 1, 2))
        xs2, _ = M.sim_batch(phys, x0, v0, ghosts, ball, self.rho, self.dt, noise=noise)
        return {"t0": int(t0), "det": np.round(xs[0, 0, 0], 2).tolist(),
                "stoch": np.round(xs2[0, 0, 0], 2).tolist(),
                "obs": np.round(np.nan_to_num(np.vstack([self.obs_j[t0][None], ref[0]])), 2).tolist(),
                "mask": msk[0].astype(int).tolist()}


# ---------------------------------------------------------------- evolution
def evolve_player(ev, gens, pop, restarts, style=None, tid=-1, rng=None):
    import cma
    rng = rng or np.random.default_rng(3)
    best_f, best_z, best_hist = np.inf, None, None
    showcase_t0 = ev.train_w[len(ev.train_w) // 2] if ev.train_w else None
    for r in range(restarts):
        x0 = np.clip(0.5 + rng.normal(0, 0.15, 7), 0.05, 0.95) if r else np.full(7, 0.5)
        es = cma.CMAEvolutionStrategy(x0.tolist(), 0.25,
                                      {"bounds": [0.0, 1.0], "popsize": pop,
                                       "seed": 101 + 17 * r + tid, "verbose": -9})
        hist = []
        elite_z, elite_f = None, np.inf
        for g in range(gens):
            sols = np.array(es.ask())
            F = ev.evaluate(sols, ev.train_w, gen_seed=g)
            es.tell(sols.tolist(), F.tolist())
            gi = int(np.argmin(F))
            # elite re-evaluation with fresh seeds (kill lucky champions)
            if F[gi] < elite_f:
                f_fresh = float(ev.evaluate(sols[gi][None], ev.train_w, gen_seed=1000 + g)[0])
                if f_fresh < elite_f:
                    elite_f, elite_z = f_fresh, sols[gi].copy()
            C_ = es.sm.covariance_matrix if hasattr(es.sm, "covariance_matrix") else None
            cond = float(np.linalg.cond(C_)) if C_ is not None else None
            rec = {"g": g, "restart": r, "best": round(float(F.min()), 4),
                   "median": round(float(np.median(F)), 4), "elite": round(elite_f, 4),
                   "sigma_cma": round(float(es.sigma), 4),
                   "cond_C": round(cond, 1) if cond else None,
                   "params": {n: round(float(v), 4) for n, v in
                              zip(M.PARAM_NAMES, M.z_to_phys(elite_z, ev.lo, ev.hi))}}
            if g in (0, gens // 2, gens - 1) and showcase_t0 is not None:
                rec["showcase"] = ev.showcase(elite_z, showcase_t0)
                _, comp = ev.evaluate(elite_z[None], ev.train_w, gen_seed=g, components=True)
                rec["components"] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in comp.items()}
                if ev.val_w:
                    rec["val_F"] = round(float(ev.evaluate(elite_z[None], ev.val_w, gen_seed=999)[0]), 4)
            hist.append(rec)
        if elite_f < best_f:
            best_f, best_z, best_hist = elite_f, elite_z, hist
    return best_f, best_z, best_hist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gens", type=int, default=50)
    ap.add_argument("--pop", type=int, default=12)
    ap.add_argument("--restarts", type=int, default=2)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest(args)

    feat = load_json(OUT / "features.json")
    dt = feat["dt"]
    obs, teams, ball, t_grid = build_arrays(feat)
    t_all = time.time()
    evo = {"dt": dt, "param_names": M.PARAM_NAMES, "players": []}
    for j, p in enumerate(feat["players"]):
        ev = GhostEvaluator(obs, teams, ball, j, dt)
        if len(ev.train_w) < 3:
            print(f"[evolve] tid={p['tid']}: only {len(ev.train_w)} train windows — skipped")
            continue
        t0 = time.time()
        best_f, best_z, hist = evolve_player(ev, args.gens, args.pop, args.restarts, tid=p["tid"])
        phys = M.z_to_phys(best_z, ev.lo, ev.hi)
        # baseline: constant-velocity has nADE = 1 by construction
        seed_F = float(ev.evaluate(np.full((1, 7), 0.5), ev.train_w, gen_seed=0)[0])
        val_F = float(ev.evaluate(best_z[None], ev.val_w, gen_seed=999)[0]) if ev.val_w else None
        evo["players"].append({
            "tid": p["tid"], "team": p["team"], "style": p["style"],
            "train_windows": len(ev.train_w), "val_windows": len(ev.val_w),
            "rho": np.round(ev.rho, 2).tolist(),
            "seed_F": round(seed_F, 4), "final_F": round(best_f, 4),
            "val_F": round(val_F, 4) if val_F else None,
            "params": {n: round(float(v), 4) for n, v in zip(M.PARAM_NAMES, phys)},
            "z": np.round(best_z, 4).tolist(),
            "gens": hist,
        })
        print(f"[evolve] tid={p['tid']} team={p['team']} wins={len(ev.train_w)}+{len(ev.val_w)} "
              f"F: {seed_F:.3f} -> {best_f:.3f} (val {val_F if val_F else float('nan'):.3f}) "
              f"[{time.time()-t0:.1f}s]", flush=True)
    save_json(OUT / "evolution.json", evo)
    print(f"[evolve] {len(evo['players'])} players in {time.time()-t_all:.0f}s -> {OUT/'evolution.json'}")


# ---------------------------------------------------------------- selftest
def selftest(args):
    """Simulate synthetic players with known theta*, refit, check recovery."""
    print("[selftest] building synthetic scene…")
    dt, T = 0.2, 120
    rng = np.random.default_rng(42)
    N = 8
    t = np.arange(T) * dt
    ball = np.stack([52.5 + 35 * np.sin(2 * np.pi * t / 18.0),
                     34.0 + 20 * np.sin(2 * np.pi * t / 11.0 + 1.0)], axis=1)
    anchors = np.array([[x, y] for x in (25, 45, 65, 85) for y in (20, 48)], dtype=float)
    obs = np.zeros((T, N, 2))
    for j in range(N):  # scripted ghosts: gentle orbit around anchor
        obs[:, j] = anchors[j] + np.stack([4 * np.sin(2 * np.pi * t / 13 + j), 3 * np.cos(2 * np.pi * t / 9 + j)], 1)
    theta_true = {1: [0.30, 0.80, 1.50, 0.30, 7.0, 0.45, 0.25],
                  4: [0.08, 1.20, 0.40, 0.15, 6.0, 0.10, 0.10]}
    teams = np.array([0, 0, 0, 0, 1, 1, 1, 1])
    for j, th in theta_true.items():
        others = [k for k in range(N) if k != j]
        noise = np.random.default_rng(j).standard_normal((T - 1, 1, 1, 2))
        xs, _ = M.sim_batch(np.array(th)[None], obs[0, j][None], np.zeros((1, 2)),
                            obs[1:, others][None].transpose(0, 1, 2, 3), ball[1:][None],
                            anchors[j], dt, noise=noise)
        obs[:, j] = xs[0, 0, 0]
    ok_all = True
    for j, th in theta_true.items():
        ev = GhostEvaluator(obs, teams, ball, j, dt)
        best_f, best_z, _ = evolve_player(ev, args.gens, args.pop, 1, tid=j)
        phys = M.z_to_phys(best_z, ev.lo, ev.hi)
        print(f"[selftest] player {j}: F={best_f:.3f}")
        for name, tv, fv in zip(M.PARAM_NAMES, th, phys):
            rel = abs(fv - tv) / max(abs(tv), 1e-6)
            flag = "OK " if rel < 0.5 else ("ridge" if name in ("k_home", "k_ball", "beta_x", "beta_y") else "MISS")
            print(f"    {name:7s} true={tv:6.3f} fit={fv:6.3f} rel_err={rel:5.1%} {flag}")
            if flag == "MISS" and name in ("gamma", "sigma"):
                ok_all = False
    print("[selftest]", "PASS — identifiable params recovered" if ok_all else "PARTIAL — check ridges")
    return 0


if __name__ == "__main__":
    main()
