/* lab-engine.js — the possession graph: match engine · extractor · loss · GA.
 * SportSim transition-model spec v1 (§§1–3, 5–8). Pure ES module: no DOM, no
 * network, deterministic given a seed (mulberry32 streams). Mirrors
 * pipeline/08_transitions.py — extractor and loss count IDENTICALLY, and every
 * tuned constant (§3 deviations, §7 family weights/team normalizers) is read
 * from the data file's `engine` block via configureFromData(data): the live GA
 * simulates with the same physics that generated the data. Module defaults
 * below are the SPEC values (fallback when no engine block is present).
 *
 * Ball = token on a stochastic transition graph; each player is an 11-dim
 * vector of conditional probability distributions (genotype z ∈ [0,1]^11,
 * phys = lo + z·(hi−lo)). Per tick the carrier samples ONE action from
 * softmax(U/τ), τ = 1/(0.5 + 1.5·vision):
 *   U_pass(m) = .10·min(open_m,15) + .045·risk·fwd_m − .030·d_im − .9·lane_m
 *   U_carry   = .5 + 1.1·carry_bias + .05·min(space,15) − .45·press
 *   U_shoot   = −.8 + 2.6·shoot_bias + 3.5·xg   (only if d_goal < 30)
 *   xg = σ(−1.1 − .095·d_goal + 2.2·ang),  ang = angle subtended by the posts
 * Outcomes:
 *   pass  p_cmp = σ(pass_acc − d/pass_range − .55·press − 1.1·lane + .45·ctl_m);
 *         receiver control p_ctl = σ(2.1 + ctl_m − .75·press_m); interception
 *         p_int = min(.9, .32 + .5·lane·σ(int_jlane)); strays overshoot the
 *         target by U(.15,.5)·(tgt−src) + N(0,2²) and may go out.
 *   carry ≤6 substeps of 3.2 m toward normalize(.7·(goal−p) + .3·(p−nearest));
 *         contest within 5 m: p_keep = σ(1.7 + drb_i − tkl_j − .35·press_loc),
 *         uncontested p_keep = .995; stop w.p. .45 per surviving substep.
 *   shot  p_goal = σ(logit(xg) + finish); miss → save (p=.42) else off.
 * Loss (§7): Laplace p̂=(suc+1)/(att+2) (hists (cnt+1)/(tot+K)), bin weight
 * w = att_ref/(att_ref+6) (hists share w = tot_ref/(tot_ref+6), ÷ max(K·w,1e-6)
 * — the pipeline's convention); family weights + team normalizers come from the
 * engine block; L = 100·(mean player loss + .10·team term).
 * GA (§8): genome 12×11, pop 28, elitism 2, tournament k=3, per-block
 * crossover (blend p=.3 else swap p=.5), mutation p=.15 σ=.18·exp(−gen/140),
 * init U(.15,.85). CRN eval seeds base+gen·2,+1; champion = best-of-gen
 * re-evaluated on 2 fresh seeds, running best by re-eval loss.
 */

/* ------------------------------------------------------------ constants */
export const PITCH_L = 105, PITCH_W = 68;
export const GOAL_Y = [30.34, 37.66];

export const DIMS = [
  { name: "pass_acc",   lo:  1.0, hi:  3.5 },
  { name: "pass_range", lo: 10.0, hi: 34.0 },
  { name: "vision",     lo:  0.0, hi:  1.0 },
  { name: "risk",       lo:  0.0, hi:  1.0 },
  { name: "dribble",    lo: -1.5, hi:  1.5 },
  { name: "carry_bias", lo:  0.0, hi:  1.0 },
  { name: "finish",     lo: -1.0, hi:  2.0 },
  { name: "shoot_bias", lo:  0.0, hi:  1.0 },
  { name: "tackle",     lo: -1.5, hi:  1.5 },
  { name: "intercept",  lo: -1.5, hi:  1.5 },
  { name: "control",    lo: -1.5, hi:  1.5 },
];

export const ENGINE = {
  // §3 SPEC defaults; the pipeline's tuned values arrive via configureFromData
  tick: 2.0, T: 700, R_PRESS: 4.5, PRESS_HI: 0.55,
  CARRY_STEP: 3.2, MAX_CARRY_SUB: 6, CARRY_RECIDE: 0.45, SHOT_MAX_D: 30,
  INT_BASE: 0.32, SAVE_P: 0.42,
  U_PASS_OPEN: 0.10, U_PASS_RISK: 0.045, U_PASS_DIST: 0.030, U_PASS_LANE: 0.9,
  U_CARRY_BASE: 0.5, U_CARRY_BIAS: 1.1, U_CARRY_SPACE: 0.05, U_CARRY_PRESS: 0.45,
  U_SHOOT_BASE: -0.8, U_SHOOT_BIAS: 2.6, U_SHOOT_XG: 3.5,
  P_CMP_PRESS: 0.55, P_CMP_LANE: 1.1, P_CMP_CTL: 0.45,
  XG_BASE: -1.1, XG_D: 0.095, XG_ANG: 2.2,
  STRAY_LO: 0.15, STRAY_HI: 0.5, STRAY_NOISE: 2.0,
};

export const BINS = { pass_d: [12, 25], press_hi: ENGINE.PRESS_HI, carry: [3.5, 8, 15] };

/* θ* archetype genotype means per slot (§1, order = DIMS) */
export const ARCHETYPES = {
  sweeper:   [.72, .62, .55, .20, .30, .25, .25, .10, .85, .85, .60],
  back:      [.62, .55, .45, .30, .35, .30, .30, .12, .72, .65, .62],
  back2:     [.60, .52, .45, .32, .38, .32, .30, .12, .70, .62, .60],
  playmaker: [.88, .80, .90, .55, .50, .35, .40, .18, .42, .55, .85],
  runner:    [.58, .45, .50, .80, .88, .85, .50, .35, .35, .40, .62],
  striker:   [.55, .42, .55, .65, .68, .55, .90, .85, .25, .30, .70],
};
export const SLOT_ARCH = ["sweeper", "back", "back2", "playmaker", "runner", "striker"];
export const FORMATION = [[18, 34], [30, 17], [30, 51], [48, 34], [62, 12], [72, 40]];
/* tids per slot 0..5, ordered by rho[0]·attack_dir from out/evolution.json (§1):
 * team 0 (dir +1) ascending rho_x → [16,9,5,2,7,0];
 * team 1 (dir −1) DESCENDING rho_x {13.4,12.4,12.4,12.3,10.0,9.3} → [12,14,13,3,1,10]
 * (matches data.players in out/transition_data.json). */
export const ROSTER = [[16, 9, 5, 2, 7, 0], [12, 14, 13, 3, 1, 10]];

export const LOSS_W = {                          // §7 SPEC defaults (see below)
  pass_cmp: .28, carry_len: .16, carry_keep: .06, shot_conv: .08, shot_rate: .06,
  carry_rate: .06, pass_fwd: .06, intercept: .08, tackle: .08, ctl_fail: .04,
};
export const TEAM_NORM = { share: 1, ppp: 25, out100: 100, gpg: 9, spg: 64 };

/* pipeline engine-block keys → ENGINE fields (Python names are canonical) */
const ENGINE_MAP = {
  tick: "tick", T: "T", R_PRESS: "R_PRESS", PRESS_HI: "PRESS_HI",
  CARRY_STEP: "CARRY_STEP", MAX_CARRY_SUB: "MAX_CARRY_SUB",
  CARRY_RECIDE: "CARRY_RECIDE", SHOT_MAX_D: "SHOT_MAX_D",
  U_CARRY_BASE: "U_CARRY_BASE", P_INT_BASE: "INT_BASE", LANE_AVOID: "U_PASS_LANE",
  XG_BASE: "XG_BASE", PASS_DIST_COST: "U_PASS_DIST",
};
export function configureFromData(data) {        // adopt the generator's tuning
  const eng = data && data.engine;
  if (eng) {
    for (const k in ENGINE_MAP)
      if (typeof eng[k] === "number") ENGINE[ENGINE_MAP[k]] = eng[k];
    if (eng.family_w) for (const k in LOSS_W)
      if (typeof eng.family_w[k] === "number") LOSS_W[k] = eng.family_w[k];
    if (eng.team_norm) for (const k in TEAM_NORM)
      if (typeof eng.team_norm[k] === "number") TEAM_NORM[k] = eng.team_norm[k];
  }
  const b = data && data.bins;
  if (b) {
    if (b.pass_d) BINS.pass_d = Array.from(b.pass_d);
    if (typeof b.press_hi === "number") BINS.press_hi = b.press_hi;
    if (b.carry) BINS.carry = Array.from(b.carry);
  }
  return ENGINE;
}

/* ------------------------------------------------------------ rng + math */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randn(rng) {                    // Box–Muller, cosine branch
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/* ------------------------------------------------------------ roster / θ* */
export function makePlayers() {
  const out = [];
  for (let t = 0; t < 2; t++)
    for (let s = 0; s < 6; s++) {
      const [fx, fy] = FORMATION[s];
      out.push({ tid: ROSTER[t][s], team: t, slot: s,
                 anchor: [t === 0 ? fx : PITCH_L - fx, fy], archetype: SLOT_ARCH[s] });
    }
  return out;
}

export function thetaStar(players, seed = 22) {  // archetype + N(0,.06) jitter
  const rng = mulberry32(seed);
  const Z = new Float64Array(players.length * 11);
  players.forEach((p, i) => {
    const a = ARCHETYPES[p.archetype];
    for (let d = 0; d < 11; d++) Z[i * 11 + d] = clamp(a[d] + 0.06 * randn(rng), 0.05, 0.95);
  });
  return Z;
}

/* ------------------------------------------------------------ match engine */
export function playGame(players, Z, seed, { record = false } = {}) {
  const E = ENGINE, N = players.length, rng = mulberry32(seed);
  const phys = new Float64Array(N * 11);
  for (let i = 0; i < N; i++)
    for (let d = 0; d < 11; d++)
      phys[i * 11 + d] = DIMS[d].lo + clamp(Z[i * 11 + d], 0, 1) * (DIMS[d].hi - DIMS[d].lo);
  const ph = (i, d) => phys[i * 11 + d];
  const team = players.map((p) => p.team);
  const A = players.map((p) => p.anchor);
  const tid = players.map((p) => p.tid);
  const mates = [[], []];
  players.forEach((p, i) => mates[p.team].push(i));
  const foes = [mates[1], mates[0]];
  const pm = [mates[0].find((i) => players[i].slot === 3), mates[1].find((i) => players[i].slot === 3)];

  const P = players.map((p) => [p.anchor[0], p.anchor[1]]);
  let carrier = pm[0];                            // team 0 kicks off
  const events = [], score = [0, 0], poss = [0, 0];
  const posRec = record ? new Float32Array(E.T * N * 2) : null;
  const ballRec = record ? new Float32Array(E.T * 2) : null;

  const dist = (i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const pressAt = (x, y, t) => {                  // Σ_opp exp(−d/R)
    let s = 0;
    for (const j of foes[t]) s += Math.exp(-Math.hypot(P[j][0] - x, P[j][1] - y) / E.R_PRESS);
    return s;
  };
  const kickoff = (t) => {                        // positions→anchors, ball→playmaker of t
    for (let i = 0; i < N; i++) { P[i][0] = A[i][0]; P[i][1] = A[i][1]; }
    carrier = pm[t];
  };
  const deepest = (t) => {                        // team t's player nearest own goal
    const dT = t === 0 ? 1 : -1;
    let bi = mates[t][0], bv = Infinity;
    for (const i of mates[t]) { const v = dT * P[i][0]; if (v < bv) { bv = v; bi = i; } }
    return bi;
  };
  const looseWinner = (x, y) => {                 // nearest wins, tie noise N(0,1.5)
    let bi = 0, bv = Infinity;
    for (let i = 0; i < N; i++) {
      const v = Math.hypot(P[i][0] - x, P[i][1] - y) + 1.5 * randn(rng);
      if (v < bv) { bv = v; bi = i; }
    }
    return bi;
  };

  for (let k = 0; k < E.T; k++) {
    const atk = team[carrier], dA = atk === 0 ? 1 : -1;
    poss[atk]++;
    const prog = clamp(dA * (P[carrier][0] - 52.5) / 52.5, 0, 1);
    for (let i = 0; i < N; i++) {                 // drift to effective anchors + noise
      let ax;
      if (team[i] === atk) ax = A[i][0] + dA * (2 + 7 * prog);
      else { const dD = team[i] === 0 ? 1 : -1; ax = A[i][0] - dD * (1 + 5 * prog); }
      P[i][0] += 0.4 * (ax - P[i][0]) + 1.1 * randn(rng);
      P[i][1] += 0.4 * (A[i][1] - P[i][1]) + 1.1 * randn(rng);
    }
    const bx = P[carrier][0], by = P[carrier][1];
    const near = foes[atk].map((j) => [Math.hypot(P[j][0] - bx, P[j][1] - by), j]).sort((a, b) => a[0] - b[0]);
    for (let n = 0; n < 2; n++) {                 // 2 nearest defenders converge, cap 6 m
      const j = near[n][1];
      let cx = 0.5 * (bx - P[j][0]), cy = 0.5 * (by - P[j][1]);
      const cl = Math.hypot(cx, cy);
      if (cl > 6) { cx *= 6 / cl; cy *= 6 / cl; }
      P[j][0] += cx; P[j][1] += cy;
    }
    for (let i = 0; i < N; i++) { P[i][0] = clamp(P[i][0], 0, PITCH_L); P[i][1] = clamp(P[i][1], 0, PITCH_W); }

    const i = carrier;
    const pressC = pressAt(P[i][0], P[i][1], atk);
    const laneOf = (m) => {                       // max opp lane risk on segment i→m
      const sx = P[i][0], sy = P[i][1], dx = P[m][0] - sx, dy = P[m][1] - sy;
      const L2 = dx * dx + dy * dy || 1e-9;
      let best = 0, jl = -1;
      for (const j of foes[atk]) {
        const s = ((P[j][0] - sx) * dx + (P[j][1] - sy) * dy) / L2;
        if (s >= 0.08 && s <= 0.92) {
          const perp = Math.abs((P[j][0] - sx) * dy - (P[j][1] - sy) * dx) / Math.sqrt(L2);
          const lj = Math.exp(-perp / 2.5);
          if (lj > best) { best = lj; jl = j; }
        }
      }
      return [best, jl];
    };

    /* -- policy: one decision per tick ------------------------------- */
    const acts = [];
    for (const m of mates[atk]) if (m !== i) {
      let open = Infinity;
      for (const j of foes[atk]) { const dd = dist(j, m); if (dd < open) open = dd; }
      const fwd = dA * (P[m][0] - P[i][0]);
      const d = dist(i, m);
      const [ln, jl] = laneOf(m);
      acts.push({ kind: 0, m, d, ln, jl, fwd,
        U: E.U_PASS_OPEN * Math.min(open, 15) + E.U_PASS_RISK * ph(i, 3) * fwd
           - E.U_PASS_DIST * d - E.U_PASS_LANE * ln });
    }
    const gx = atk === 0 ? PITCH_L : 0, gy = PITCH_W / 2;
    {
      const dgx = gx - P[i][0], dgy = gy - P[i][1], gl = Math.hypot(dgx, dgy) || 1e-9;
      const ux = dgx / gl, uy = dgy / gl;
      let space = 15;
      for (const j of foes[atk]) {                // nearest opp in ±45° cone to goal
        const vx = P[j][0] - P[i][0], vy = P[j][1] - P[i][1];
        const dj = Math.hypot(vx, vy) || 1e-9;
        if ((vx * ux + vy * uy) / dj >= Math.SQRT1_2 && dj < space) space = dj;
      }
      acts.push({ kind: 1, U: E.U_CARRY_BASE + E.U_CARRY_BIAS * ph(i, 5)
        + E.U_CARRY_SPACE * Math.min(space, 15) - E.U_CARRY_PRESS * pressC });
    }
    const dGoal = Math.hypot(gx - P[i][0], gy - P[i][1]);
    let xgl = 0;
    if (dGoal < E.SHOT_MAX_D) {
      const v1y = GOAL_Y[0] - P[i][1], v2y = GOAL_Y[1] - P[i][1], vx = gx - P[i][0];
      const ang = Math.acos(clamp((vx * vx + v1y * v2y) /
        (Math.hypot(vx, v1y) * Math.hypot(vx, v2y) || 1e-9), -1, 1));
      xgl = E.XG_BASE - E.XG_D * dGoal + E.XG_ANG * ang;
      acts.push({ kind: 2, d: dGoal, ang,
        U: E.U_SHOOT_BASE + E.U_SHOOT_BIAS * ph(i, 7) + E.U_SHOOT_XG * sig(xgl) });
    }
    const tau = 1 / (0.5 + 1.5 * ph(i, 2));
    let umax = -Infinity;
    for (const a of acts) if (a.U > umax) umax = a.U;
    let wsum = 0;
    for (const a of acts) { a.w = Math.exp((a.U - umax) / tau); wsum += a.w; }
    let r = rng() * wsum, act = acts[acts.length - 1];
    for (const a of acts) { r -= a.w; if (r <= 0) { act = a; break; } }

    /* -- outcomes ----------------------------------------------------- */
    if (act.kind === 0) {                         // PASS
      const m = act.m, ln = act.ln, jl = act.jl;
      const ev = { k, type: "pass", tid: tid[i], x: r2(P[i][0]), y: r2(P[i][1]),
        tgt: tid[m], d: r2(act.d), press: r3(pressC), lane: r3(ln),
        jlane: jl >= 0 ? tid[jl] : null, fwd: r2(act.fwd), outcome: "" };
      const pCmp = sig(ph(i, 0) - act.d / ph(i, 1) - E.P_CMP_PRESS * pressC
        - E.P_CMP_LANE * ln + E.P_CMP_CTL * ph(m, 10));
      if (rng() < pCmp) {
        const pressM = pressAt(P[m][0], P[m][1], atk);
        if (rng() < sig(2.1 + ph(m, 10) - 0.75 * pressM)) { ev.outcome = "complete"; carrier = m; }
        else {                                    // loose at receiver; winner steps in
          ev.outcome = "ctl_fail"; carrier = looseWinner(P[m][0], P[m][1]);
          P[carrier][0] = P[m][0]; P[carrier][1] = P[m][1];
        }
      } else {
        let done = false;
        if (jl >= 0) {                            // lane interceptor gets a bite
          const pInt = Math.min(0.9, E.INT_BASE + 0.5 * ln * sig(ph(jl, 9)));
          if (rng() < pInt) { ev.outcome = "intercepted"; carrier = jl; done = true; }
        }
        if (!done) {                              // stray beyond the target
          const over = E.STRAY_LO + (E.STRAY_HI - E.STRAY_LO) * rng();
          const ex = P[m][0] + (P[m][0] - P[i][0]) * over + E.STRAY_NOISE * randn(rng);
          const ey = P[m][1] + (P[m][1] - P[i][1]) * over + E.STRAY_NOISE * randn(rng);
          if (ex < 0 || ex > PITCH_L || ey < 0 || ey > PITCH_W) {
            ev.outcome = "out";                   // restart: opp nearest the clamped exit
            const cx = clamp(ex, 0, PITCH_L), cy = clamp(ey, 0, PITCH_W);
            let bi = foes[atk][0], bv = Infinity;
            for (const j of foes[atk]) {
              const v = Math.hypot(P[j][0] - cx, P[j][1] - cy);
              if (v < bv) { bv = v; bi = j; }
            }
            carrier = bi; P[bi][0] = cx; P[bi][1] = cy;
          } else {
            ev.outcome = "loose"; carrier = looseWinner(ex, ey);
            P[carrier][0] = ex; P[carrier][1] = ey;
          }
        }
      }
      events.push(ev);
    } else if (act.kind === 1) {                  // CARRY
      const sx = P[i][0], sy = P[i][1];
      let nb = foes[atk][0], nv = Infinity;
      for (const j of foes[atk]) { const v = dist(i, j); if (v < nv) { nv = v; nb = j; } }
      let dx = 0.7 * (gx - sx) + 0.3 * (sx - P[nb][0]);
      let dy = 0.7 * (gy - sy) + 0.3 * (sy - P[nb][1]);
      const dl = Math.hypot(dx, dy);
      if (dl > 1e-9) { dx /= dl; dy /= dl; } else { dx = dA; dy = 0; }
      const contests = [];
      let outcome = "retained", tkl = null, cx = sx, cy = sy, len = 0;
      for (let sub = 0; sub < E.MAX_CARRY_SUB; sub++) {
        let nx = cx + dx * E.CARRY_STEP, ny = cy + dy * E.CARRY_STEP, edge = false;
        if (nx < 0 || nx > PITCH_L || ny < 0 || ny > PITCH_W) {
          nx = clamp(nx, 0, PITCH_L); ny = clamp(ny, 0, PITCH_W); edge = true;
        }
        len += Math.hypot(nx - cx, ny - cy);      // path length, post-clip steps
        cx = nx; cy = ny;
        let cj = foes[atk][0], cv = Infinity;
        for (const j of foes[atk]) {
          const v = Math.hypot(P[j][0] - cx, P[j][1] - cy);
          if (v < cv) { cv = v; cj = j; }
        }
        const contested = cv < 5;
        const pKeep = contested ? sig(1.7 + ph(i, 4) - ph(cj, 8) - 0.35 * pressAt(cx, cy, atk)) : 0.995;
        const kept = rng() < pKeep;
        if (contested) contests.push([tid[cj], kept ? 0 : 1]);
        if (!kept) {                              // uncontested stumble also → nearest opp
          outcome = "tackled"; tkl = tid[cj]; carrier = cj;
          break;
        }
        if (edge) break;
        if (rng() < E.CARRY_RECIDE) break;        // re-decide next tick
      }
      P[i][0] = cx; P[i][1] = cy;
      events.push({ k, type: "carry", tid: tid[i], x: r2(sx), y: r2(sy),
        len: r2(len), press: r3(pressC), outcome, contests, tkl });
    } else {                                      // SHOT
      let outcome;
      if (rng() < sig(xgl + ph(i, 6))) { outcome = "goal"; score[atk]++; }
      else outcome = rng() < E.SAVE_P ? "save" : "off";
      events.push({ k, type: "shot", tid: tid[i], x: r2(P[i][0]), y: r2(P[i][1]),
        d: r2(act.d), ang: r3(act.ang), press: r3(pressC), outcome });
      if (outcome === "goal") kickoff(1 - atk);   // restarts consume no ticks
      else carrier = deepest(1 - atk);            // save/off → defenders' deepest man
    }

    if (record) {
      for (let q = 0; q < N; q++) { posRec[(k * N + q) * 2] = P[q][0]; posRec[(k * N + q) * 2 + 1] = P[q][1]; }
      ballRec[k * 2] = P[carrier][0]; ballRec[k * 2 + 1] = P[carrier][1];
    }
  }
  return { events, score, possession: poss, positions: posRec, ball: ballRec };
}

/* ------------------------------------------------------------ extraction (§6) */
function pInit() {
  return {
    pass_cmp: { att: [0, 0, 0, 0, 0, 0], suc: [0, 0, 0, 0, 0, 0] },
    pass_fwd: { n: 0, fwd: 0 },
    carry_len: { hist: [0, 0, 0, 0] },
    carry_keep: { att: 0, kept: 0 },
    shot_conv: { att: 0, goals: 0 },
    shot_d_mean: null,
    rates: { decisions: 0, passes: 0, carries: 0, shots: 0 },
    tackle: { opp: 0, won: 0 },
    intercept: { opp: 0, won: 0 },
    receive: { arr: 0, fail: 0 },
  };
}

export function extract(games, players) {       // pure counting — never smoothed
  // Counts ONLY from serialized events (determinism contract with the pipeline);
  // team block = raw counts in pipeline schema {ticks,n_poss,cmp,out,dec,goals,
  // shots,n_games} — derived metrics live in the loss (teamMetrics).
  const P = {}, teamOf = {}, shotD = {};
  players.forEach((p) => { P[p.tid] = pInit(); teamOf[p.tid] = p.team; shotD[p.tid] = 0; });
  const T = [0, 1].map(() => ({ ticks: 0, n_poss: 0, cmp: 0, out: 0, dec: 0,
    goals: 0, shots: 0, n_games: games.length }));
  for (const g of games) {
    let run = null;                               // possession = maximal same-team run
    for (const e of g.events) {
      const s = P[e.tid], t = teamOf[e.tid];
      s.rates.decisions++; T[t].ticks++; T[t].dec++;
      if (t !== run) { T[t].n_poss++; run = t; }
      if (e.type === "pass") {
        s.rates.passes++;
        const db = e.d < BINS.pass_d[0] ? 0 : e.d < BINS.pass_d[1] ? 1 : 2;
        const bi = db * 2 + (e.press >= BINS.press_hi ? 1 : 0);
        s.pass_cmp.att[bi]++;
        s.pass_fwd.n++;
        if (e.fwd > 2) s.pass_fwd.fwd++;
        if (e.outcome === "complete") { s.pass_cmp.suc[bi]++; T[t].cmp++; }
        if (e.outcome === "complete" || e.outcome === "ctl_fail") {
          P[e.tgt].receive.arr++;
          if (e.outcome === "ctl_fail") P[e.tgt].receive.fail++;
        } else {                                  // failed: intercepted | out | loose
          if (e.jlane != null) {
            P[e.jlane].intercept.opp++;
            if (e.outcome === "intercepted") P[e.jlane].intercept.won++;
          }
          if (e.outcome === "out") T[t].out++;
        }
      } else if (e.type === "carry") {
        s.rates.carries++;
        const lb = e.len < BINS.carry[0] ? 0 : e.len < BINS.carry[1] ? 1 : e.len < BINS.carry[2] ? 2 : 3;
        s.carry_len.hist[lb]++;
        s.carry_keep.att++;
        if (e.outcome === "retained") s.carry_keep.kept++;
        for (const [dt, w] of e.contests) { P[dt].tackle.opp++; if (w) P[dt].tackle.won++; }
      } else if (e.type === "shot") {
        s.rates.shots++; T[t].shots++;
        s.shot_conv.att++;
        if (e.outcome === "goal") { s.shot_conv.goals++; T[t].goals++; }
        else if (e.outcome === "off") T[t].out++; // off-target → the `out` state too
        shotD[e.tid] += e.d;
      }
    }
  }
  players.forEach((p) => {
    const s = P[p.tid];
    s.shot_d_mean = s.shot_conv.att ? shotD[p.tid] / s.shot_conv.att : null;
  });
  return { players: P, team: T };
}

/* ------------------------------------------------------------ loss (§7) */
function famAS(attS, sucS, attR, sucR) {
  let acc = 0, sw = 0;
  for (let b = 0; b < attS.length; b++) {
    const pS = (sucS[b] + 1) / (attS[b] + 2), pR = (sucR[b] + 1) / (attR[b] + 2);
    const w = attR[b] / (attR[b] + 6);
    acc += w * (pS - pR) * (pS - pR); sw += w;
  }
  return acc / Math.max(sw, 1e-6);
}
function famHist(hS, hR) {                        // pipeline convention: one shared
  const K = hR.length;                            // weight w = tot_ref/(tot_ref+6)
  let tS = 0, tR = 0;
  for (let b = 0; b < K; b++) { tS += hS[b]; tR += hR[b]; }
  const w = tR / (tR + 6);
  let num = 0;
  for (let b = 0; b < K; b++) {
    const d = (hS[b] + 1) / (tS + K) - (hR[b] + 1) / (tR + K);
    num += w * d * d;
  }
  return num / Math.max(K * w, 1e-6);
}
function teamMetrics(st) {                        // [share, ppp, out100, gpg, spg]
  const tot = st.team[0].ticks + st.team[1].ticks;
  return st.team.map((t) => [t.ticks / Math.max(tot, 1), t.cmp / Math.max(t.n_poss, 1),
    100 * t.out / Math.max(t.dec, 1), t.goals / t.n_games, t.shots / t.n_games]);
}

export function loss(sim, ref) {                  // loss(simStats, refStats)
  const tids = Object.keys(ref.players);
  const famAcc = {};
  for (const k in LOSS_W) famAcc[k] = 0;
  const perPlayer = {};
  let Lp = 0;
  for (const tid of tids) {
    const s = sim.players[tid], r = ref.players[tid];
    const f = {
      pass_cmp:   famAS(s.pass_cmp.att, s.pass_cmp.suc, r.pass_cmp.att, r.pass_cmp.suc),
      carry_len:  famHist(s.carry_len.hist, r.carry_len.hist),
      carry_keep: famAS([s.carry_keep.att], [s.carry_keep.kept], [r.carry_keep.att], [r.carry_keep.kept]),
      shot_conv:  famAS([s.shot_conv.att], [s.shot_conv.goals], [r.shot_conv.att], [r.shot_conv.goals]),
      shot_rate:  famAS([s.rates.decisions], [s.rates.shots], [r.rates.decisions], [r.rates.shots]),
      carry_rate: famAS([s.rates.decisions], [s.rates.carries], [r.rates.decisions], [r.rates.carries]),
      pass_fwd:   famAS([s.pass_fwd.n], [s.pass_fwd.fwd], [r.pass_fwd.n], [r.pass_fwd.fwd]),
      intercept:  famAS([s.intercept.opp], [s.intercept.won], [r.intercept.opp], [r.intercept.won]),
      tackle:     famAS([s.tackle.opp], [s.tackle.won], [r.tackle.opp], [r.tackle.won]),
      ctl_fail:   famAS([s.receive.arr], [s.receive.fail], [r.receive.arr], [r.receive.fail]),
    };
    let pl = 0;
    for (const k in LOSS_W) { pl += LOSS_W[k] * f[k]; famAcc[k] += f[k]; }
    perPlayer[tid] = pl;
  }
  for (const k in LOSS_W) Lp += LOSS_W[k] * famAcc[k];
  Lp /= tids.length;
  let Lt = 0;
  const ms = teamMetrics(sim), mr = teamMetrics(ref);
  const nz = [TEAM_NORM.share, TEAM_NORM.ppp, TEAM_NORM.out100, TEAM_NORM.gpg, TEAM_NORM.spg];
  for (const t of [0, 1])
    for (let q = 0; q < 5; q++) Lt += (ms[t][q] - mr[t][q]) ** 2 / nz[q];
  Lt /= 2;
  const breakdown = {};
  for (const k in LOSS_W) breakdown[k] = 100 * LOSS_W[k] * famAcc[k] / tids.length;
  breakdown.team = 10 * Lt;
  return { total: 100 * (Lp + 0.10 * Lt), players: Lp, team: Lt, perPlayer, breakdown };
}

/* ------------------------------------------------------------ GA (§8) */
export class GA {
  constructor(data, { pop = 28, seed = 7, elitism = 2, k = 3 } = {}) {
    configureFromData(data);                      // simulate with the generator's physics
    this.data = data;
    this.players = data.players;
    this.ref = data.train.stats;
    this.valRef = data.val ? data.val.stats : null;
    this.pop = pop; this.elitism = elitism; this.k = k;
    this.G = this.players.length * 11;
    this.rng = mulberry32(seed);
    this.evalBase = 100000 + seed * 7919;         // CRN: base+gen·2, +1
    this.reBase = 500000 + seed * 104729;         // fresh seeds for champion re-eval
    this.dispBase = 700000 + seed * 15485863;     // display-loss seeds, never selected on
    this.valSeeds = [770001, 770002];             // fixed → comparable val curve
    this.matchSeed = 900001 + seed;
    this.gen = 0; this.matches = 0; this.champ = null;
    this.genomes = [];
    for (let p = 0; p < pop; p++) {
      const z = new Float64Array(this.G);
      for (let g = 0; g < this.G; g++) z[g] = 0.15 + 0.7 * this.rng();
      this.genomes.push(z);
    }
  }
  simStats(z, seeds) {
    const games = seeds.map((s) => {
      const g = playGame(this.players, z, s);
      this.matches++;
      return { events: g.events, meta: { score: g.score, possession: g.possession } };
    });
    return extract(games, this.players);
  }
  evalLoss(z, seeds) { return loss(this.simStats(z, seeds), this.ref); }
  tournament(fits) {
    let bi = 0, bv = Infinity;
    for (let n = 0; n < this.k; n++) {
      const i = Math.min(this.pop - 1, Math.floor(this.rng() * this.pop));
      if (fits[i] < bv) { bv = fits[i]; bi = i; }
    }
    return bi;
  }
  step({ games = 2 } = {}) {                      // one generation; returns summary
    const g = this.gen;
    const seeds = games >= 2 ? [this.evalBase + g * 2, this.evalBase + g * 2 + 1]
                             : [this.evalBase + g * 2];
    const fits = this.genomes.map((z) => this.evalLoss(z, seeds).total);
    const order = fits.map((f, i) => i).sort((a, b) => fits[a] - fits[b]);
    const best = fits[order[0]];
    const median = (fits[order[(this.pop - 1) >> 1]] + fits[order[this.pop >> 1]]) / 2;
    let champImproved = false;                    // re-eval kills lucky champions
    const re = this.evalLoss(this.genomes[order[0]], [this.reBase + g * 2, this.reBase + g * 2 + 1]);
    if (!this.champ || re.total < this.champ.loss) {
      // running-min drives selection but is winner's-curse biased ~1 sd low;
      // report an independent 2×2-game mean so the displayed loss is unbiased
      const db = this.dispBase + g * 4;
      const report = (this.evalLoss(this.genomes[order[0]], [db, db + 1]).total
                    + this.evalLoss(this.genomes[order[0]], [db + 2, db + 3]).total) / 2;
      this.champ = { z: Float64Array.from(this.genomes[order[0]]),
        loss: re.total, reportLoss: report, gen: g, breakdown: re.breakdown };
      champImproved = true;
    }
    const next = [];
    for (let e = 0; e < this.elitism; e++) next.push(Float64Array.from(this.genomes[order[e]]));
    const sg = 0.18 * Math.exp(-g / 140);
    while (next.length < this.pop) {
      const pa = this.genomes[this.tournament(fits)];
      const pb = this.genomes[this.tournament(fits)];
      const c = new Float64Array(this.G);
      for (let b = 0; b < this.players.length; b++) {
        const off = b * 11, r = this.rng();
        if (r < 0.3) {                            // blend the block, per-gene α (§8)
          for (let d = 0; d < 11; d++) {
            const al = this.rng();
            c[off + d] = al * pa[off + d] + (1 - al) * pb[off + d];
          }
        } else {                                  // swap whole block
          const src = this.rng() < 0.5 ? pa : pb;
          for (let d = 0; d < 11; d++) c[off + d] = src[off + d];
        }
      }
      for (let gi = 0; gi < this.G; gi++)
        if (this.rng() < 0.15) c[gi] = clamp(c[gi] + sg * randn(this.rng), 0, 1);
      next.push(c);
    }
    this.genomes = next;
    this.gen = g + 1;
    return { gen: g, best, median, champImproved };
  }
  valEval() {
    if (!this.champ || !this.valRef) return null;
    return loss(this.simStats(this.champ.z, this.valSeeds), this.valRef).total;
  }
  champMatch() {
    const g = playGame(this.players, this.champ.z, this.matchSeed + this.champ.gen * 7, { record: true });
    this.matches++;
    return g;
  }
  popFlat32() {
    const a = new Float32Array(this.pop * this.G);
    this.genomes.forEach((z, p) => a.set(z, p * this.G));
    return a;
  }
}

/* ------------------------------------------------------------ dataset (§4) */
export function generateDataset({ trainSeeds = [1001, 1002],
  valSeeds = [2001, 2002, 2003, 2004, 2005, 2006], thetaSeed = 22 } = {}) {
  const players = makePlayers();
  const ZT = thetaStar(players, thetaSeed);
  const play = (s) => {
    const g = playGame(players, ZT, s);
    return { seed: s, score: g.score, possession: g.possession, events: g.events };
  };
  const toGame = (g) => ({ events: g.events, meta: { score: g.score, possession: g.possession } });
  const tg = trainSeeds.map(play);
  const vg = valSeeds.map(play);
  const trainStats = extract(tg.map(toGame), players);
  const valStats = extract(vg.map(toGame), players);
  const noise = loss(trainStats, valStats).total; // same θ* both sides → noise floor
  return {
    version: 1, pitch: [PITCH_L, PITCH_W], dims: DIMS, players, bins: BINS,
    engine: { ...ENGINE },
    train: { games: tg, stats: trainStats },
    val: { n_games: valSeeds.length, scores: vg.map((g) => g.score), stats: valStats },
    noise_floor: noise,
    sealed: {
      theta_true: Object.fromEntries(players.map((p, i) =>
        [p.tid, Array.from(ZT.slice(i * 11, (i + 1) * 11)).map((v) => Math.round(v * 10000) / 10000)])),
      note: "ground truth — break the seal in the lab",
    },
  };
}
