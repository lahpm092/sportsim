"""Probabilistic player model: social-force SDE, 7 fitted params per player.

  theta_i = [k_home, gamma, k_ball, sigma, v_max, beta_x, beta_y]

Dynamic home anchor (ball-coupled, per axis):
  h_i(t) = (1 - beta) * rho_i + beta * ball(t)         rho_i = mean observed pos
Drift (m/s^2), capped at A_MAX:
  a = k_home*(h - x) - gamma*v + k_ball * g(|r_b|) * r_hat_b
      - K_SEP * sum_{|r_ij|<3R_SEP} exp(-|r_ij|/R_SEP) * r_hat_ij + walls
  g(r) = r/(r + R0)  (saturating ball pull)
SDE, semi-implicit Euler-Maruyama (update v, cap by stamina, then x):
  v += a dt + sigma sqrt(dt) xi ;  |v| <= v_max * s^P_STAM ;  x += v dt
  ds = (-C_FAT*|v|/v_max + C_REC*(1-|v|/v_max)) dt   (frozen; negligible on 10 s)

Cohesion force deliberately ABSENT: collinear with the dynamic anchor
(non-identifiability ridge). Separation/walls/stamina frozen globally.

Vectorization: candidates C x windows K x rollouts M simulated as one
(C,K,M,2) state tensor; ghosts (other players + ball) replay recorded tracks.
"""
import numpy as np

PARAM_NAMES = ["k_home", "gamma", "k_ball", "sigma", "v_max", "beta_x", "beta_y"]
LOG_SCALE = np.array([True, True, True, True, False, False, False])
LO = np.array([0.01, 0.30, 0.05, 0.05, 4.0, 0.0, 0.0])   # v_max lower bound raised per player
HI = np.array([1.00, 2.00, 5.00, 1.50, 9.5, 0.8, 0.8])

K_SEP, R_SEP = 2.0, 2.0
K_WALL, L_WALL = 5.0, 1.0
A_MAX = 6.0
R0 = 5.0
P_STAM, C_FAT, C_REC = 0.5, 0.006, 0.002
PITCH = np.array([105.0, 68.0])


def z_to_phys(z, lo=None, hi=None):
    """Unit-cube genotype (C,7) -> physical params. Log map for scale params."""
    lo = LO if lo is None else lo
    hi = HI if hi is None else hi
    z = np.clip(np.asarray(z, dtype=np.float64), 0.0, 1.0)
    lo_safe = np.maximum(lo, 1e-9)
    p = np.where(LOG_SCALE, lo_safe * np.exp(z * np.log(np.maximum(hi / lo_safe, 1e-9))),
                 lo + z * (hi - lo))
    return p


def phys_to_z(p, lo=None, hi=None):
    lo = LO if lo is None else lo
    hi = HI if hi is None else hi
    p = np.clip(np.asarray(p, dtype=np.float64), lo, hi)
    return np.where(LOG_SCALE, np.log(p / lo) / np.log(np.maximum(hi / lo, 1e-9)),
                    (p - lo) / np.maximum(hi - lo, 1e-9))


def sim_batch(phys, x0, v0, ghosts, ball, rho, dt, noise=None):
    """Simulate a batch of independent copies of ONE player.

    phys:   (C,7) physical params
    x0,v0:  (K,2) initial state per window
    ghosts: (K,S,M2,2) other-player recorded positions per window step (nan ok)
    ball:   (K,S,2) or None
    rho:    (2,) static home base
    noise:  (S,K,R,2) pre-drawn N(0,1) (common random numbers) or None for
            deterministic; R rollouts per (candidate,window).
    Returns xs: (C,K,R,S+1,2) positions, vs: same for velocities.
    """
    C = phys.shape[0]
    K, S = ghosts.shape[0], ghosts.shape[1]
    R = 1 if noise is None else noise.shape[2]
    k_home, gamma, k_ball, sigma, v_max, bx, by = [phys[:, i].reshape(C, 1, 1) for i in range(7)]
    beta = np.stack([phys[:, 5], phys[:, 6]], axis=1).reshape(C, 1, 1, 2)

    x = np.broadcast_to(x0.reshape(1, K, 1, 2), (C, K, R, 2)).copy()
    v = np.broadcast_to(v0.reshape(1, K, 1, 2), (C, K, R, 2)).copy()
    s = np.ones((C, K, R))
    xs = np.empty((C, K, R, S + 1, 2)); vs = np.empty_like(xs)
    xs[..., 0, :] = x; vs[..., 0, :] = v

    for t in range(S):
        g = ghosts[:, t]                                   # (K,M2,2)
        b = ball[:, t] if ball is not None else None       # (K,2)
        # dynamic anchor
        if b is not None:
            bsafe = np.where(np.isnan(b), rho[None], b)     # (K,2)
            h = (1 - beta) * rho.reshape(1, 1, 1, 2) + beta * bsafe.reshape(1, K, 1, 2)
        else:
            h = np.broadcast_to(rho.reshape(1, 1, 1, 2), (C, K, R, 2))
        a = k_home[..., None] * (h - x) - gamma[..., None] * v
        if b is not None:
            rb = bsafe.reshape(1, K, 1, 2) - x
            nb = np.linalg.norm(rb, axis=-1, keepdims=True) + 1e-9
            a = a + k_ball[..., None] * (nb / (nb + R0)) * (rb / nb) * (~np.isnan(b).any(axis=-1)).reshape(1, K, 1, 1)
        # separation from ghosts
        gg = np.nan_to_num(g, nan=1e6)                      # far away if missing
        diff = x[:, :, :, None, :] - gg.reshape(1, K, 1, -1, 2)  # (C,K,R,M2,2)
        dist = np.linalg.norm(diff, axis=-1)
        w = np.where(dist < 3 * R_SEP, np.exp(-dist / R_SEP), 0.0)
        a = a + K_SEP * (w[..., None] * diff / (dist[..., None] + 1e-9)).sum(axis=3)
        # walls
        a[..., 0] += K_WALL * (np.exp(-x[..., 0] / L_WALL) - np.exp(-(PITCH[0] - x[..., 0]) / L_WALL))
        a[..., 1] += K_WALL * (np.exp(-x[..., 1] / L_WALL) - np.exp(-(PITCH[1] - x[..., 1]) / L_WALL))
        # drift cap
        an = np.linalg.norm(a, axis=-1, keepdims=True)
        a = a * np.minimum(1.0, A_MAX / (an + 1e-9))
        # semi-implicit step
        if noise is not None:
            v = v + a * dt + sigma[..., None] * np.sqrt(dt) * noise[t].reshape(1, K, R, 2)
        else:
            v = v + a * dt
        cap = v_max * np.power(s, P_STAM)
        sp = np.linalg.norm(v, axis=-1)
        f = np.minimum(1.0, cap / (sp + 1e-9))
        v = v * f[..., None]
        x = x + v * dt
        # reflect at pitch bounds (+2m margin handled by penalty upstream)
        x = np.clip(x, -2.0, None)
        x = np.minimum(x, PITCH[None, None, None] + 2.0)
        srel = sp / np.maximum(v_max, 1e-6)
        s = np.clip(s + (-C_FAT * srel + C_REC * (1 - srel)) * dt, 0.1, 1.0)
        xs[..., t + 1, :] = x; vs[..., t + 1, :] = v
    return xs, vs


def free_rollout(phys, x0, v0, ghosts_full, ball_full, rho, dt, seed=0):
    """One full-clip rollout (no re-anchoring) per candidate. Returns (C,T+1,2)."""
    T = ghosts_full.shape[0]
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal((T, 1, 1, 2))
    xs, _ = sim_batch(phys, x0[None], v0[None],
                      ghosts_full[None], None if ball_full is None else ball_full[None],
                      rho, dt, noise=noise)
    return xs[:, 0, 0]  # (C,T+1,2)
