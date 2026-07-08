"""Probabilistic transition model v2 — the ball as a token on a stochastic graph,
now under the laws of the game.

States {player i carries, in flight, loose, DEAD(restart), goal}; one carrier
decision per tick. Every transition is conditioned on the ANGLE and DISTANCE
the ball travels — each player is an 11-dim vector of conditional probability
distributions (genotype z in [0,1]^11, phys = lo + z*(hi-lo)):
  send    p_cmp = sig(P_CMP_BASE + acc_i - d/range_i - .55*press - 1.1*lane
                      + .45*ctl_m - P_CMP_FWD*max(0,cos ang)*d/20)
          ang = pass direction vs attack direction (recorded per event, r3)
  execute a failed send leaves the foot on an ERROR CONE:
          theta' = theta + N(0, sigma_th^2), sigma_th = STRAY_TH*(.5 + d/40)
          d' = d*(1 + STRAY_OVER + N(0, STRAY_POW^2))   (systematic overhit)
  receive p_ctl = sig(2.1 + ctl_m - .75*press_m - CTL_LONG*(d-18)+/10)
  steal   lane interceptor p_int = min(.9, P_INT_BASE + .5*lane*sig(icpt_j));
          a missed bite deflects w.p. DEFL_P*lane (defender becomes last touch)
  shoot   xg = sig(XG_BASE - .095*d + 2.2*ang_posts); p_goal = sig(logit xg + fin);
          misses split post (P_POST) / save (SAVE_P) / off; placement [dy,dz]
          sampled in the goal mouth and recorded for the physics layer
Laws of the game (v2): a ball over the line is DEAD; the next tick is a restart
event by the right team at the right spot —
  throw-in  (touchline; opponents of last touch; taker = nearest; short+safe)
  corner    (goal line, DEFENDER last touch — deflections & parried saves)
  goal kick (goal line, attacker last touch; off-target shots; keeper takes,
             long range multiplier)
  kickoff   (after goals; positions reset to anchors)
Dead-ball ceremony: taker snaps to the spot, opponents retreat (PUSH_KICK /
PUSH_THROW), corner set pieces crowd the box (CORNER_ATK/DEF marks, pull
RESTART_PULL). Keeper duty: the slot-0 sweeper guards the mouth when the ball
is within GK_ENGAGE of his goal, claims balls through the mouth, holds saves
(PARRY_P parried out -> corner). Post hits rebound into play (scramble) or die
behind (POST_OUT -> goal kick).

Policy (softmax over utilities, tau_i = 1/(.5 + 1.5*vision_i)):
  U_pass(m) = .10*min(open_m,15) + .045*risk_i*fwd_m - PASS_DIST_COST*d - LANE_AVOID*lane
  U_carry   = U_CARRY_BASE + 1.1*carry_bias_i + .05*min(space,15) - .45*press_i
  U_shoot   = U_SHOOT_BASE + 2.6*shoot_bias_i + 3.5*xg   (only if d_goal < SHOT_MAX_D)
Carry: substeps of CARRY_STEP along .7*(goal-pos) + .3*(pos-nearest_opp);
contest within 5 m: p_keep = sig(1.7 + drb_i - tkl_j - .35*press_local),
uncontested p_keep = .995; stop w.p. CARRY_RECIDE per surviving substep.
press_i = sum_{j in opp} exp(-d_ij / R_PRESS).

theta* = slot archetype + N(0,.06) jitter, clipped [.05,.95], sealed in the
output for the recovered-vs-true reveal. Two train games (seeds 1001/1002) keep
full event streams; six val games (2001..2006) keep pooled stats + scores only;
noise floor = loss(trainStats, valStats).
DETERMINISM CONTRACT: the canonical stats are extracted from the SERIALIZED
event dicts (post-rounding round-trip), so any consumer re-extracting from the
stored streams reproduces them exactly (integer counts equal, floats to 1e-12).

Extraction conventions (v2): restart events count at TEAM level only (rst
counts, cmp, out) — player families measure open play. pass_dir = 3-bin |ang|
histogram {fwd < pi/4, lateral, back > 3pi/4}; pass_fwd derives forwardness
from d*cos(ang) > 2 (serialized fields only). Interception opportunities =
failed non-restart passes with a lane defender ({intercepted, out, loose,
deflected, deflected_out, keeper}); contests log won01 = 1 when the DEFENDER
wins; lane == 0 => jlane null => no interception roll.

v2 tuning (node harness /scratchpad + this file's --selftest; §9 adjusted):
  P_CMP_BASE .45 / P_CMP_FWD .28 / CTL_LONG .5 — angle+distance conditioning
  recentered so open-play completion lands in [.68,.85] WITHOUT saturating the
  acc/range/press signal (a higher base compresses genotype separation).
  XG_BASE -1.95 (goals cap with the keeper on duty), U_SHOOT_BASE -1.3,
  GK_ENGAGE 24 (a wider engage radius empties the defensive third and shot
  volume explodes), P_POST .06, PARRY_P .40 (corner supply).
  Separation levers (uniform-genome ratio >= 4): skill-scaled error cone
  (STRAY_SK0/SK1 — where misses land reads pass_acc through outs), U_PASS_RISK
  .045 -> .06 (risk reads through the fwd/dir mix), TEAM_MULT .10 -> .20 (team
  families measured 6.4x uniform/floor, the strongest of all), FAMILY_W
  re-balanced to measured per-family ratios (pass_fwd .26, ctl_fail .12,
  pass_cmp .16 — its 2-game floor is large; intercept .02 — pure noise).
  TEAM_NORM.ppp 2.5 -> 6: dead-ball restarts split possession runs; 2-game ppp
  sampling sd now rivals its signal. Shots cap 26 -> 32 (rebound scrambles and
  corner sequences add attempts; conversion is unchanged). uniform_ratio =
  mean of 3 independent 2-game evals (single pairs swing ~2x around the mean).

Usage:
  python pipeline/08_transitions.py             # -> out/transition_data.json (+ viz/assets copy)
  python pipeline/08_transitions.py --selftest  # determinism + §9 sanity + noise floor + 4x
"""
import argparse
import json
import math
import shutil
import time

import numpy as np

from common import OUT, PITCH_L, PITCH_W, VIZ_ASSETS, load_json, save_json

# ---------------------------------------------------------------- constants
TICK = 2.0            # s per tick (viz pacing only)
T_TICKS = 840
R_PRESS = 3.4
PRESS_HI = 0.55       # pressure bin threshold
CARRY_STEP = 3.2      # m per carry substep
MAX_CARRY_SUB = 6
CARRY_RECIDE = 0.45   # stop prob per surviving substep
SHOT_MAX_D = 25.0
U_CARRY_BASE = -1.08   # v1 -1.05: v2 carry volume rides the §9 cap
P_INT_BASE = 0.17
LANE_AVOID = 1.55
XG_BASE = -1.95       # v1 -1.8: keeper duty + placement misses run goals hot otherwise
PASS_DIST_COST = 0.041
U_SHOOT_BASE = -1.3   # v1 -0.8: rebound/corner sequences already add attempts
SAVE_P = 0.42

# v2 execution model — angle/distance conditioning
P_CMP_BASE = 0.45     # completion recentering vs the v2 penalties (see docstring)
P_CMP_FWD = 0.28      # forward-pass difficulty x d/20
CTL_LONG = 0.5        # reception penalty per (d-18)+/10
STRAY_TH = 0.20       # angular execution sigma (rad) at scale (.5 + d/40)
STRAY_SK0 = 1.7       # cone x (SK0 - SK1*acc): bad passers spray wider
STRAY_SK1 = 0.3
STRAY_POW = 0.22      # power error sigma (fraction of d)
STRAY_OVER = 0.12     # systematic overhit bias
DEFL_P = 0.30         # failed-bite deflection prob x lane
DEFL_SCATTER = 3.0    # deflection scatter (m)

# v2 shot placement + aftermath
P_POST = 0.06         # of non-goal shots: woodwork
PARRY_P = 0.40        # of saves: parried out -> corner
POST_OUT = 0.30       # of post hits: rebound dead -> goal kick

# v2 restarts
THROW_MAX = 22.0      # throw-in candidate radius
THROW_BONUS = 1.2     # throw-in accuracy bonus
KICK_RANGE = 1.5      # goal-kick range multiplier
KO_BONUS = 2.0        # kickoff accuracy bonus
CORNER_BOX = 0.05     # corner delivery bonus per meter inside 25 of goal
PUSH_KICK = 9.15      # opponent retreat radius at kicks
PUSH_THROW = 2.0      # opponent retreat radius at throws
RESTART_PULL = 0.85   # anchor pull during kick restarts

# v2 keeper duty (slot-0 sweeper)
GK_ENGAGE = 24.0
GK_DEPTH = 3.0
GK_WIDE = 7.0

U_PASS_RISK = 0.06    # v1 .045: risk -> forward-pass appetite (separation signal)
TEAM_MULT = 0.20      # §7 team-term multiplier (v1 .10): team families carry
                      # the strongest uniform-genome separation in v2

GOAL_Y = (30.34, 37.66)
GOAL_CY = 34.0
GOAL_HW = 3.66
GOAL_H = 2.44
PASS_D_BINS = (12.0, 25.0)
CARRY_BINS = (3.5, 8.0, 15.0)
ANG_BINS = (math.pi / 4, 3 * math.pi / 4)
COS45 = math.sqrt(0.5)

DIM_NAMES = ["pass_acc", "pass_range", "vision", "risk", "dribble", "carry_bias",
             "finish", "shoot_bias", "tackle", "intercept", "control"]
LO = np.array([1.0, 10.0, 0.0, 0.0, -1.5, 0.0, -1.0, 0.0, -1.5, -1.5, -1.5])
HI = np.array([3.5, 34.0, 1.0, 1.0, 1.5, 1.0, 2.0, 1.0, 1.5, 1.5, 1.5])

SLOT_ARCH = ["sweeper", "back", "back2", "playmaker", "runner", "striker"]
SLOT_XY = [(18.0, 34.0), (30.0, 17.0), (30.0, 51.0), (48.0, 34.0), (62.0, 12.0), (72.0, 40.0)]
ARCH = {
    "sweeper":   [.72, .62, .55, .20, .30, .25, .25, .10, .85, .85, .60],
    "back":      [.62, .55, .45, .30, .35, .30, .30, .12, .72, .65, .62],
    "back2":     [.60, .52, .45, .32, .38, .32, .30, .12, .70, .62, .60],
    "playmaker": [.88, .80, .90, .55, .50, .35, .40, .18, .42, .55, .85],
    "runner":    [.58, .45, .50, .80, .88, .85, .50, .35, .35, .40, .62],
    "striker":   [.55, .42, .55, .65, .68, .55, .90, .85, .25, .30, .70],
}
ROSTER = {0: [0, 2, 5, 7, 9, 16], 1: [14, 12, 13, 3, 1, 10]}
THETA_SEED = 99
TRAIN_SEEDS = (1001, 1002)
VAL_SEEDS = tuple(range(2001, 2007))

# Corner set pieces: (meters from the attacked goal line, pitch y)
CORNER_ATK = [(16.0, 34.0), (9.0, 30.5), (11.0, 37.5)]                    # slot 3,4,5
CORNER_DEF = [(7.5, 31.0), (9.5, 34.0), (7.5, 37.0), (13.0, 34.0), (6.0, 34.0)]  # slot 1..5

# §7 family weights, v2 re-balance. Weight follows measured uniform/floor
# separation per family (77-draw: team 6.4x, ctl_fail 4.3x, pass_fwd 4.0x,
# shot_conv 13x tiny; pass_cmp 1.8x with a big sampling floor; intercept 0.7x
# = pure noise at ~3 opportunities/player/game).
FAMILY_W = {"pass_cmp": .16,
            "carry_len": .04,
            "carry_keep": .04,
            "shot_conv": .06,
            "shot_rate": .06,
            "carry_rate": .10,
            "pass_fwd": .26,
            "pass_dir": .08,
            "intercept": .02,
            "tackle": .04,
            "ctl_fail": .12}
TEAM_NORM = {"share": 1.0, "ppp": 6.0, "out100": 100.0, "gpg": 200.0, "spg": 600.0}

SANITY = {  # §9 targets (v2), avg over the 2 train games
    "pass_completion": (0.68, 0.85),
    "passes_per_game": (350, 650),
    "goals_per_game": (1.5, 6),
    "shots_per_game": (8, 32),
    "outs_per_game": (6, 30),
    "carries_per_game": (80, 260),
    "carry_dispossession": (0.12, 0.38),
    "interceptions_per_game": (8, 40),
    "mean_carry_len": (3, 9),
    "throw_ins_per_game": (4, 22),
    "goal_kicks_per_game": (3, 16),
    "corners_per_game": (0.5, 9),
}


def _sig(x):
    if x < -60:
        return 0.0
    if x > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def _r2(v):
    return round(float(v), 2)


def _r3(v):
    return round(float(v), 3)


def _wrap_pi(a):
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


# ---------------------------------------------------------------- roster
def build_players(evo=None):
    """Roster -> formation slots, ordered by rho[0]*attack_dir ascending (§1)."""
    evo = evo or load_json(OUT / "evolution.json")
    rho = {p["tid"]: p["rho"] for p in evo["players"]}
    players = []
    for team in (0, 1):
        d = 1.0 if team == 0 else -1.0
        tids = sorted(ROSTER[team], key=lambda t: rho[t][0] * d)
        for slot, t in enumerate(tids):
            x, y = SLOT_XY[slot]
            players.append({"tid": int(t), "team": team, "slot": slot,
                            "anchor": [float(x) if team == 0 else float(PITCH_L - x), float(y)],
                            "archetype": SLOT_ARCH[slot]})
    return players


def make_theta(players, seed=THETA_SEED):
    """theta* genotypes: archetype mean + N(0,.06) jitter, clip [.05,.95], 4 dp."""
    rng = np.random.default_rng(seed)
    Z = np.zeros((len(players), 11))
    for i, p in enumerate(players):
        Z[i] = np.clip(np.array(ARCH[p["archetype"]]) + rng.normal(0, 0.06, 11), 0.05, 0.95)
    return np.round(Z, 4)


def z_to_phys(Z):
    return LO + np.asarray(Z, float) * (HI - LO)


def _post_angle(p, gx):
    a = abs(math.atan2(GOAL_Y[0] - p[1], gx - p[0]) - math.atan2(GOAL_Y[1] - p[1], gx - p[0]))
    return min(a, 2 * math.pi - a)


# ---------------------------------------------------------------- engine
def simulate_game(Z, players, seed, T=T_TICKS):
    """One game under the laws: T ticks, one event each (incl. restart ticks).

    Z: (12,11) genotypes in players-array order. Returns
    {seed, score, possession, events} with event floats pre-rounded (§5).
    Mirrors viz/lab-engine.js playGame() — same model, same constants.
    """
    rng = np.random.default_rng(seed)
    phys = z_to_phys(Z)
    acc, prange, vis, risk, drb, cbias, fin, sbias, tkl, icpt, ctl = phys.T
    tau = 1.0 / (0.5 + 1.5 * vis)
    team = np.array([p["team"] for p in players])
    slot = np.array([p["slot"] for p in players])
    tid = [int(p["tid"]) for p in players]
    A = np.array([p["anchor"] for p in players], float)
    idx_t = [np.where(team == t)[0] for t in (0, 1)]
    pm = [next(i for i, p in enumerate(players) if p["team"] == t and p["slot"] == 3)
          for t in (0, 1)]
    sw = [next(i for i, p in enumerate(players) if p["team"] == t and p["slot"] == 0)
          for t in (0, 1)]
    gx_of = lambda t: PITCH_L if t == 0 else 0.0      # goal team t attacks
    own_gx = lambda t: 0.0 if t == 0 else PITCH_L     # goal team t defends

    P = A.copy()
    car = pm[0]                       # kickoff: team 0 playmaker
    pending = None                    # {"rtype","team","spot","taker","exit"}
    score, poss, events = [0, 0], [0, 0], []

    def press_at(x, y, t):
        opp = idx_t[1 - t]
        return float(np.exp(-np.linalg.norm(P[opp] - (x, y), axis=1) / R_PRESS).sum())

    def loose_winner(x, y):
        return int(np.argmin(np.linalg.norm(P - (x, y), axis=1) + rng.normal(0, 1.5, len(P))))

    def nearest_of(lst, x, y):
        lst = np.asarray(lst)
        return int(lst[np.argmin(np.linalg.norm(P[lst] - (x, y), axis=1))])

    def seg_exit(x0, y0, x1, y1):
        t = 1.0
        dx, dy = x1 - x0, y1 - y0
        if x1 < 0 and dx < 0:
            t = min(t, (0 - x0) / dx)
        if x1 > PITCH_L and dx > 0:
            t = min(t, (PITCH_L - x0) / dx)
        if y1 < 0 and dy < 0:
            t = min(t, (0 - y0) / dy)
        if y1 > PITCH_W and dy > 0:
            t = min(t, (PITCH_W - y0) / dy)
        return x0 + dx * t, y0 + dy * t

    def award(last_t, ex, ey):
        """The laws: who restarts, what kind, from where."""
        eps = 1e-6
        if ex <= eps or ex >= PITCH_L - eps:          # over a goal line
            def_t = 0 if ex <= eps else 1             # team 0 defends x=0
            if last_t == def_t:                       # defender last touch -> corner
                rtype, rteam = "corner", 1 - def_t
                spot = [0.0 if ex <= eps else PITCH_L, 0.0 if ey <= GOAL_CY else PITCH_W]
            else:                                     # attacker last touch -> goal kick
                rtype, rteam = "goal_kick", def_t
                spot = [5.5 if def_t == 0 else PITCH_L - 5.5,
                        GOAL_CY - 9.16 if ey <= GOAL_CY else GOAL_CY + 9.16]
        else:                                         # over a touchline -> throw-in
            rtype, rteam = "throw_in", 1 - last_t
            spot = [min(max(ex, 0.3), PITCH_L - 0.3), 0.0 if ey <= GOAL_CY else PITCH_W]
        taker = sw[rteam] if rtype == "goal_kick" else nearest_of(idx_t[rteam], spot[0], spot[1])
        return {"rtype": rtype, "team": rteam, "spot": spot, "taker": taker,
                "exit": [_r2(ex), _r2(ey)]}

    def lane_of(i, m):
        sx, sy = P[i]
        dx, dy = P[m] - P[i]
        L2 = max(dx * dx + dy * dy, 1e-9)
        best, jl = 0.0, -1
        for j in idx_t[1 - team[i]]:
            s = ((P[j, 0] - sx) * dx + (P[j, 1] - sy) * dy) / L2
            if 0.08 <= s <= 0.92:
                perp = abs((P[j, 0] - sx) * dy - (P[j, 1] - sy) * dx) / math.sqrt(L2)
                lj = math.exp(-perp / 2.5)
                if lj > best:
                    best, jl = lj, int(j)
        return best, jl

    def resolve_pass(k, i, m, restart=None, bonus=0.0, range_mult=1.0):
        """Shared pass resolution — open play and restarts. Mutates car/pending/P."""
        nonlocal car, pending
        atk = int(team[i])
        d_a = 1.0 if atk == 0 else -1.0
        p0 = P[i].copy()
        q = P[m].copy()
        d = max(float(np.linalg.norm(q - p0)), 1e-9)
        press_c = press_at(p0[0], p0[1], atk)
        ln, jl = lane_of(i, m)
        ang = _wrap_pi(math.atan2(q[1] - p0[1], q[0] - p0[0]) - (0.0 if d_a > 0 else math.pi))
        fwdness = max(0.0, math.cos(ang))
        ev = {"k": k, "type": "pass", "tid": tid[i], "x": _r2(p0[0]), "y": _r2(p0[1]),
              "tgt": tid[m], "d": _r2(d), "ang": _r3(ang), "press": _r3(press_c),
              "lane": _r3(ln), "jlane": tid[jl] if jl >= 0 else None, "outcome": ""}
        if restart:
            ev["restart"] = restart
        p_cmp = _sig(P_CMP_BASE + acc[i] + bonus - d / (prange[i] * range_mult)
                     - 0.55 * press_c - 1.1 * ln + 0.45 * ctl[m]
                     - P_CMP_FWD * fwdness * (d / 20.0))

        def finish_loose(fr, e, last_t):
            nonlocal car, pending
            if not (0 <= e[0] <= PITCH_L and 0 <= e[1] <= PITCH_W):
                ex, ey = seg_exit(fr[0], fr[1], e[0], e[1])
                eps = 1e-6
                on_goal_line = ex <= eps or ex >= PITCH_L - eps
                if on_goal_line and GOAL_Y[0] < ey < GOAL_Y[1]:
                    def_t = 0 if ex <= eps else 1     # through the mouth -> keeper claims
                    ev["outcome"] = "keeper"
                    ev["end"] = [_r2(ex), _r2(ey)]
                    car = sw[def_t]
                    ev["win"] = tid[car]
                    P[car] = [1.5 if def_t == 0 else PITCH_L - 1.5,
                              min(max(ey, GOAL_Y[0]), GOAL_Y[1])]
                else:
                    pending = award(last_t, ex, ey)
                    ev["outcome"] = "out" if last_t == atk else "deflected_out"
                    ev["end"] = [_r2(e[0]), _r2(e[1])]
                    ev["exit"] = pending["exit"]
                    ev["next"] = pending["rtype"]
            else:
                ev["outcome"] = "loose" if last_t == atk else "deflected"
                car = loose_winner(e[0], e[1])
                ev["win"] = tid[car]
                P[car] = e
                ev["end"] = [_r2(e[0]), _r2(e[1])]

        if rng.random() < p_cmp:
            press_m = press_at(q[0], q[1], atk)
            p_ctl = _sig(2.1 + ctl[m] - 0.75 * press_m - CTL_LONG * max(0.0, d - 18.0) / 10.0)
            if rng.random() < p_ctl:
                ev["outcome"] = "complete"
                car = m
            else:                                     # loose at receiver
                ev["outcome"] = "ctl_fail"
                car = loose_winner(q[0], q[1])
                ev["win"] = tid[car]
                P[car] = q
        else:
            done = False
            if jl >= 0:                               # lane interceptor gets a bite
                p_int = min(0.9, P_INT_BASE + 0.5 * ln * _sig(icpt[jl]))
                if rng.random() < p_int:
                    ev["outcome"] = "intercepted"
                    car = jl
                    done = True
                elif rng.random() < DEFL_P * ln:      # touched but not held -> deflection
                    dx, dy = q - p0
                    s = min(max(((P[jl, 0] - p0[0]) * dx + (P[jl, 1] - p0[1]) * dy) / (d * d), 0.08), 0.92)
                    lp = np.array([p0[0] + dx * s, p0[1] + dy * s])
                    e = lp + rng.normal(0, DEFL_SCATTER, 2)
                    finish_loose(lp, e, int(team[jl]))
                    done = True
            if not done:                              # execution error cone, skill-scaled
                s_th = STRAY_TH * (0.5 + d / 40.0) * (STRAY_SK0 - STRAY_SK1 * acc[i])
                th = math.atan2(q[1] - p0[1], q[0] - p0[0]) + s_th * rng.normal()
                dd = max(2.0, d * (1 + STRAY_OVER + STRAY_POW * rng.normal()))
                finish_loose(p0, np.array([p0[0] + math.cos(th) * dd,
                                           p0[1] + math.sin(th) * dd]), atk)
        return ev

    def do_restart(k):
        """One restart tick: the pending dead ball is delivered."""
        nonlocal pending
        rtype, rt, spot, taker = (pending["rtype"], pending["team"],
                                  pending["spot"], pending["taker"])
        pending = None
        cand = [int(m) for m in idx_t[rt] if m != taker]
        d_a = 1.0 if rt == 0 else -1.0
        gx = gx_of(rt)
        if rtype == "throw_in":                       # arms only reach so far
            c2 = [m for m in cand if np.linalg.norm(P[m] - spot) <= THROW_MAX]
            cand = c2 or [nearest_of(cand, spot[0], spot[1])]
        elif rtype == "kickoff":
            c2 = [m for m in cand if np.linalg.norm(P[m] - spot) <= 18.0]
            cand = c2 or [nearest_of(cand, spot[0], spot[1])]
        elif rtype == "corner":                       # crosses go to the crowd
            c2 = [m for m in cand
                  if m != sw[rt] and math.hypot(gx - P[m, 0], GOAL_CY - P[m, 1]) <= 28.0]
            cand = c2 or cand
        us = []
        for m in cand:
            open_m = float(np.linalg.norm(P[idx_t[1 - rt]] - P[m], axis=1).min())
            d = float(np.linalg.norm(P[m] - spot))
            fwd = d_a * (P[m, 0] - spot[0])
            ln, _ = lane_of(taker, m)
            U = (0.10 * min(open_m, 15) + U_PASS_RISK * risk[taker] * fwd
                 - PASS_DIST_COST * d - LANE_AVOID * ln)
            if rtype == "corner":                     # crosses aim for the box
                dgm = math.hypot(gx - P[m, 0], GOAL_CY - P[m, 1])
                U += CORNER_BOX * max(0.0, 25.0 - dgm)
            us.append(U)
        w = np.exp((np.array(us) - max(us)) / tau[taker])
        m = cand[int(rng.choice(len(cand), p=w / w.sum()))]
        opts = ({"bonus": THROW_BONUS, "range_mult": 0.75} if rtype == "throw_in" else
                {"bonus": 0.3, "range_mult": KICK_RANGE} if rtype == "goal_kick" else
                {"bonus": KO_BONUS, "range_mult": 1.0} if rtype == "kickoff" else
                {"bonus": 0.0, "range_mult": 1.2})
        return resolve_pass(k, taker, m, restart=rtype, **opts)

    for k in range(T):
        atk = pending["team"] if pending else int(team[car])
        d_a = 1.0 if atk == 0 else -1.0
        poss[atk] += 1

        # -- movement phase ------------------------------------------------
        if pending and pending["rtype"] == "kickoff":
            P = A.copy()
            P[pending["taker"]] = pending["spot"]
            st = next((int(m) for m in idx_t[pending["team"]] if slot[m] == 5), None)
            if st is not None and st != pending["taker"]:   # a mate stands in for the tap
                P[st] = [pending["spot"][0] - (2.5 if pending["team"] == 0 else -2.5),
                         pending["spot"][1] + 1.5]
        else:
            bref = np.array(pending["spot"]) if pending else P[car].copy()
            prog = min(max(d_a * (bref[0] - 52.5) / 52.5, 0.0), 1.0)
            is_corner = pending is not None and pending["rtype"] == "corner"
            pull = np.full((12, 1), RESTART_PULL if pending and pending["rtype"] != "throw_in" else 0.4)
            tgt = A.copy()
            tgt[team == atk, 0] += d_a * (2 + 7 * prog)
            tgt[team != atk, 0] += d_a * (1 + 5 * prog)   # defenders retreat
            for t in (0, 1):                              # keeper duty near own goal
                og = own_gx(t)
                if math.hypot(bref[0] - og, bref[1] - GOAL_CY) < GK_ENGAGE:
                    tgt[sw[t]] = [og + (GK_DEPTH if t == 0 else -GK_DEPTH),
                                  min(max(bref[1], GOAL_CY - GK_WIDE), GOAL_CY + GK_WIDE)]
            if is_corner:                                 # crowd the box
                cgx = gx_of(pending["team"])
                from_line = (lambda m: m) if cgx == 0 else (lambda m: PITCH_L - m)
                for i in range(len(players)):
                    if i == pending["taker"]:
                        continue
                    if team[i] == pending["team"] and slot[i] >= 3:
                        s = CORNER_ATK[slot[i] - 3]
                        tgt[i] = [from_line(s[0]), s[1]]
                    elif team[i] != pending["team"] and slot[i] >= 1:
                        s = CORNER_DEF[slot[i] - 1]
                        tgt[i] = [from_line(s[0]), s[1]]
            if pending and pending["rtype"] == "throw_in":  # 2 mates come short
                spot = np.array(pending["spot"])
                cands = [int(m) for m in idx_t[pending["team"]] if m != pending["taker"]]
                helpers = sorted(cands, key=lambda m: np.linalg.norm(P[m] - spot))[:2]
                inf = 1.0 if spot[1] <= GOAL_CY else -1.0
                for h, m in enumerate(helpers):
                    tgt[m] = [min(max(spot[0] + (-9.0 if h else 7.0), 1.0), PITCH_L - 1.0),
                              spot[1] + inf * (8.0 if h else 5.0)]
                    pull[m] = 0.8
            P += pull * (tgt - P) + rng.normal(0, 1.1, (12, 2))
            if not pending:                               # 2 nearest defenders converge
                ball = P[car].copy()
                opp = idx_t[1 - atk]
                for j in opp[np.argsort(np.linalg.norm(P[opp] - ball, axis=1))[:2]]:
                    step = 0.5 * (ball - P[j])
                    n = np.linalg.norm(step)
                    P[j] += step if n <= 6.0 else step * (6.0 / n)
            np.clip(P[:, 0], 0.0, PITCH_L, out=P[:, 0])
            np.clip(P[:, 1], 0.0, PITCH_W, out=P[:, 1])
            if pending:                                   # taker to spot, laws of distance
                P[pending["taker"]] = pending["spot"]
                spot = np.array(pending["spot"])
                R = PUSH_THROW if pending["rtype"] == "throw_in" else PUSH_KICK
                for j in idx_t[1 - pending["team"]]:
                    v = P[j] - spot
                    dj = float(np.linalg.norm(v))
                    if dj < R:
                        if dj > 1e-6:
                            P[j] = spot + v * (R / dj)
                        else:
                            P[j] = spot + [R * (-1.0 if spot[0] > 52.5 else 1.0), 0.0]
                        P[j, 0] = min(max(P[j, 0], 0.0), PITCH_L)
                        P[j, 1] = min(max(P[j, 1], 0.0), PITCH_W)

        # -- event phase -----------------------------------------------------
        if pending:
            events.append(do_restart(k))
            continue

        i = car
        opp, own = idx_t[1 - atk], idx_t[atk]
        mates = own[own != i]
        press_c = press_at(P[i, 0], P[i, 1], atk)
        gx = gx_of(atk)
        gpos = np.array([gx, GOAL_CY])

        # pass options
        lanes = [lane_of(i, int(m)) for m in mates]
        d_im = np.linalg.norm(P[mates] - P[i], axis=1)
        open_m = np.array([float(np.linalg.norm(P[opp] - P[m], axis=1).min()) for m in mates])
        fwd = d_a * (P[mates, 0] - P[i, 0])
        U = (0.10 * np.minimum(open_m, 15) + U_PASS_RISK * risk[i] * fwd
             - PASS_DIST_COST * d_im - LANE_AVOID * np.array([l[0] for l in lanes]))

        # carry option: space in +-45 deg cone toward goal
        gvec = gpos - P[i]
        d_goal = float(np.linalg.norm(gvec))
        gn = gvec / max(d_goal, 1e-9)
        vo = P[opp] - P[i]
        do = np.linalg.norm(vo, axis=1)
        ahead = do[(vo @ gn) / np.maximum(do, 1e-9) >= COS45]
        space = min(float(ahead.min()) if len(ahead) else 15.0, 15.0)
        u_all = np.append(U, U_CARRY_BASE + 1.1 * cbias[i] + 0.05 * space - 0.45 * press_c)

        if d_goal < SHOT_MAX_D:
            ang_p = _post_angle(P[i], gx)
            xgl = XG_BASE - 0.095 * d_goal + 2.2 * ang_p
            u_all = np.append(u_all, U_SHOOT_BASE + 2.6 * sbias[i] + 3.5 * _sig(xgl))

        w = np.exp((u_all - u_all.max()) / tau[i])
        a = int(rng.choice(len(u_all), p=w / w.sum()))

        if a < len(mates):                                       # ---- PASS
            events.append(resolve_pass(k, i, int(mates[a])))

        elif a == len(mates):                                    # ---- CARRY
            pi = P[i].copy()
            no = int(opp[np.argmin(np.linalg.norm(P[opp] - pi, axis=1))])
            v = 0.7 * (gpos - pi) + 0.3 * (pi - P[no])
            n = np.linalg.norm(v)
            dirv = v / n if n > 1e-9 else np.array([d_a, 0.0])
            pos, dist, contests = pi.copy(), 0.0, []
            outcome, tkl_i = "retained", None
            for _ in range(MAX_CARRY_SUB):
                prev = pos.copy()
                pos = pos + CARRY_STEP * dirv
                edge = not (0 <= pos[0] <= PITCH_L and 0 <= pos[1] <= PITCH_W)
                pos = np.clip(pos, [0, 0], [PITCH_L, PITCH_W])
                dist += float(np.linalg.norm(pos - prev))
                do = np.linalg.norm(P[opp] - pos, axis=1)
                j = int(opp[np.argmin(do)])
                contested = do.min() < 5.0
                p_keep = (_sig(1.7 + drb[i] - tkl[j] - 0.35 * press_at(pos[0], pos[1], atk))
                          if contested else 0.995)
                kept = rng.random() < p_keep
                if contested:
                    contests.append([tid[j], 0 if kept else 1])   # 1 = defender wins
                if not kept:
                    outcome, tkl_i = "tackled", j
                    break
                if edge or rng.random() < CARRY_RECIDE:
                    break
            P[i] = pos
            events.append({"k": k, "type": "carry", "tid": tid[i],
                           "x": _r2(pi[0]), "y": _r2(pi[1]), "len": _r2(dist),
                           "press": _r3(press_c), "outcome": outcome,
                           "contests": contests,
                           "tkl": tid[tkl_i] if tkl_i is not None else None})
            if tkl_i is not None:
                car = tkl_i

        else:                                                    # ---- SHOT
            ang_p = _post_angle(P[i], gx)
            xgl = XG_BASE - 0.095 * d_goal + 2.2 * ang_p
            extra = {}
            if rng.random() < _sig(xgl + fin[i]):
                outcome = "goal"
                score[atk] += 1
                place = [(0.35 + 0.6 * rng.random()) * GOAL_HW * (-1 if rng.random() < 0.5 else 1),
                         0.2 + 1.7 * rng.random() ** 2]
                pending = {"rtype": "kickoff", "team": 1 - atk, "spot": [52.5, 34.0],
                           "taker": pm[1 - atk], "exit": None}
            elif rng.random() < P_POST:
                outcome = "post"
                bar = rng.random() < 0.28
                place = ([(rng.random() * 2 - 1) * (GOAL_HW - 0.4), GOAL_H] if bar else
                         [(-1 if rng.random() < 0.5 else 1) * GOAL_HW, 0.4 + 1.6 * rng.random()])
                extra["post"] = "bar" if bar else ("left" if place[0] < 0 else "right")
                if rng.random() < POST_OUT:               # rebound dead -> goal kick
                    extra["after"] = "out"
                    def_t = 1 - atk
                    pending = {"rtype": "goal_kick", "team": def_t,
                               "spot": [5.5 if def_t == 0 else PITCH_L - 5.5,
                                        GOAL_CY - 9.16 if place[0] <= 0 else GOAL_CY + 9.16],
                               "taker": sw[def_t], "exit": [_r2(gx), _r2(GOAL_CY + place[0])]}
                else:                                     # rebound lives — scramble
                    dir_b = -1.0 if atk == 0 else 1.0
                    rb = [min(max(gx + dir_b * (4 + 9 * rng.random()), 0.5), PITCH_L - 0.5),
                          min(max(GOAL_CY + place[0] * 2 + 4 * rng.normal(), 0.5), PITCH_W - 0.5)]
                    car = loose_winner(rb[0], rb[1])
                    P[car] = rb
                    extra["reb"] = [_r2(rb[0]), _r2(rb[1])]
                    extra["win"] = tid[car]
            elif rng.random() < SAVE_P:
                outcome = "save"
                place = [(rng.random() * 2 - 1) * 1.8, 0.15 + 1.6 * rng.random()]
                if rng.random() < PARRY_P:                # parried behind -> corner
                    extra["parry"] = 1
                    spot = [gx, 0.0 if place[0] <= 0 else PITCH_W]
                    cand = [int(m) for m in idx_t[atk] if m != sw[atk]]
                    pending = {"rtype": "corner", "team": atk, "spot": spot,
                               "taker": nearest_of(cand, spot[0], spot[1]),
                               "exit": [_r2(gx), _r2(GOAL_CY + place[0])]}
                else:                                     # keeper holds
                    gk = sw[1 - atk]
                    car = gk
                    extra["win"] = tid[gk]
                    P[gk] = [2.0 if gx == 0 else PITCH_L - 2.0,
                             min(max(GOAL_CY + place[0], GOAL_Y[0]), GOAL_Y[1])]
            else:
                outcome = "off"
                wide = rng.random() < 0.72
                place = ([(GOAL_HW + 0.5 + 2.4 * rng.random()) * (-1 if rng.random() < 0.5 else 1),
                          0.3 + 1.6 * rng.random()] if wide else
                         [(rng.random() * 2 - 1) * (GOAL_HW + 1), GOAL_H + 0.3 + 1.3 * rng.random()])
                def_t = 1 - atk
                pending = {"rtype": "goal_kick", "team": def_t,
                           "spot": [5.5 if def_t == 0 else PITCH_L - 5.5,
                                    GOAL_CY - 9.16 if place[0] <= 0 else GOAL_CY + 9.16],
                           "taker": sw[def_t],
                           "exit": [_r2(gx), _r2(min(max(GOAL_CY + place[0], 0.0), PITCH_W))]}
            events.append({"k": k, "type": "shot", "tid": tid[i],
                           "x": _r2(P[i, 0]), "y": _r2(P[i, 1]), "d": _r2(d_goal),
                           "ang": _r3(ang_p), "press": _r3(press_c), "outcome": outcome,
                           "place": [_r2(place[0]), _r2(place[1])], **extra})

    return {"seed": int(seed), "score": score, "possession": poss, "events": events}


# ---------------------------------------------------------------- extraction
def _p0():
    return {"pass_cmp": {"att": [0] * 6, "suc": [0] * 6},
            "pass_fwd": {"n": 0, "fwd": 0},
            "pass_dir": {"hist": [0] * 3},
            "carry_len": {"hist": [0] * 4},
            "carry_keep": {"att": 0, "kept": 0},
            "shot_conv": {"att": 0, "goals": 0},
            "shot_d_mean": None,
            "rates": {"decisions": 0, "passes": 0, "carries": 0, "shots": 0},
            "tackle": {"opp": 0, "won": 0},
            "intercept": {"opp": 0, "won": 0},
            "receive": {"arr": 0, "fail": 0}}


INT_OPPS = {"intercepted", "out", "loose", "deflected", "deflected_out", "keeper"}


def extract_stats(games, players):
    """§6 pure counting over serialized event dicts. games: [{'events': [...]}].

    Restart events count at team level only (rst/cmp/out) — player families
    measure open play. Mirrors viz/lab-engine.js extract().
    """
    team_of = {int(p["tid"]): int(p["team"]) for p in players}
    ps = {int(p["tid"]): _p0() for p in players}
    dsum = {t: 0.0 for t in ps}
    tm = [{"ticks": 0, "n_poss": 0, "cmp": 0, "out": 0, "dec": 0,
           "goals": 0, "shots": 0, "n_games": len(games),
           "rst": {"throw_in": 0, "corner": 0, "goal_kick": 0, "kickoff": 0}}
          for _ in range(2)]
    for g in games:
        prev = None
        for ev in g["events"]:
            t = team_of[ev["tid"]]
            p = ps[ev["tid"]]
            tm[t]["ticks"] += 1
            tm[t]["dec"] += 1
            if t != prev:
                tm[t]["n_poss"] += 1
                prev = t
            if ev["type"] == "pass":
                oc = ev["outcome"]
                if ev.get("restart"):                 # dead ball: team level only
                    tm[t]["rst"][ev["restart"]] += 1
                    if oc == "complete":
                        tm[t]["cmp"] += 1
                    if oc in ("out", "deflected_out"):
                        tm[t]["out"] += 1
                    continue
                p["rates"]["decisions"] += 1
                p["rates"]["passes"] += 1
                db = 0 if ev["d"] < PASS_D_BINS[0] else (1 if ev["d"] < PASS_D_BINS[1] else 2)
                i6 = db * 2 + (1 if ev["press"] >= PRESS_HI else 0)
                p["pass_cmp"]["att"][i6] += 1
                ab = abs(ev["ang"])
                p["pass_dir"]["hist"][0 if ab < ANG_BINS[0] else (1 if ab <= ANG_BINS[1] else 2)] += 1
                p["pass_fwd"]["n"] += 1               # attack-dir meters from d*cos(ang)
                if ev["d"] * math.cos(ev["ang"]) > 2:
                    p["pass_fwd"]["fwd"] += 1
                if oc == "complete":
                    p["pass_cmp"]["suc"][i6] += 1
                    tm[t]["cmp"] += 1
                if oc in ("complete", "ctl_fail"):
                    ps[ev["tgt"]]["receive"]["arr"] += 1
                    if oc == "ctl_fail":
                        ps[ev["tgt"]]["receive"]["fail"] += 1
                else:
                    if ev["jlane"] is not None and oc in INT_OPPS:
                        ps[ev["jlane"]]["intercept"]["opp"] += 1
                        if oc == "intercepted":
                            ps[ev["jlane"]]["intercept"]["won"] += 1
                    if oc in ("out", "deflected_out"):
                        tm[t]["out"] += 1
            elif ev["type"] == "carry":
                p["rates"]["decisions"] += 1
                p["rates"]["carries"] += 1
                p["carry_keep"]["att"] += 1
                if ev["outcome"] == "retained":
                    p["carry_keep"]["kept"] += 1
                ln = ev["len"]
                p["carry_len"]["hist"][0 if ln < CARRY_BINS[0] else
                                       (1 if ln < CARRY_BINS[1] else
                                        (2 if ln < CARRY_BINS[2] else 3))] += 1
                for dtid, won in ev["contests"]:
                    ps[dtid]["tackle"]["opp"] += 1
                    ps[dtid]["tackle"]["won"] += won
            else:
                p["rates"]["decisions"] += 1
                p["rates"]["shots"] += 1
                p["shot_conv"]["att"] += 1
                tm[t]["shots"] += 1
                if ev["outcome"] == "goal":
                    p["shot_conv"]["goals"] += 1
                    tm[t]["goals"] += 1
                elif ev["outcome"] == "off" or (ev["outcome"] == "post"
                                                and ev.get("after") == "out"):
                    tm[t]["out"] += 1     # dead behind -> the out state
                dsum[ev["tid"]] += ev["d"]
    for t, p in ps.items():
        if p["shot_conv"]["att"]:
            p["shot_d_mean"] = dsum[t] / p["shot_conv"]["att"]
    return {"players": {str(t): ps[t] for t in ps}, "team": tm}


# ---------------------------------------------------------------- loss (§7)
def _pair(att_s, suc_s, att_r, suc_r):
    if att_r / (att_r + 6.0) < 1e-6:
        return 0.0
    return ((suc_s + 1.0) / (att_s + 2.0) - (suc_r + 1.0) / (att_r + 2.0)) ** 2


def _bins6(s, r):
    num = den = 0.0
    for a_s, s_s, a_r, s_r in zip(s["att"], s["suc"], r["att"], r["suc"]):
        w = a_r / (a_r + 6.0)
        num += w * ((s_s + 1.0) / (a_s + 2.0) - (s_r + 1.0) / (a_r + 2.0)) ** 2
        den += w
    return num / max(den, 1e-6)


def _hist(h_s, h_r):
    K = len(h_r)
    ts, tr = sum(h_s), sum(h_r)
    w = tr / (tr + 6.0)
    num = sum(w * ((cs + 1.0) / (ts + K) - (cr + 1.0) / (tr + K)) ** 2
              for cs, cr in zip(h_s, h_r))
    return num / max(K * w, 1e-6)


def _team_metrics(st):
    tot = st["team"][0]["ticks"] + st["team"][1]["ticks"]
    return [(t["ticks"] / max(tot, 1), t["cmp"] / max(t["n_poss"], 1),
             100.0 * t["out"] / max(t["dec"], 1),
             t["goals"] / t["n_games"], t["shots"] / t["n_games"]) for t in st["team"]]


def loss(sim, ref, breakdown=False):
    """Total L = 100*(mean player loss + 0.10*team loss); ref carries the bin weights."""
    fam = {f: 0.0 for f in FAMILY_W}
    n = len(ref["players"])
    for t, r in ref["players"].items():
        s = sim["players"][t]
        fam["pass_cmp"] += _bins6(s["pass_cmp"], r["pass_cmp"])
        fam["carry_len"] += _hist(s["carry_len"]["hist"], r["carry_len"]["hist"])
        fam["carry_keep"] += _pair(s["carry_keep"]["att"], s["carry_keep"]["kept"],
                                   r["carry_keep"]["att"], r["carry_keep"]["kept"])
        fam["shot_conv"] += _pair(s["shot_conv"]["att"], s["shot_conv"]["goals"],
                                  r["shot_conv"]["att"], r["shot_conv"]["goals"])
        fam["shot_rate"] += _pair(s["rates"]["decisions"], s["rates"]["shots"],
                                  r["rates"]["decisions"], r["rates"]["shots"])
        fam["carry_rate"] += _pair(s["rates"]["decisions"], s["rates"]["carries"],
                                   r["rates"]["decisions"], r["rates"]["carries"])
        fam["pass_fwd"] += _pair(s["pass_fwd"]["n"], s["pass_fwd"]["fwd"],
                                 r["pass_fwd"]["n"], r["pass_fwd"]["fwd"])
        fam["pass_dir"] += _hist(s["pass_dir"]["hist"], r["pass_dir"]["hist"])
        fam["intercept"] += _pair(s["intercept"]["opp"], s["intercept"]["won"],
                                  r["intercept"]["opp"], r["intercept"]["won"])
        fam["tackle"] += _pair(s["tackle"]["opp"], s["tackle"]["won"],
                               r["tackle"]["opp"], r["tackle"]["won"])
        fam["ctl_fail"] += _pair(s["receive"]["arr"], s["receive"]["fail"],
                                 r["receive"]["arr"], r["receive"]["fail"])
    l_players = sum(FAMILY_W[f] * v for f, v in fam.items()) / n
    l_team = 0.0
    nz = [TEAM_NORM[k] for k in ("share", "ppp", "out100", "gpg", "spg")]
    for a, b in zip(_team_metrics(sim), _team_metrics(ref)):
        l_team += sum((x - y) ** 2 / z for x, y, z in zip(a, b, nz))
    l_team /= 2
    total = 100.0 * (l_players + TEAM_MULT * l_team)
    if breakdown:
        bd = {f: 100.0 * FAMILY_W[f] * v / n for f, v in fam.items()}
        bd["team"] = 100.0 * TEAM_MULT * l_team
        return total, bd
    return total


# ---------------------------------------------------------------- sanity (§9)
def sanity_check(train_block):
    """§9 metrics over the pooled train stats -> {name: (value, lo, hi, ok)}."""
    st, games = train_block["stats"], train_block["games"]
    n = len(games)
    pl = list(st["players"].values())
    att = sum(sum(p["pass_cmp"]["att"]) for p in pl)
    suc = sum(sum(p["pass_cmp"]["suc"]) for p in pl)
    catt = sum(p["carry_keep"]["att"] for p in pl)
    kept = sum(p["carry_keep"]["kept"] for p in pl)
    lens = [ev["len"] for g in games for ev in g["events"] if ev["type"] == "carry"]
    vals = {
        "pass_completion": suc / max(att, 1),
        "passes_per_game": att / n,
        "goals_per_game": sum(t["goals"] for t in st["team"]) / n,
        "shots_per_game": sum(t["shots"] for t in st["team"]) / n,
        "outs_per_game": sum(t["out"] for t in st["team"]) / n,
        "carries_per_game": catt / n,
        "carry_dispossession": 1.0 - kept / max(catt, 1),
        "interceptions_per_game": sum(p["intercept"]["won"] for p in pl) / n,
        "mean_carry_len": sum(lens) / max(len(lens), 1),
        "throw_ins_per_game": sum(t["rst"]["throw_in"] for t in st["team"]) / n,
        "goal_kicks_per_game": sum(t["rst"]["goal_kick"] for t in st["team"]) / n,
        "corners_per_game": sum(t["rst"]["corner"] for t in st["team"]) / n,
    }
    return {k: (v, SANITY[k][0], SANITY[k][1], SANITY[k][0] <= v <= SANITY[k][1])
            for k, v in vals.items()}


# ---------------------------------------------------------------- dataset
def build_dataset(train_seeds=TRAIN_SEEDS, val_seeds=VAL_SEEDS, theta_seed=THETA_SEED):
    players = build_players()
    Z = make_theta(players, theta_seed)
    print("[transitions] roster: " + " ".join(
        f"t{p['team']}s{p['slot']}={p['tid']}({p['archetype'][:4]})" for p in players))
    train_games = []
    for s in train_seeds:
        g = simulate_game(Z, players, s)
        print(f"[transitions] train seed={s} score={g['score']} possession={g['possession']}")
        train_games.append(g)
    # determinism contract: canonical stats come from the SERIALIZED events
    train_games = json.loads(json.dumps(train_games))
    train_stats = extract_stats(train_games, players)
    val_games = []
    for s in val_seeds:
        g = simulate_game(Z, players, s)
        print(f"[transitions] val   seed={s} score={g['score']}")
        val_games.append(g)
    val_games = json.loads(json.dumps(val_games))
    val_stats = extract_stats(val_games, players)
    noise = loss(train_stats, val_stats)
    data = {
        "version": 2, "pitch": [PITCH_L, PITCH_W],
        "dims": [{"name": nm, "lo": float(lo), "hi": float(hi)}
                 for nm, lo, hi in zip(DIM_NAMES, LO, HI)],
        "players": players,
        "bins": {"pass_d": list(PASS_D_BINS), "press_hi": PRESS_HI,
                 "carry": list(CARRY_BINS), "ang": list(ANG_BINS)},
        "engine": {"tick": TICK, "T": T_TICKS, "R_PRESS": R_PRESS, "PRESS_HI": PRESS_HI,
                   "CARRY_STEP": CARRY_STEP, "MAX_CARRY_SUB": MAX_CARRY_SUB,
                   "CARRY_RECIDE": CARRY_RECIDE, "SHOT_MAX_D": SHOT_MAX_D,
                   "U_CARRY_BASE": U_CARRY_BASE, "P_INT_BASE": P_INT_BASE,
                   "LANE_AVOID": LANE_AVOID, "XG_BASE": XG_BASE,
                   "PASS_DIST_COST": PASS_DIST_COST, "U_SHOOT_BASE": U_SHOOT_BASE,
                   "SAVE_P": SAVE_P,
                   "P_CMP_BASE": P_CMP_BASE, "P_CMP_FWD": P_CMP_FWD, "CTL_LONG": CTL_LONG,
                   "STRAY_TH": STRAY_TH, "STRAY_SK0": STRAY_SK0, "STRAY_SK1": STRAY_SK1,
                   "STRAY_POW": STRAY_POW, "STRAY_OVER": STRAY_OVER,
                   "U_PASS_RISK": U_PASS_RISK, "TEAM_MULT": TEAM_MULT,
                   "DEFL_P": DEFL_P, "DEFL_SCATTER": DEFL_SCATTER,
                   "P_POST": P_POST, "PARRY_P": PARRY_P, "POST_OUT": POST_OUT,
                   "THROW_MAX": THROW_MAX, "THROW_BONUS": THROW_BONUS,
                   "KICK_RANGE": KICK_RANGE, "KO_BONUS": KO_BONUS,
                   "CORNER_BOX": CORNER_BOX, "PUSH_KICK": PUSH_KICK,
                   "PUSH_THROW": PUSH_THROW, "RESTART_PULL": RESTART_PULL,
                   "GK_ENGAGE": GK_ENGAGE, "GK_DEPTH": GK_DEPTH, "GK_WIDE": GK_WIDE,
                   "family_w": FAMILY_W, "team_norm": TEAM_NORM},
        "train": {"games": train_games, "stats": train_stats},
        "val": {"n_games": len(val_seeds), "scores": [g["score"] for g in val_games],
                "stats": val_stats},
        "noise_floor": noise,
        "sealed": {"theta_true": {str(p["tid"]): [float(v) for v in Z[i]]
                                  for i, p in enumerate(players)},
                   "note": "ground truth — break the seal in the lab"},
    }
    return data


def uniform_ratio(data, seed0, n_pairs=3):
    """mean over n_pairs 2-game evals of loss(uniform-0.5 sim, train)/noise_floor.

    The 2-game protocol is the loss scale; averaging independent pairs only
    steadies the ESTIMATOR (single-pair draws swing ~2x around the mean).
    """
    players = data["players"]
    Zu = np.full((len(players), 11), 0.5)
    rs = []
    for r in range(n_pairs):
        games = json.loads(json.dumps(
            [simulate_game(Zu, players, seed0 + 2 * r + i) for i in (0, 1)]))
        rs.append(loss(extract_stats(games, players), data["train"]["stats"])
                  / data["noise_floor"])
    return sum(rs) / len(rs)


def _same(a, b, path=""):
    """Recursive stats equality: ints exact, floats to 1e-12. Returns list of diffs."""
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return [f"{path}: keys {set(a) ^ set(b)}"]
        return [d for k in a for d in _same(a[k], b[k], f"{path}.{k}")]
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: len {len(a)} != {len(b)}"]
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in _same(x, y, f"{path}[{i}]")]
    if isinstance(a, float) or isinstance(b, float):
        return [] if abs(a - b) <= 1e-12 else [f"{path}: {a} != {b}"]
    return [] if a == b else [f"{path}: {a} != {b}"]


def _print_sanity(rep):
    ok_all = True
    for name, (v, lo, hi, ok) in rep.items():
        ok_all &= ok
        print(f"[transitions]   {name:24s} {v:8.3f}   target [{lo}, {hi}]   {'ok' if ok else 'MISS'}")
    return ok_all


# ---------------------------------------------------------------- CLI
def main():
    t0 = time.time()
    data = build_dataset()
    rep = sanity_check(data["train"])
    ok = _print_sanity(rep)
    ratio = uniform_ratio(data, TRAIN_SEEDS[0] + 2000)
    print(f"[transitions] noise floor loss(train,val) = {data['noise_floor']:.4f}")
    print(f"[transitions] uniform-genome loss ratio   = {ratio:.1f}x (need >= 4)")
    path = save_json(OUT / "transition_data.json", data)
    shutil.copy2(path, VIZ_ASSETS / "transition_data.json")
    kb = path.stat().st_size / 1024
    print(f"[transitions] wrote {path} ({kb:.0f} KB) + viz/assets copy "
          f"[{time.time() - t0:.1f}s]{'' if ok else '  ** SANITY MISS **'}")


def selftest():
    """Alternate-seed regeneration: extraction determinism + §9 + noise floor + 4x."""
    print("[transitions] selftest: regenerating with alternate seeds…")
    data = build_dataset(train_seeds=(5001, 5002), val_seeds=tuple(range(6001, 6007)),
                         theta_seed=77)
    parsed = json.loads(json.dumps(data))
    re_stats = extract_stats(parsed["train"]["games"], parsed["players"])
    diffs = _same(re_stats, parsed["train"]["stats"])
    print(f"[transitions] determinism: re-extracted stats vs stored — "
          f"{'IDENTICAL' if not diffs else f'{len(diffs)} DIFFS: ' + '; '.join(diffs[:5])}")
    rep = sanity_check(data["train"])
    ok = _print_sanity(rep)
    ratio = uniform_ratio(data, 7001)
    print(f"[transitions] noise floor = {data['noise_floor']:.4f} (must be > 0 and small)")
    print(f"[transitions] uniform-genome ratio = {ratio:.1f}x (need >= 4)")
    passed = (not diffs) and ok and data["noise_floor"] > 0 and ratio >= 4
    print(f"[transitions] selftest {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    raise SystemExit(selftest() if args.selftest else main())
