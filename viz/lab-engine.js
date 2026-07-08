/* lab-engine.js — the possession graph v2: match engine · extractor · loss · GA.
 * SportSim transition-model spec v2 (§§1–3, 5–8 + laws of the game). Pure ES
 * module: no DOM, no network, deterministic given a seed (mulberry32 streams).
 * Mirrors pipeline/08_transitions.py — extractor and loss count IDENTICALLY,
 * and every tuned constant is read from the data file's `engine` block via
 * configureFromData(data): the live GA simulates with the same physics that
 * generated the data. Module defaults below are fallbacks.
 *
 * Ball = token on a stochastic transition graph; each player is an 11-dim
 * vector of conditional probability distributions (genotype z ∈ [0,1]^11,
 * phys = lo + z·(hi−lo)). Every transition is conditioned on the ANGLE and
 * DISTANCE the ball must travel:
 *   send    p_cmp = σ(acc_i − d/range_i − w_p·press − w_l·lane + w_c·ctl_m
 *                     − P_CMP_FWD·max(0,cos ang)·d/20)      ang vs attack dir
 *   execute miss endpoint from an error cone: θ' = θ + N(0,σθ²),
 *           σθ = STRAY_TH·(.5 + d/40); d' = d·(1 + STRAY_OVER + N(0,STRAY_POW²))
 *   receive p_ctl = σ(2.1 + ctl_m − .75·press_m − CTL_LONG·(d−18)⁺/10)
 *   steal   lane interceptor p_int = min(.9, INT_BASE + .5·lane·σ(int_j));
 *           a missed bite deflects w.p. DEFL_P·lane (defender = last touch)
 *   shoot   xg = σ(XG_BASE − .095·d + 2.2·ang_posts); p_goal = σ(logit xg + fin);
 *           misses split post/save/off; placement [dy,dz] sampled in the mouth
 * Laws of the game: a ball over the line is DEAD. The next tick is a restart
 * event by the right team at the right spot — throw-in (touchline, opponents
 * of last touch), corner (goal line, defender last touch), goal kick (goal
 * line, attacker last touch; off-target shots too), kickoff (after goals) —
 * each a tagged pass with its own delivery model (throw short+safe, goal kick
 * long, corner into the crowded box). Keeper duty: slot-0 sweeper guards the
 * goal mouth when the ball threatens (GK_ENGAGE), claims balls into the mouth,
 * holds saves (PARRY_P parried out → corner). Post hits rebound into play or
 * dead (POST_OUT → goal kick).
 * One decision per tick from softmax(U/τ), τ = 1/(0.5 + 1.5·vision):
 *   U_pass(m) = .10·min(open_m,15) + .045·risk·fwd_m − U_PASS_DIST·d − LANE·lane
 *   U_carry   = U_CARRY_BASE + 1.1·carry_bias + .05·min(space,15) − .45·press
 *   U_shoot   = −.8 + 2.6·shoot_bias + 3.5·xg   (only if d_goal < SHOT_MAX_D)
 * Carry: ≤6 substeps of 3.2 m toward .7·(goal−p) + .3·(p−nearest); contest
 * within 5 m: p_keep = σ(1.7 + drb_i − tkl_j − .35·press_loc), else .995.
 *
 * Extraction (§6): pure counting from SERIALIZED events; restart events count
 * only at team level (rst/cmp/out) — player families stay open-play-clean.
 * pass_dir = 3-bin |ang| histogram {fwd <π/4, lateral, back >3π/4}. Loss (§7):
 * Laplace p̂=(suc+1)/(att+2), hists (cnt+1)/(tot+K), bin weight att_ref/(att_ref+6)
 * (hists share tot_ref/(tot_ref+6), ÷ max(K·w,1e-6)); family weights + team
 * normalizers from the engine block; L = 100·(mean player loss + .10·team).
 * GA (§8): genome 12×11, pop 28, elitism 2, tournament k=3, per-block
 * crossover (blend p=.3 else swap p=.5), mutation p=.15 σ=.18·exp(−gen/140),
 * init U(.15,.85). CRN eval seeds base+gen·2,+1; champion = best-of-gen
 * re-evaluated on 2 fresh seeds, running best by re-eval loss.
 */

/* ------------------------------------------------------------ constants */
export const PITCH_L = 105, PITCH_W = 68;
export const GOAL_Y = [30.34, 37.66];
export const GOAL_CY = 34, GOAL_HW = 3.66, GOAL_H = 2.44;

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
  // decision layer (v1 §3 names kept; pipeline-tuned values arrive via configureFromData)
  tick: 2.0, T: 700, R_PRESS: 4.5, PRESS_HI: 0.55,
  CARRY_STEP: 3.2, MAX_CARRY_SUB: 6, CARRY_RECIDE: 0.45, SHOT_MAX_D: 30,
  INT_BASE: 0.32, SAVE_P: 0.42,
  U_PASS_OPEN: 0.10, U_PASS_RISK: 0.045, U_PASS_DIST: 0.030, U_PASS_LANE: 0.9,
  U_CARRY_BASE: 0.5, U_CARRY_BIAS: 1.1, U_CARRY_SPACE: 0.05, U_CARRY_PRESS: 0.45,
  U_SHOOT_BASE: -0.8, U_SHOOT_BIAS: 2.6, U_SHOOT_XG: 3.5,
  P_CMP_PRESS: 0.55, P_CMP_LANE: 1.1, P_CMP_CTL: 0.45,
  XG_BASE: -1.1, XG_D: 0.095, XG_ANG: 2.2,
  // v2 execution model — angle/distance conditioning
  P_CMP_BASE: 0.0,                    // completion recentering vs the v2 penalties
  P_CMP_FWD: 0.55,                    // forward-pass difficulty × d/20
  CTL_LONG: 0.5,                      // reception penalty per (d−18)⁺/10
  STRAY_TH: 0.20,                     // angular execution σ (rad) at scale (.5+d/40)
  STRAY_SK0: 1.7, STRAY_SK1: 0.3,     // ×(SK0 − SK1·acc): bad passers spray wider
  STRAY_POW: 0.22, STRAY_OVER: 0.12,  // power error σ + systematic overhit
  DEFL_P: 0.30, DEFL_SCATTER: 3.0,    // failed-bite deflection prob ×lane, scatter m
  // v2 shot placement + aftermath
  P_POST: 0.08,                       // of non-goal shots: woodwork
  PARRY_P: 0.25,                      // of saves: parried out → corner
  POST_OUT: 0.30,                     // of post hits: rebound dead → goal kick
  // v2 restarts
  THROW_MAX: 22, THROW_BONUS: 1.2,    // throw-in candidate radius, accuracy bonus
  KICK_RANGE: 1.5, KO_BONUS: 2.0,     // goal-kick range multiplier, kickoff bonus
  CORNER_BOX: 0.05,                   // corner delivery bonus per meter inside 25 of goal
  PUSH_KICK: 9.15, PUSH_THROW: 2.0,   // opponent retreat radii at dead balls
  RESTART_PULL: 0.85,                 // anchor pull during kick restarts
  // v2 keeper duty (slot-0 sweeper)
  GK_ENGAGE: 32, GK_DEPTH: 3.0, GK_WIDE: 7.0,
  // §7 team-term multiplier (v2: team families carry the strongest separation)
  TEAM_MULT: 0.10,
};

export const BINS = { pass_d: [12, 25], press_hi: ENGINE.PRESS_HI, carry: [3.5, 8, 15],
  ang: [Math.PI / 4, 3 * Math.PI / 4] };

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
/* tids per slot 0..5, ordered by rho[0]·attack_dir from out/evolution.json (§1) */
export const ROSTER = [[16, 9, 5, 2, 7, 0], [12, 14, 13, 3, 1, 10]];

export const LOSS_W = {                          // §7 defaults (pipeline overrides)
  pass_cmp: .28, carry_len: .16, carry_keep: .06, shot_conv: .08, shot_rate: .06,
  carry_rate: .06, pass_fwd: .06, pass_dir: .06, intercept: .08, tackle: .08, ctl_fail: .04,
};
export const TEAM_NORM = { share: 1, ppp: 25, out100: 100, gpg: 9, spg: 64 };

/* pipeline engine-block keys → ENGINE fields (Python names are canonical;
 * v2 keys share names on both sides) */
const ENGINE_MAP = {
  tick: "tick", T: "T", R_PRESS: "R_PRESS", PRESS_HI: "PRESS_HI",
  CARRY_STEP: "CARRY_STEP", MAX_CARRY_SUB: "MAX_CARRY_SUB",
  CARRY_RECIDE: "CARRY_RECIDE", SHOT_MAX_D: "SHOT_MAX_D",
  U_CARRY_BASE: "U_CARRY_BASE", P_INT_BASE: "INT_BASE", LANE_AVOID: "U_PASS_LANE",
  XG_BASE: "XG_BASE", PASS_DIST_COST: "U_PASS_DIST", SAVE_P: "SAVE_P",
  P_CMP_BASE: "P_CMP_BASE", P_CMP_FWD: "P_CMP_FWD", CTL_LONG: "CTL_LONG",
  STRAY_TH: "STRAY_TH", STRAY_SK0: "STRAY_SK0", STRAY_SK1: "STRAY_SK1",
  STRAY_POW: "STRAY_POW", STRAY_OVER: "STRAY_OVER", U_PASS_RISK: "U_PASS_RISK",
  TEAM_MULT: "TEAM_MULT",
  DEFL_P: "DEFL_P", DEFL_SCATTER: "DEFL_SCATTER",
  P_POST: "P_POST", PARRY_P: "PARRY_P", POST_OUT: "POST_OUT",
  THROW_MAX: "THROW_MAX", THROW_BONUS: "THROW_BONUS",
  KICK_RANGE: "KICK_RANGE", KO_BONUS: "KO_BONUS", CORNER_BOX: "CORNER_BOX",
  PUSH_KICK: "PUSH_KICK", PUSH_THROW: "PUSH_THROW", RESTART_PULL: "RESTART_PULL",
  GK_ENGAGE: "GK_ENGAGE", GK_DEPTH: "GK_DEPTH", GK_WIDE: "GK_WIDE",
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
    if (b.ang) BINS.ang = Array.from(b.ang);
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
const sig = (x) => x < -60 ? 0 : x > 60 ? 1 : 1 / (1 + Math.exp(-x));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

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
/* Corner-kick set pieces: preset box marks (meters from the attacked goal
 * line, pitch y). Attackers slots 3..5 crowd the spot, defenders 1..5 mark. */
const CORNER_ATK = [[16, 34], [9, 30.5], [11, 37.5]];   // slot 3,4,5
const CORNER_DEF = [[7.5, 31], [9.5, 34], [7.5, 37], [13, 34], [6, 34]]; // slot 1..5

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
  const sw = [mates[0].find((i) => players[i].slot === 0), mates[1].find((i) => players[i].slot === 0)];
  const gxOf = (t) => (t === 0 ? PITCH_L : 0);     // goal team t attacks
  const ownGx = (t) => (t === 0 ? 0 : PITCH_L);    // goal team t defends

  const P = players.map((p) => [p.anchor[0], p.anchor[1]]);
  let carrier = pm[0];                            // team 0 kicks off
  let pending = null;                             // {rtype, team, spot, taker, exit}
  const events = [], score = [0, 0], poss = [0, 0];
  const posRec = record ? new Float32Array(E.T * N * 2) : null;
  const ballRec = record ? new Float32Array(E.T * 2) : null;

  const dist = (i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const pressAt = (x, y, t) => {                  // Σ_opp exp(−d/R)
    let s = 0;
    for (const j of foes[t]) s += Math.exp(-Math.hypot(P[j][0] - x, P[j][1] - y) / E.R_PRESS);
    return s;
  };
  const looseWinner = (x, y) => {                 // nearest wins, tie noise N(0,1.5)
    let bi = 0, bv = Infinity;
    for (let i = 0; i < N; i++) {
      const v = Math.hypot(P[i][0] - x, P[i][1] - y) + 1.5 * randn(rng);
      if (v < bv) { bv = v; bi = i; }
    }
    return bi;
  };
  const nearestOf = (list, x, y) => {
    let bi = list[0], bv = Infinity;
    for (const i of list) {
      const v = Math.hypot(P[i][0] - x, P[i][1] - y);
      if (v < bv) { bv = v; bi = i; }
    }
    return bi;
  };
  const segExit = (x0, y0, x1, y1) => {           // first boundary crossing of p0→p1
    let t = 1;
    const dx = x1 - x0, dy = y1 - y0;
    if (x1 < 0 && dx < 0) t = Math.min(t, (0 - x0) / dx);
    if (x1 > PITCH_L && dx > 0) t = Math.min(t, (PITCH_L - x0) / dx);
    if (y1 < 0 && dy < 0) t = Math.min(t, (0 - y0) / dy);
    if (y1 > PITCH_W && dy > 0) t = Math.min(t, (PITCH_W - y0) / dy);
    return [x0 + dx * t, y0 + dy * t];
  };
  /* the laws: who restarts, what kind, from where. lastT = team of last touch */
  const award = (lastT, x0, y0, ex, ey) => {
    const EPS = 1e-6;
    let rtype, rteam, spot;
    if (ex <= EPS || ex >= PITCH_L - EPS) {       // over a goal line
      const defT = ex <= EPS ? 0 : 1;             // team 0 defends x=0
      if (lastT === defT) {                       // defender last touch → corner
        rtype = "corner"; rteam = 1 - defT;
        spot = [ex <= EPS ? 0 : PITCH_L, ey <= GOAL_CY ? 0 : PITCH_W];
      } else {                                    // attacker last touch → goal kick
        rtype = "goal_kick"; rteam = defT;
        spot = [defT === 0 ? 5.5 : PITCH_L - 5.5, ey <= GOAL_CY ? GOAL_CY - 9.16 : GOAL_CY + 9.16];
      }
    } else {                                      // over a touchline → throw-in
      rtype = "throw_in"; rteam = 1 - lastT;
      spot = [clamp(ex, 0.3, PITCH_L - 0.3), ey <= GOAL_CY ? 0 : PITCH_W];
    }
    const taker = rtype === "goal_kick" ? sw[rteam] : nearestOf(mates[rteam], spot[0], spot[1]);
    return { rtype, team: rteam, spot, taker, exit: [r2(ex), r2(ey)] };
  };

  /* shared pass resolution — open play and restarts. Returns the event;
   * mutates carrier / pending / P. opts: {restart, bonus, rangeMult} */
  const laneOf = (i, m) => {                      // max opp lane risk on segment i→m
    const sx = P[i][0], sy = P[i][1], dx = P[m][0] - sx, dy = P[m][1] - sy;
    const L2 = dx * dx + dy * dy || 1e-9;
    let best = 0, jl = -1;
    for (const j of foes[team[i]]) {
      const s = ((P[j][0] - sx) * dx + (P[j][1] - sy) * dy) / L2;
      if (s >= 0.08 && s <= 0.92) {
        const perp = Math.abs((P[j][0] - sx) * dy - (P[j][1] - sy) * dx) / Math.sqrt(L2);
        const lj = Math.exp(-perp / 2.5);
        if (lj > best) { best = lj; jl = j; }
      }
    }
    return [best, jl];
  };
  const resolvePass = (k, i, m, opts = {}) => {
    const atk = team[i], dA = atk === 0 ? 1 : -1;
    const p0 = [P[i][0], P[i][1]], q = [P[m][0], P[m][1]];
    const d = Math.hypot(q[0] - p0[0], q[1] - p0[1]) || 1e-9;
    const pressC = pressAt(p0[0], p0[1], atk);
    const [ln, jl] = laneOf(i, m);
    const ang = wrapPi(Math.atan2(q[1] - p0[1], q[0] - p0[0]) - (dA > 0 ? 0 : Math.PI));
    const fwdness = Math.max(0, Math.cos(ang));
    const ev = { k, type: "pass", tid: tid[i], x: r2(p0[0]), y: r2(p0[1]),
      tgt: tid[m], d: r2(d), ang: r3(ang), press: r3(pressC), lane: r3(ln),
      jlane: jl >= 0 ? tid[jl] : null, outcome: "" };
    if (opts.restart) ev.restart = opts.restart;
    const pCmp = sig(E.P_CMP_BASE + ph(i, 0) + (opts.bonus || 0) - d / (ph(i, 1) * (opts.rangeMult || 1))
      - E.P_CMP_PRESS * pressC - E.P_CMP_LANE * ln + E.P_CMP_CTL * ph(m, 10)
      - E.P_CMP_FWD * fwdness * (d / 20));
    /* finish a ball that ran free: kind = 'stray'|'deflect', from = touch point */
    const finishLoose = (from, e, lastT) => {
      if (e[0] < 0 || e[0] > PITCH_L || e[1] < 0 || e[1] > PITCH_W) {
        const [ex, ey] = segExit(from[0], from[1], e[0], e[1]);
        const EPS = 1e-6;
        const onGoalLine = ex <= EPS || ex >= PITCH_L - EPS;
        if (onGoalLine && ey > GOAL_Y[0] && ey < GOAL_Y[1]) {
          const defT = ex <= EPS ? 0 : 1;         // through the mouth → keeper claims
          ev.outcome = "keeper"; ev.end = [r2(ex), r2(ey)];
          carrier = sw[defT];
          ev.win = tid[carrier];
          P[carrier][0] = defT === 0 ? 1.5 : PITCH_L - 1.5;
          P[carrier][1] = clamp(ey, GOAL_Y[0], GOAL_Y[1]);
        } else {
          pending = award(lastT, from[0], from[1], ex, ey);
          ev.outcome = lastT === atk ? "out" : "deflected_out";
          ev.end = [r2(e[0]), r2(e[1])];
          ev.exit = pending.exit; ev.next = pending.rtype;
        }
      } else {
        ev.outcome = lastT === atk ? "loose" : "deflected";
        carrier = looseWinner(e[0], e[1]);
        ev.win = tid[carrier];
        P[carrier][0] = e[0]; P[carrier][1] = e[1];
        ev.end = [r2(e[0]), r2(e[1])];
      }
    };
    if (rng() < pCmp) {
      const pressM = pressAt(q[0], q[1], atk);
      const pCtl = sig(2.1 + ph(m, 10) - 0.75 * pressM - E.CTL_LONG * Math.max(0, d - 18) / 10);
      if (rng() < pCtl) { ev.outcome = "complete"; carrier = m; }
      else {                                      // loose at receiver; winner steps in
        ev.outcome = "ctl_fail"; carrier = looseWinner(q[0], q[1]);
        ev.win = tid[carrier];
        P[carrier][0] = q[0]; P[carrier][1] = q[1];
      }
    } else {
      let done = false;
      if (jl >= 0) {                              // lane interceptor gets a bite
        const pInt = Math.min(0.9, E.INT_BASE + 0.5 * ln * sig(ph(jl, 9)));
        if (rng() < pInt) { ev.outcome = "intercepted"; carrier = jl; done = true; }
        else if (rng() < E.DEFL_P * ln) {         // touched but not held → deflection
          const dx = q[0] - p0[0], dy = q[1] - p0[1];
          const s = clamp(((P[jl][0] - p0[0]) * dx + (P[jl][1] - p0[1]) * dy) / (d * d), 0.08, 0.92);
          const lp = [p0[0] + dx * s, p0[1] + dy * s];
          const e = [lp[0] + E.DEFL_SCATTER * randn(rng), lp[1] + E.DEFL_SCATTER * randn(rng)];
          finishLoose(lp, e, team[jl]);
          done = true;
        }
      }
      if (!done) {                                // execution error cone, skill-scaled
        const sTh = E.STRAY_TH * (0.5 + d / 40) * (E.STRAY_SK0 - E.STRAY_SK1 * ph(i, 0));
        const th = Math.atan2(q[1] - p0[1], q[0] - p0[0]) + sTh * randn(rng);
        const dd = Math.max(2, d * (1 + E.STRAY_OVER + E.STRAY_POW * randn(rng)));
        finishLoose(p0, [p0[0] + Math.cos(th) * dd, p0[1] + Math.sin(th) * dd], atk);
      }
    }
    return ev;
  };

  /* one restart tick: the pending dead ball is delivered */
  const doRestart = (k) => {
    const { rtype, team: rt, spot, taker } = pending;
    pending = null;
    let cand = mates[rt].filter((m) => m !== taker);
    const dA = rt === 0 ? 1 : -1, gx = gxOf(rt);
    const nearestCand = () => [nearestOf(cand, spot[0], spot[1])];
    if (rtype === "throw_in") {                     // arms only reach so far
      const c2 = cand.filter((m) => Math.hypot(P[m][0] - spot[0], P[m][1] - spot[1]) <= E.THROW_MAX);
      cand = c2.length ? c2 : nearestCand();
    } else if (rtype === "kickoff") {
      const c2 = cand.filter((m) => Math.hypot(P[m][0] - spot[0], P[m][1] - spot[1]) <= 18);
      cand = c2.length ? c2 : nearestCand();
    } else if (rtype === "corner") {                // crosses go to the crowd
      const c2 = cand.filter((m) => m !== sw[rt]
        && Math.hypot(gx - P[m][0], GOAL_CY - P[m][1]) <= 28);
      if (c2.length) cand = c2;
    }
    let best = cand[0], bu = -Infinity, wsum = 0;
    const us = cand.map((m) => {
      let open = Infinity;
      for (const j of foes[rt]) { const dd = dist(j, m); if (dd < open) open = dd; }
      const d = Math.hypot(P[m][0] - spot[0], P[m][1] - spot[1]);
      const fwd = dA * (P[m][0] - spot[0]);
      const [ln] = laneOf(taker, m);
      let U = E.U_PASS_OPEN * Math.min(open, 15) + E.U_PASS_RISK * ph(taker, 3) * fwd
        - E.U_PASS_DIST * d - E.U_PASS_LANE * ln;
      if (rtype === "corner") {                   // crosses aim for the box
        const dgm = Math.hypot(gx - P[m][0], GOAL_CY - P[m][1]);
        U += E.CORNER_BOX * Math.max(0, 25 - dgm);
      }
      return U;
    });
    const tau = 1 / (0.5 + 1.5 * ph(taker, 2));
    let umax = -Infinity;
    for (const u of us) if (u > umax) umax = u;
    const ws = us.map((u) => { const w = Math.exp((u - umax) / tau); wsum += w; return w; });
    let r = rng() * wsum;
    best = cand[cand.length - 1];
    for (let c = 0; c < cand.length; c++) { r -= ws[c]; if (r <= 0) { best = cand[c]; break; } }
    const opts = rtype === "throw_in" ? { restart: rtype, bonus: E.THROW_BONUS, rangeMult: 0.75 }
      : rtype === "goal_kick" ? { restart: rtype, bonus: 0.3, rangeMult: E.KICK_RANGE }
      : rtype === "kickoff" ? { restart: rtype, bonus: E.KO_BONUS, rangeMult: 1 }
      : { restart: rtype, bonus: 0, rangeMult: 1.2 };
    return resolvePass(k, taker, best, opts);
  };

  /* -------------------------------------------------------- the ticks */
  for (let k = 0; k < E.T; k++) {
    const atk = pending ? pending.team : team[carrier];
    const dA = atk === 0 ? 1 : -1;
    poss[atk]++;

    /* -- movement phase ----------------------------------------------- */
    if (pending && pending.rtype === "kickoff") {
      for (let i = 0; i < N; i++) { P[i][0] = A[i][0]; P[i][1] = A[i][1]; }
      P[pending.taker][0] = pending.spot[0]; P[pending.taker][1] = pending.spot[1];
      const st = mates[pending.team].find((m) => players[m].slot === 5);
      if (st != null && st !== pending.taker) {     // a mate stands in for the tap
        P[st][0] = pending.spot[0] - (pending.team === 0 ? 1 : -1) * 2.5;
        P[st][1] = pending.spot[1] + 1.5;
      }
    } else {
      const bref = pending ? pending.spot : P[carrier];
      const prog = clamp(dA * (bref[0] - 52.5) / 52.5, 0, 1);
      const isCorner = pending && pending.rtype === "corner";
      const basePull = pending && pending.rtype !== "throw_in" ? E.RESTART_PULL : 0.4;
      let helpers = null;                           // throw-in: 2 mates come short
      if (pending && pending.rtype === "throw_in") {
        helpers = mates[pending.team].filter((m) => m !== pending.taker)
          .map((m) => [Math.hypot(P[m][0] - pending.spot[0], P[m][1] - pending.spot[1]), m])
          .sort((a, b) => a[0] - b[0]).slice(0, 2).map((x) => x[1]);
      }
      for (let i = 0; i < N; i++) {
        let pull = basePull;
        let tx, ty = A[i][1];
        if (team[i] === atk) tx = A[i][0] + dA * (2 + 7 * prog);
        else { const dD = team[i] === 0 ? 1 : -1; tx = A[i][0] - dD * (1 + 5 * prog); }
        if (players[i].slot === 0) {              // keeper duty near own goal
          const og = ownGx(team[i]);
          if (Math.hypot(bref[0] - og, bref[1] - GOAL_CY) < E.GK_ENGAGE) {
            tx = og + (team[i] === 0 ? 1 : -1) * E.GK_DEPTH;
            ty = clamp(bref[1], GOAL_CY - E.GK_WIDE, GOAL_CY + E.GK_WIDE);
          }
        }
        if (isCorner && i !== pending.taker) {    // crowd the box
          const cgx = gxOf(pending.team);
          const fromLine = (m) => (cgx === 0 ? m : PITCH_L - m);
          if (team[i] === pending.team && players[i].slot >= 3) {
            const s = CORNER_ATK[players[i].slot - 3];
            tx = fromLine(s[0]); ty = s[1];
          } else if (team[i] !== pending.team && players[i].slot >= 1) {
            const s = CORNER_DEF[players[i].slot - 1];
            tx = fromLine(s[0]); ty = s[1];
          }
        }
        if (helpers && helpers.includes(i)) {       // short options for the thrower
          const h = helpers.indexOf(i);
          const inf = pending.spot[1] <= GOAL_CY ? 1 : -1;
          tx = clamp(pending.spot[0] + (h ? -9 : 7), 1, PITCH_L - 1);
          ty = pending.spot[1] + inf * (h ? 8 : 5);
          pull = 0.8;
        }
        P[i][0] += pull * (tx - P[i][0]) + 1.1 * randn(rng);
        P[i][1] += pull * (ty - P[i][1]) + 1.1 * randn(rng);
      }
      if (!pending) {                             // 2 nearest defenders converge, cap 6 m
        const bx = P[carrier][0], by = P[carrier][1];
        const near = foes[atk].map((j) => [Math.hypot(P[j][0] - bx, P[j][1] - by), j]).sort((a, b) => a[0] - b[0]);
        for (let n = 0; n < 2; n++) {
          const j = near[n][1];
          let cx = 0.5 * (bx - P[j][0]), cy = 0.5 * (by - P[j][1]);
          const cl = Math.hypot(cx, cy);
          if (cl > 6) { cx *= 6 / cl; cy *= 6 / cl; }
          P[j][0] += cx; P[j][1] += cy;
        }
      }
      for (let i = 0; i < N; i++) { P[i][0] = clamp(P[i][0], 0, PITCH_L); P[i][1] = clamp(P[i][1], 0, PITCH_W); }
      if (pending) {                              // taker to the spot, laws of distance
        P[pending.taker][0] = pending.spot[0]; P[pending.taker][1] = pending.spot[1];
        const R = pending.rtype === "throw_in" ? E.PUSH_THROW : E.PUSH_KICK;
        for (const j of foes[pending.team]) {
          const vx = P[j][0] - pending.spot[0], vy = P[j][1] - pending.spot[1];
          const dj = Math.hypot(vx, vy);
          if (dj < R) {
            const s = dj > 1e-6 ? R / dj : 0;
            P[j][0] = clamp(pending.spot[0] + (dj > 1e-6 ? vx * s : R * -Math.sign(pending.spot[0] - 52.5 || 1)), 0, PITCH_L);
            P[j][1] = clamp(pending.spot[1] + (dj > 1e-6 ? vy * s : 0), 0, PITCH_W);
          }
        }
      }
    }

    /* -- event phase ---------------------------------------------------- */
    let ev;
    if (pending) {
      ev = doRestart(k);
    } else {
      const i = carrier;
      const pressC = pressAt(P[i][0], P[i][1], atk);
      const acts = [];
      for (const m of mates[atk]) if (m !== i) {
        let open = Infinity;
        for (const j of foes[atk]) { const dd = dist(j, m); if (dd < open) open = dd; }
        const fwd = dA * (P[m][0] - P[i][0]);
        const d = dist(i, m);
        const [ln] = laneOf(i, m);
        acts.push({ kind: 0, m,
          U: E.U_PASS_OPEN * Math.min(open, 15) + E.U_PASS_RISK * ph(i, 3) * fwd
             - E.U_PASS_DIST * d - E.U_PASS_LANE * ln });
      }
      const gx = gxOf(atk), gy = GOAL_CY;
      {
        const dgx = gx - P[i][0], dgy = gy - P[i][1], gl = Math.hypot(dgx, dgy) || 1e-9;
        const ux = dgx / gl, uy = dgy / gl;
        let space = 15;
        for (const j of foes[atk]) {              // nearest opp in ±45° cone to goal
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

      if (act.kind === 0) {                       // PASS
        ev = resolvePass(k, i, act.m, {});
      } else if (act.kind === 1) {                // CARRY
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
          len += Math.hypot(nx - cx, ny - cy);    // path length, post-clip steps
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
          if (!kept) {                            // uncontested stumble also → nearest opp
            outcome = "tackled"; tkl = tid[cj]; carrier = cj;
            break;
          }
          if (edge) break;
          if (rng() < E.CARRY_RECIDE) break;      // re-decide next tick
        }
        P[i][0] = cx; P[i][1] = cy;
        ev = { k, type: "carry", tid: tid[i], x: r2(sx), y: r2(sy),
          len: r2(len), press: r3(pressC), outcome, contests, tkl };
      } else {                                    // SHOT — placement in the mouth
        let outcome;
        const extra = {};
        let place;
        if (rng() < sig(xgl + ph(i, 6))) {
          outcome = "goal"; score[atk]++;
          place = [(0.35 + 0.6 * rng()) * GOAL_HW * (rng() < 0.5 ? -1 : 1),
                   0.2 + 1.7 * rng() * rng()];
          pending = { rtype: "kickoff", team: 1 - atk, spot: [52.5, 34], taker: pm[1 - atk],
                      exit: null };
        } else if (rng() < E.P_POST) {
          outcome = "post";
          const bar = rng() < 0.28;
          place = bar ? [(rng() * 2 - 1) * (GOAL_HW - 0.4), GOAL_H]
                      : [(rng() < 0.5 ? -1 : 1) * GOAL_HW, 0.4 + 1.6 * rng()];
          extra.post = bar ? "bar" : place[0] < 0 ? "left" : "right";
          if (rng() < E.POST_OUT) {               // rebound dead behind → goal kick
            extra.after = "out";
            const defT = 1 - atk;
            pending = { rtype: "goal_kick", team: defT,
              spot: [defT === 0 ? 5.5 : PITCH_L - 5.5,
                     place[0] <= 0 ? GOAL_CY - 9.16 : GOAL_CY + 9.16],
              taker: sw[defT], exit: [r2(gx), r2(GOAL_CY + place[0])] };
          } else {                                // rebound lives — scramble
            const dirB = atk === 0 ? -1 : 1;
            const rb = [clamp(gx + dirB * (4 + 9 * rng()), 0.5, PITCH_L - 0.5),
                        clamp(GOAL_CY + place[0] * 2 + 4 * randn(rng), 0.5, PITCH_W - 0.5)];
            carrier = looseWinner(rb[0], rb[1]);
            P[carrier][0] = rb[0]; P[carrier][1] = rb[1];
            extra.reb = [r2(rb[0]), r2(rb[1])];
            extra.win = tid[carrier];
          }
        } else if (rng() < E.SAVE_P) {
          outcome = "save";
          place = [(rng() * 2 - 1) * 1.8, 0.15 + 1.6 * rng()];
          const gk = sw[1 - atk];
          if (rng() < E.PARRY_P) {                // parried behind → corner
            extra.parry = 1;
            pending = { rtype: "corner", team: atk,
              spot: [gx, place[0] <= 0 ? 0 : PITCH_W],
              taker: -1, exit: [r2(gx), r2(GOAL_CY + place[0])] };
            pending.taker = nearestOf(mates[atk].filter((m) => m !== sw[atk]),
              pending.spot[0], pending.spot[1]);
          } else {                                // keeper holds
            carrier = gk;
            extra.win = tid[gk];
            P[gk][0] = gx === 0 ? 2 : PITCH_L - 2;
            P[gk][1] = clamp(GOAL_CY + place[0], GOAL_Y[0], GOAL_Y[1]);
          }
        } else {
          outcome = "off";
          const wide = rng() < 0.72;
          place = wide ? [(GOAL_HW + 0.5 + 2.4 * rng()) * (rng() < 0.5 ? -1 : 1), 0.3 + 1.6 * rng()]
                       : [(rng() * 2 - 1) * (GOAL_HW + 1), GOAL_H + 0.3 + 1.3 * rng()];
          const defT = 1 - atk;
          pending = { rtype: "goal_kick", team: defT,
            spot: [defT === 0 ? 5.5 : PITCH_L - 5.5,
                   place[0] <= 0 ? GOAL_CY - 9.16 : GOAL_CY + 9.16],
            taker: sw[defT], exit: [r2(gx), r2(clamp(GOAL_CY + place[0], 0, PITCH_W))] };
        }
        ev = { k, type: "shot", tid: tid[i], x: r2(P[i][0]), y: r2(P[i][1]),
          d: r2(act.d), ang: r3(act.ang), press: r3(pressC), outcome,
          place: [r2(place[0]), r2(place[1])], ...extra };
      }
    }
    events.push(ev);

    if (record) {
      for (let q = 0; q < N; q++) { posRec[(k * N + q) * 2] = P[q][0]; posRec[(k * N + q) * 2 + 1] = P[q][1]; }
      const bp = pending ? (pending.exit || pending.spot) : P[carrier];
      ballRec[k * 2] = bp[0]; ballRec[k * 2 + 1] = bp[1];
    }
  }
  return { events, score, possession: poss, positions: posRec, ball: ballRec };
}

/* ------------------------------------------------------------ extraction (§6) */
function pInit() {
  return {
    pass_cmp: { att: [0, 0, 0, 0, 0, 0], suc: [0, 0, 0, 0, 0, 0] },
    pass_fwd: { n: 0, fwd: 0 },
    pass_dir: { hist: [0, 0, 0] },
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
const INT_OPPS = new Set(["intercepted", "out", "loose", "deflected", "deflected_out", "keeper"]);

export function extract(games, players) {       // pure counting — never smoothed
  // Counts ONLY from serialized events (determinism contract with the pipeline).
  // Restart events (throw-in/corner/goal kick/kickoff) count at TEAM level only
  // — player families measure open play. Team block = raw counts.
  const P = {}, teamOf = {}, shotD = {};
  players.forEach((p) => { P[p.tid] = pInit(); teamOf[p.tid] = p.team; shotD[p.tid] = 0; });
  const T = [0, 1].map(() => ({ ticks: 0, n_poss: 0, cmp: 0, out: 0, dec: 0,
    goals: 0, shots: 0, n_games: games.length,
    rst: { throw_in: 0, corner: 0, goal_kick: 0, kickoff: 0 } }));
  for (const g of games) {
    let run = null;                               // possession = maximal same-team run
    for (const e of g.events) {
      const s = P[e.tid], t = teamOf[e.tid];
      T[t].ticks++; T[t].dec++;
      if (t !== run) { T[t].n_poss++; run = t; }
      if (e.type === "pass") {
        if (e.restart) {                          // dead-ball delivery: team level only
          T[t].rst[e.restart]++;
          if (e.outcome === "complete") T[t].cmp++;
          if (e.outcome === "out" || e.outcome === "deflected_out") T[t].out++;
          continue;
        }
        s.rates.decisions++;
        s.rates.passes++;
        const db = e.d < BINS.pass_d[0] ? 0 : e.d < BINS.pass_d[1] ? 1 : 2;
        const bi = db * 2 + (e.press >= BINS.press_hi ? 1 : 0);
        s.pass_cmp.att[bi]++;
        const ab = Math.abs(e.ang);
        s.pass_dir.hist[ab < BINS.ang[0] ? 0 : ab <= BINS.ang[1] ? 1 : 2]++;
        s.pass_fwd.n++;                           // attack-dir meters, from d·cos(ang)
        if (e.d * Math.cos(e.ang) > 2) s.pass_fwd.fwd++;
        if (e.outcome === "complete") { s.pass_cmp.suc[bi]++; T[t].cmp++; }
        if (e.outcome === "complete" || e.outcome === "ctl_fail") {
          P[e.tgt].receive.arr++;
          if (e.outcome === "ctl_fail") P[e.tgt].receive.fail++;
        } else {
          if (e.jlane != null && INT_OPPS.has(e.outcome)) {
            P[e.jlane].intercept.opp++;
            if (e.outcome === "intercepted") P[e.jlane].intercept.won++;
          }
          if (e.outcome === "out" || e.outcome === "deflected_out") T[t].out++;
        }
      } else if (e.type === "carry") {
        s.rates.decisions++;
        s.rates.carries++;
        const lb = e.len < BINS.carry[0] ? 0 : e.len < BINS.carry[1] ? 1 : e.len < BINS.carry[2] ? 2 : 3;
        s.carry_len.hist[lb]++;
        s.carry_keep.att++;
        if (e.outcome === "retained") s.carry_keep.kept++;
        for (const [dt, w] of e.contests) { P[dt].tackle.opp++; if (w) P[dt].tackle.won++; }
      } else if (e.type === "shot") {
        s.rates.decisions++;
        s.rates.shots++; T[t].shots++;
        s.shot_conv.att++;
        if (e.outcome === "goal") { s.shot_conv.goals++; T[t].goals++; }
        else if (e.outcome === "off" || (e.outcome === "post" && e.after === "out"))
          T[t].out++;                             // dead behind → the out state
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
      pass_dir:   famHist(s.pass_dir.hist, r.pass_dir.hist),
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
  const TM = ENGINE.TEAM_MULT;
  const breakdown = {};
  for (const k in LOSS_W) breakdown[k] = 100 * LOSS_W[k] * famAcc[k] / tids.length;
  breakdown.team = 100 * TM * Lt;
  return { total: 100 * (Lp + TM * Lt), players: Lp, team: Lt, perPlayer, breakdown };
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
    version: 2, pitch: [PITCH_L, PITCH_W], dims: DIMS, players, bins: BINS,
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
