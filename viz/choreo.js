/* choreo.js — the ball's kinematic interpreter. Engine v2 emits one EVENT per
 * 2 s tick (pass / carry / shot / restart) plus per-tick piece positions; this
 * module turns that discrete stream into a continuous ball trajectory with
 * flight times, arcs, dead-ball ceremonies and restart glides. Shared by the
 * 2D lab board (lab.js) and the 3D theater (match.js). Pure ES module.
 *
 * Sampling contract — ballAt(t), t in float ticks:
 *   { mode: 'held'|'flight'|'dead', held: playerIndex|null, x, y, z }
 *   'held'  → the renderer glues the ball to ITS OWN interpolated piece
 *             position for `held` (choreo x/y are tick-resolution fallbacks);
 *   'flight'/'dead' → x/y/z are authoritative (z in meters above turf).
 * shotAt(k) → launch spec for the physics layer (theater): the engine already
 * decided the outcome; the spec aims the ball so physics reproduces it.
 * paceOf(k) → relative tick duration (theater dilates ceremonies).
 */

export const PITCH_L = 105, PITCH_W = 68;
export const GOAL_CY = 34, GOAL_HW = 3.66, GOAL_H = 2.44;

/* ball speeds (m/s) and arc peaks (m) per delivery kind */
const SPEED = { pass: 16, throw_in: 11, corner: 21, goal_kick: 23, kickoff: 13, shot: 26 };
const ARC = {
  pass: (d) => (d < 14 ? 0.35 : Math.min(0.12 * d, 4.2)),
  throw_in: () => 2.4,
  corner: (d) => Math.min(0.22 * d, 6.5),
  goal_kick: (d) => Math.min(0.16 * d, 9),
  kickoff: () => 0.6,
};
const lerp = (a, b, s) => a + (b - a) * s;
const easeOut = (s) => 1 - (1 - s) * (1 - s);

export class Choreo {
  /* match: {events, positions Float32Array(T·N·2), ball Float32Array(T·2)} */
  constructor(match, players, engine) {
    this.T = engine.T; this.N = players.length;
    this.tick = engine.tick;
    this.pos = match.positions;
    this.events = match.events;
    this.idxOfTid = {};
    players.forEach((p, i) => { this.idxOfTid[p.tid] = i; });
    this.teamOfTid = {};
    players.forEach((p) => { this.teamOfTid[p.tid] = p.team; });
    this.gxOf = (team) => (team === 0 ? PITCH_L : 0);   // goal that team attacks
    this.rows = this.#build(players);
  }
  posAt(k, i) {
    const o = (Math.min(k, this.T - 1) * this.N + i) * 2;
    return [this.pos[o], this.pos[o + 1]];
  }

  #build(players) {
    const rows = new Array(this.T);
    const pm0 = players.findIndex((p) => p.team === 0 && p.slot === 3);
    let holder = pm0;                       // team 0 playmaker kicks off
    let rest = this.posAt(0, pm0);          // ball rest point at tick end
    for (let k = 0; k < this.T; k++) {
      const ev = this.events[k];
      if (!ev) { rows[k] = { ev: null, holder0: holder, holder1: holder, rest }; continue; }
      const idx = (tid) => this.idxOfTid[tid];
      const row = { ev, holder0: holder ?? idx(ev.tid), prevRest: rest };
      const i = idx(ev.tid);
      row.holder0 = ev.restart ? i : (holder ?? i);

      if (ev.type === "pass") {
        const kind = ev.restart || "pass";
        const src = [ev.x, ev.y];
        row.kind = kind; row.src = src;
        /* ceremony windows: [0,glide) ball fetched to the spot, [glide,s0) set,
         * launch at s0. Kickoffs glide longer (net → center circle). */
        row.glide = ev.restart ? (kind === "kickoff" ? 0.5 : 0.28) : 0;
        row.s0 = ev.restart ? (kind === "kickoff" ? 0.62 : 0.4) : 0.18;
        const tgt = this.posAt(k, idx(ev.tgt));
        /* flight endpoint + second legs by outcome */
        let end = tgt, leg2 = null, frac = 1;
        if (ev.outcome === "intercepted") {
          const j = this.posAt(k, idx(ev.jlane));
          const dx = tgt[0] - src[0], dy = tgt[1] - src[1];
          const L2 = dx * dx + dy * dy || 1e-9;
          frac = Math.max(0.08, Math.min(0.92, ((j[0] - src[0]) * dx + (j[1] - src[1]) * dy) / L2));
          end = [src[0] + dx * frac, src[1] + dy * frac];
        } else if (ev.outcome === "deflected" || ev.outcome === "deflected_out") {
          const j = this.posAt(k, idx(ev.jlane));
          const dx = tgt[0] - src[0], dy = tgt[1] - src[1];
          const L2 = dx * dx + dy * dy || 1e-9;
          frac = Math.max(0.08, Math.min(0.92, ((j[0] - src[0]) * dx + (j[1] - src[1]) * dy) / L2));
          end = [src[0] + dx * frac, src[1] + dy * frac];
          leg2 = ev.outcome === "deflected" ? ev.end
               : [ev.exit[0] + (ev.exit[0] <= 0 ? -1.2 : ev.exit[0] >= PITCH_L ? 1.2 : 0),
                  ev.exit[1] + (ev.exit[1] <= 0 ? -1.2 : ev.exit[1] >= PITCH_W ? 1.2 : 0)];
        } else if (ev.outcome === "out") {
          /* fly the executed (errored) trajectory, come to rest just beyond the line */
          const over = [ev.exit[0] + (ev.exit[0] <= 0 ? -1.5 : ev.exit[0] >= PITCH_L ? 1.5 : 0),
                        ev.exit[1] + (ev.exit[1] <= 0 ? -1.5 : ev.exit[1] >= PITCH_W ? 1.5 : 0)];
          end = over;
        } else if (ev.outcome === "loose" || ev.outcome === "keeper" || ev.outcome === "ctl_fail") {
          end = ev.outcome === "ctl_fail" ? tgt : ev.end;
        }
        row.end = end; row.leg2 = leg2;
        const d = Math.hypot(end[0] - src[0], end[1] - src[1]);
        row.f = Math.max(0.12, Math.min(1 - row.s0 - 0.05, d / SPEED[kind] / this.tick));
        row.arc = ARC[kind](d) * (ev.outcome === "out" || ev.outcome === "loose" ? 1 : frac);
        const dead = ev.outcome === "out" || ev.outcome === "deflected_out";
        row.holder1 = dead ? null
          : ev.outcome === "complete" ? idx(ev.tgt)
          : ev.outcome === "intercepted" ? idx(ev.jlane)
          : ev.win != null ? idx(ev.win) : row.holder0;
        row.rest = dead ? (leg2 || end) : null;
      } else if (ev.type === "carry") {
        row.kind = "carry";
        row.holder1 = ev.outcome === "tackled" ? idx(ev.tkl) : row.holder0;
        row.swap = ev.outcome === "tackled" ? 0.8 : null;
      } else {                                        // shot
        row.kind = "shot";
        const team = this.teamOfTid[ev.tid];
        const gx = this.gxOf(team);
        const dirIn = gx === 0 ? -1 : 1;              // outward normal is −dirIn
        row.src = [ev.x, ev.y];
        row.s0 = 0.15;
        row.plane = [gx, GOAL_CY + ev.place[0], Math.max(0.05, ev.place[1])];
        const d3 = Math.hypot(gx - ev.x, row.plane[1] - ev.y, row.plane[2]);
        row.f = Math.max(0.1, Math.min(0.55, d3 / SPEED.shot / this.tick));
        row.holder1 = null;
        if (ev.outcome === "goal") {
          row.after = { kind: "net", to: [gx + dirIn * 1.4, row.plane[1], 0.14] };
          row.rest = row.after.to;
        } else if (ev.outcome === "post") {
          if (ev.after === "out") {
            row.after = { kind: "reb", to: [gx - dirIn * 2.2, row.plane[1] + (ev.place[0] <= 0 ? -2 : 2), 0] };
            row.rest = row.after.to;
          } else {
            row.after = { kind: "reb", to: [ev.reb[0], ev.reb[1], 0] };
            row.holder1 = idx(ev.win);
          }
        } else if (ev.outcome === "save") {
          row.plane[0] = gx + dirIn * 1.1;            // stopped in front of the line
          if (ev.parry) {
            row.after = { kind: "reb", to: [gx - dirIn * 1.8, ev.place[0] <= 0 ? GOAL_CY - 8 : GOAL_CY + 8, 0] };
            row.rest = row.after.to;
          } else row.holder1 = idx(ev.win);
        } else {                                      // off — sails out
          row.plane[0] = gx - dirIn * 3.5;
          row.after = null;
          row.rest = [row.plane[0], row.plane[1], 0];
        }
      }
      holder = row.holder1;
      rest = row.rest ? [row.rest[0], row.rest[1]] : (holder != null ? this.posAt(k, holder) : rest);
      rows[k] = row;
    }
    return rows;
  }

  /* ------------------------------------------------------------ sampling */
  ballAt(t) {
    const k = Math.max(0, Math.min(Math.floor(t), this.T - 1));
    const s = t - k;
    const row = this.rows[k];
    if (!row || !row.ev) return { mode: "held", held: row ? row.holder0 : 0, x: 0, y: 0, z: 0 };
    const held = (idx2) => {
      const p = this.posAt(k, idx2);
      return { mode: "held", held: idx2, x: p[0], y: p[1], z: 0 };
    };
    const ev = row.ev;
    if (row.kind === "carry")
      return held(row.swap != null && s >= row.swap ? row.holder1 : row.holder0);

    if (row.kind === "shot") {
      const s0 = row.s0, f = row.f;
      if (s < s0) return held(row.holder0);
      const src = row.src, pl = row.plane;
      if (s < s0 + f) {
        const u = (s - s0) / f;
        return { mode: "flight", held: null,
          x: lerp(src[0], pl[0], u), y: lerp(src[1], pl[1], u),
          z: lerp(0.2, pl[2], u) + 1.1 * Math.sin(Math.PI * u) * (row.f > 0.3 ? 1 : 0.4) };
      }
      if (row.after) {                                // net bulge / rebound
        const u = Math.min(1, (s - s0 - f) / 0.3);
        const to = row.after.to;
        return { mode: row.holder1 != null && u >= 1 ? "held" : row.after.kind === "net" || row.rest ? (u >= 1 ? "dead" : "flight") : "flight",
          held: row.holder1 != null && u >= 1 ? row.holder1 : null,
          x: lerp(pl[0], to[0], easeOut(u)), y: lerp(pl[1], to[1], easeOut(u)),
          z: Math.max(0, lerp(pl[2], to[2], u)) };
      }
      if (row.holder1 != null) return held(row.holder1);
      return { mode: "dead", held: null, x: row.rest[0], y: row.rest[1], z: 0 };
    }

    /* pass family (incl. restarts) */
    const s0 = row.s0, f = row.f;
    if (ev.restart && s < row.glide) {                // the ball is fetched to the spot
      const u = easeOut(s / row.glide), pr = row.prevRest;
      return { mode: "dead", held: null,
        x: lerp(pr[0], row.src[0], u), y: lerp(pr[1], row.src[1], u), z: 0 };
    }
    if (s < s0) return ev.restart
      ? { mode: "dead", held: null, x: row.src[0], y: row.src[1], z: 0 }
      : held(row.holder0);
    const legTotal = row.leg2 ? f + 0.25 : f;
    if (s < s0 + f) {
      const u = (s - s0) / f;
      return { mode: "flight", held: null,
        x: lerp(row.src[0], row.end[0], u), y: lerp(row.src[1], row.end[1], u),
        z: row.arc * 4 * u * (1 - u) + 0.12 };
    }
    if (row.leg2 && s < s0 + legTotal) {              // deflection second leg
      const u = (s - s0 - f) / 0.25;
      return { mode: "flight", held: null,
        x: lerp(row.end[0], row.leg2[0], u), y: lerp(row.end[1], row.leg2[1], u),
        z: Math.max(0.1, 0.8 * (1 - u)) };
    }
    if (row.holder1 != null) return held(row.holder1);
    const r = row.rest || row.end;
    return { mode: "dead", held: null, x: r[0], y: r[1], z: 0 };
  }

  /* physics hand-off for the theater: engine-decided outcome, exact aim point */
  shotAt(k) {
    const row = this.rows[k];
    if (!row || row.kind !== "shot") return null;
    const ev = row.ev;
    return { k, ev, src: row.src, s0: row.s0, f: row.f,
      target: [row.plane[0], row.plane[1], row.plane[2]],
      outcome: ev.outcome, post: ev.post || null, parry: !!ev.parry,
      after: row.after, holder1: row.holder1 };
  }

  paceOf(k) {
    const ev = this.events[k];
    if (!ev) return 1;
    if (ev.type === "shot") return ev.outcome === "goal" ? 2.2 : 1.5;
    if (ev.restart === "kickoff") return 1.7;
    if (ev.restart === "corner") return 1.8;
    if (ev.restart) return 1.4;
    if (ev.outcome === "out" || ev.outcome === "deflected_out") return 1.3;
    return 1;
  }
}

/* ---------------------------------------------------- shared caption text */
const RESTART_NAME = { throw_in: "throw-in", corner: "corner", goal_kick: "goal kick", kickoff: "kick-off" };
export function captionOf(ev, nm, teamName) {
  if (!ev) return "";
  if (ev.type === "pass") {
    const verb = ev.d < 12 ? "slips it to" : ev.d < 25 ? "finds" : "threads long toward";
    const lead = ev.restart
      ? `${RESTART_NAME[ev.restart]} — ${teamName(ev.tid)} · ${nm(ev.tid)} `
      : `${nm(ev.tid)} `;
    switch (ev.outcome) {
      case "complete": return lead + `${ev.restart ? "delivers to" : verb} ${nm(ev.tgt)} — ${Math.round(ev.d)} m`;
      case "ctl_fail": return lead + `→ ${nm(ev.tgt)} can't tame the delivery`;
      case "intercepted": return lead + `— cut out by ${nm(ev.jlane)}`;
      case "deflected": return lead + `— deflected by ${nm(ev.jlane)}, loose ball`;
      case "deflected_out": return lead + `— deflected behind by ${nm(ev.jlane)} · ${RESTART_NAME[ev.next]} coming`;
      case "out": return lead + `overhits — ball out · ${RESTART_NAME[ev.next]} coming`;
      case "keeper": return lead + `— claimed by the keeper`;
      default: return lead + `plays it loose`;
    }
  }
  if (ev.type === "carry") {
    return ev.outcome === "tackled" ? `${nm(ev.tid)} dispossessed by ${nm(ev.tkl)}`
      : ev.contests && ev.contests.length ? `${nm(ev.tid)} rides the challenge — ${Math.round(ev.len)} m`
      : `${nm(ev.tid)} carries ${Math.round(ev.len)} m`;
  }
  switch (ev.outcome) {                               // shot
    case "goal": return `⚽ ${nm(ev.tid)} scores from ${Math.round(ev.d)} m!`;
    case "post": return ev.post === "bar" ? `${nm(ev.tid)} rattles the crossbar!`
      : `${nm(ev.tid)} hits the ${ev.post} post!`;
    case "save": return ev.parry ? `${nm(ev.tid)}'s strike is pushed behind — corner`
      : `${nm(ev.tid)}'s strike is held by the keeper`;
    default: return `${nm(ev.tid)} shoots wide`;
  }
}
