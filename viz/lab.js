/* lab.js — the Evolution Laboratory, rendering + controls only (SPEC §11).
 * All simulation lives in lab-worker.js; this file draws what the worker says.
 * Board: 2D top-down ink engraving of the champion's match, replayed ~5× real
 * time. Right rail: fitness descent (log-y), distribution microscope,
 * parallel-coordinates genome. Footer: transport + the wax seal (θ* reveal).
 */
import { extract, configureFromData } from "./lab-engine.js";
import { Choreo, captionOf } from "./choreo.js";

/* ---------------------------------------------------------------- tokens */
const PAPER = "#efe6d0", PAPER_DEEP = "#e3d5b8", INK = "#1c1712",
  INK_SOFT = "#4a4036", INK_FAINT = "#8a7d6a", HAIRLINE = "#d8c9a8",
  BLUE = "#2e64b0", CRIMSON = "#a13a24", GOLD = "#a97b17";
const TEAM_HEX = [BLUE, CRIMSON];
const PITCH_L = 105, PITCH_W = 68;
const $ = (s) => document.querySelector(s);

/* ---------------------------------------------------------------- data */
async function j(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } }
const DATA = await j("./assets/transition_data.json");

const loadingEl = $("#loading");
if (!DATA) {
  loadingEl.querySelector(".mark").textContent = "awaiting pipeline output";
  loadingEl.querySelector(".bar").style.display = "none";
  const hint = loadingEl.querySelector(".hint");
  hint.style.display = "block";
  hint.textContent = "run pipeline/08_transitions.py";
  throw new Error("no transition_data.json");
}
configureFromData(DATA);            // main-thread extract() must bin like the pipeline
const PLAYERS = DATA.players, N = PLAYERS.length;
const T_GAME = DATA.engine.T, TICK = DATA.engine.tick;
const idxOfTid = {}, teamOfTid = {};
PLAYERS.forEach((p, i) => { idxOfTid[p.tid] = i; teamOfTid[p.tid] = p.team; });
const DIM_SHORT = ["acc", "rng", "vis", "rsk", "drb", "cry", "fin", "sht", "tkl", "int", "ctl"];
const PASS_BIN_LBL = ["s·lo", "s·hi", "m·lo", "m·hi", "l·lo", "l·hi"];
const CARRY_BIN_LBL = ["<3.5", "3.5–8", "8–15", "≥15"];

/* ---------------------------------------------------------------- state */
let hist = [];                 // {gen, best, median, val, champLoss}
let latest = null;             // last gen message
let popZ = null, champZ = null;
let valCount = 0, sealBroken = false;
let selectedTid = PLAYERS[3].tid;   // team-0 playmaker to start
let champStats = null;         // stats extracted from the champion's match
let match = null, pendingMatch = null, choreo = null;
let running = true, speedMode = "cinematic", seed = 7;
let evalsRate = null, lastRateT = 0, lastRateMatches = 0;

/* ---------------------------------------------------------------- worker */
const worker = new Worker("./lab-worker.js", { type: "module" });
worker.postMessage({ type: "init", data: DATA });
worker.onmessage = (e) => {
  const m = e.data;
  // drop messages from a previous run racing a reset (worker tags posts with its seed)
  if ((m.type === "gen" || m.type === "champ_match") && m.seed !== seed) return;
  if (m.type === "ready") {
    const p = $("#parity");
    p.textContent = m.parity.ok ? `parity ✓ ${m.parity.maxAbsDiff.toExponential(1)}` : `parity ✗ ${m.parity.maxAbsDiff}`;
    p.className = m.parity.ok ? "ok" : "bad";
    worker.postMessage({ type: "run" });
    loadingEl.style.opacity = 0;
    setTimeout(() => loadingEl.remove(), 900);
  } else if (m.type === "gen") {
    latest = m;
    hist.push({ gen: m.gen, best: m.best, median: m.median, val: m.val, champLoss: m.champLoss });
    if (m.val != null) valCount++;
    champZ = m.champZ; popZ = m.popZ;
    const now = performance.now();
    if (now - lastRateT > 1500) {
      if (lastRateT) evalsRate = (m.matches - lastRateMatches) / ((now - lastRateT) / 1000);
      lastRateT = now; lastRateMatches = m.matches;
    }
    updateCounters();
    drawFitness();
    drawGenome();
    updateSeal();
  } else if (m.type === "champ_match") {
    pendingMatch = m;
    if (!match) applyPendingMatch();
    else note(`champion improved · gen ${m.gen}`);
  }
};

function updateCounters() {
  if (!latest) {
    $("#s-gen").textContent = "0"; $("#s-matches").textContent = "0";
    $("#s-evals").textContent = "—"; $("#s-champ").textContent = "—";
    $("#s-val").textContent = "—"; $("#genctr").textContent = "gen 0";
    return;
  }
  $("#s-gen").textContent = latest.gen;
  $("#s-matches").textContent = latest.matches.toLocaleString("en-US");
  $("#s-evals").textContent = evalsRate ? evalsRate.toFixed(1) : "—";
  $("#s-champ").textContent = latest.champLoss.toFixed(3);
  const lastVal = [...hist].reverse().find((h) => h.val != null);
  $("#s-val").textContent = lastVal ? lastVal.val.toFixed(3) : "—";
  $("#genctr").textContent = `gen ${latest.gen}`;
}

let noteTimer = null;
function note(txt) {
  const el = $("#champnote");
  el.textContent = txt;
  el.style.opacity = 1;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.style.opacity = 0; }, 4200);
}

/* ================================================================ board */
const wrap = $("#boardwrap"), canvas = $("#pitch"), ctx = canvas.getContext("2d");
let bw = 0, bh = 0, dpr = 1, sc = 1, ox = 0, oy = 0;   // meters→px transform
let staticLayer = null, pieceFont = "10px serif";
const mx = (x) => ox + x * sc, my = (y) => oy + y * sc;

function sizeBoard() {
  bw = wrap.clientWidth; bh = wrap.clientHeight;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(bw * dpr); canvas.height = Math.round(bh * dpr);
  const mgn = 3;                                   // meters of margin
  sc = Math.min(bw / (PITCH_L + 2 * mgn), bh / (PITCH_W + 2 * mgn));
  ox = (bw - PITCH_L * sc) / 2; oy = (bh - PITCH_W * sc) / 2;
  pieceFont = `italic ${Math.max(9, 1.05 * sc).toFixed(1)}px ${getComputedStyle(document.body).fontFamily}`;
  buildStatic();
}

function buildStatic() {                            // engraved pitch, drawn once
  staticLayer = document.createElement("canvas");
  staticLayer.width = canvas.width; staticLayer.height = canvas.height;
  const g = staticLayer.getContext("2d");
  g.scale(dpr, dpr);
  g.strokeStyle = INK; g.lineWidth = 1;
  /* faint 10×6 occupancy grid */
  g.globalAlpha = 0.07;
  g.beginPath();
  for (let i = 1; i < 10; i++) { g.moveTo(mx(i * PITCH_L / 10), my(0)); g.lineTo(mx(i * PITCH_L / 10), my(PITCH_W)); }
  for (let i = 1; i < 6; i++) { g.moveTo(mx(0), my(i * PITCH_W / 6)); g.lineTo(mx(PITCH_L), my(i * PITCH_W / 6)); }
  g.stroke();
  /* ink pitch lines — same geometry as main.js */
  g.globalAlpha = 0.75;
  const rect = (x0, y0, x1, y1) => g.strokeRect(mx(x0), my(y0), (x1 - x0) * sc, (y1 - y0) * sc);
  const circle = (cx, cy, r, a0 = 0, a1 = Math.PI * 2) => {
    g.beginPath(); g.arc(mx(cx), my(cy), r * sc, a0, a1); g.stroke();
  };
  rect(0, 0, PITCH_L, PITCH_W);
  g.beginPath(); g.moveTo(mx(PITCH_L / 2), my(0)); g.lineTo(mx(PITCH_L / 2), my(PITCH_W)); g.stroke();
  circle(PITCH_L / 2, PITCH_W / 2, 9.15);
  for (const side of [0, 1]) {
    const dir = side ? -1 : 1, gx = side ? PITCH_L : 0;
    rect(Math.min(gx, gx + dir * 16.5), (PITCH_W - 40.32) / 2, Math.max(gx, gx + dir * 16.5), (PITCH_W + 40.32) / 2);
    rect(Math.min(gx, gx + dir * 5.5), (PITCH_W - 18.32) / 2, Math.max(gx, gx + dir * 5.5), (PITCH_W + 18.32) / 2);
    const px = gx + dir * 11;
    g.fillStyle = INK;
    g.beginPath(); g.arc(mx(px), my(PITCH_W / 2), 0.28 * sc, 0, Math.PI * 2); g.fill();
    const a = Math.acos((16.5 - 11) / 9.15);
    circle(px, PITCH_W / 2, 9.15, side ? Math.PI - a : -a, side ? Math.PI + a : a);
    circle(gx, 0, 1.2, side ? Math.PI / 2 : 0, side ? Math.PI : Math.PI / 2);
    circle(gx, PITCH_W, 1.2, side ? Math.PI : Math.PI * 1.5, side ? Math.PI * 1.5 : Math.PI * 2);
    /* goal mouth — a heavier double stroke just outside the line */
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(mx(gx) + dir * -3, my(30.34)); g.lineTo(mx(gx) + dir * -3, my(37.66));
    g.stroke();
    g.lineWidth = 1;
  }
  g.globalAlpha = 1;
}

/* pieces: flat-ink chess silhouettes standing on the board */
function drawPawn(g, x, y, h) {                     // team 0 — pawn
  const w = h * 0.34;
  g.beginPath();
  g.moveTo(x - w, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w * 0.42, y - h * 0.38);
  g.lineTo(x + w * 0.3, y - h * 0.62);
  g.lineTo(x - w * 0.3, y - h * 0.62);
  g.lineTo(x - w * 0.42, y - h * 0.38);
  g.closePath(); g.fill();
  g.beginPath(); g.arc(x, y - h * 0.78, h * 0.235, 0, Math.PI * 2); g.fill();
}
function drawObelisk(g, x, y, h) {                  // team 1 — obelisk
  const w = h * 0.30;
  g.beginPath();
  g.moveTo(x - w, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w * 0.38, y - h * 0.74);
  g.lineTo(x - w * 0.38, y - h * 0.74);
  g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(x - w * 0.44, y - h * 0.72);
  g.lineTo(x + w * 0.44, y - h * 0.72);
  g.lineTo(x, y - h);
  g.closePath(); g.fill();
}

/* replay state */
let cursor = 0, nextK = 0, lastTs = 0, swapAt = -1;
let anns = [];                                      // transient annotations
let scoreAt = null, possAt = null;                  // per-tick prefixes

function applyPendingMatch() {
  match = pendingMatch; pendingMatch = null;
  match.byK = new Array(T_GAME);
  for (const ev of match.events) match.byK[ev.k] = ev;
  scoreAt = new Array(T_GAME); possAt = new Array(T_GAME);
  let g0 = 0, g1 = 0, p0 = 0;
  for (let k = 0; k < T_GAME; k++) {
    const ev = match.byK[k];
    if (ev && teamOfTid[ev.tid] === 0) p0++;
    if (ev && ev.type === "shot" && ev.outcome === "goal") { if (teamOfTid[ev.tid] === 0) g0++; else g1++; }
    scoreAt[k] = [g0, g1]; possAt[k] = p0 / (k + 1);
  }
  cursor = 0; nextK = 0; swapAt = -1; anns = [];
  choreo = new Choreo(match, PLAYERS, DATA.engine);
  champStats = extract([{ events: match.events, meta: { score: match.score, possession: match.possession } }], PLAYERS);
  $("#matchmeta").textContent = `champion · gen ${match.gen} · loss ${match.loss.toFixed(2)}`;
  note(`champion improved · gen ${match.gen}`);
  drawMicroscope();
}

function posAt(k, i) {                              // player i position at tick k
  const o = (k * N + i) * 2;
  return [match.positions[o], match.positions[o + 1]];
}
function lerpPos(t, i) {
  const k = Math.min(Math.floor(t), T_GAME - 1), k2 = Math.min(k + 1, T_GAME - 1), a = t - k;
  const p = posAt(k, i), q = posAt(k2, i);
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 14) return a < 0.5 ? p : q;  // kickoff snap
  return [p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a];
}
/* event → annotation + caption (text shared with the theater via captionOf) */
function spawnEvent(ev, k) {
  const nm = (tid) => `№ ${tid}`;
  const tn = (tid) => (teamOfTid[tid] === 0 ? "Atlético" : "Sevilla");
  const cap = captionOf(ev, nm, tn);
  if (ev.type === "pass") {
    const tgt = posAt(k, idxOfTid[ev.tgt]);
    const p0 = [ev.x, ev.y];
    if (ev.restart) anns.push({ kind: "spot", p0, life: 1.4, ttl: 1.4 });
    const cutPoint = () => {                        // interception/deflection point
      const jp = posAt(k, idxOfTid[ev.jlane]);
      const dx = tgt[0] - p0[0], dy = tgt[1] - p0[1], L2 = dx * dx + dy * dy || 1e-9;
      const s = Math.max(0.08, Math.min(0.92, ((jp[0] - p0[0]) * dx + (jp[1] - p0[1]) * dy) / L2));
      return [p0[0] + dx * s, p0[1] + dy * s];
    };
    if (ev.outcome === "complete") {
      anns.push({ kind: "pass", p0, p1: tgt, dash: null, life: 0.8, ttl: 0.8 });
    } else if (ev.outcome === "intercepted") {
      const cut = cutPoint();
      anns.push({ kind: "pass", p0, p1: cut, dash: [4, 3], life: 0.8, ttl: 0.8, xmark: cut });
    } else if (ev.outcome === "deflected" || ev.outcome === "deflected_out") {
      const cut = cutPoint();
      const p2 = ev.outcome === "deflected" ? ev.end : ev.exit;
      anns.push({ kind: "pass", p0, p1: cut, dash: [4, 3], life: 0.8, ttl: 0.8 });
      anns.push({ kind: "pass", p0: cut, p1: p2, dash: [2, 3], life: 0.9, ttl: 0.9,
        xmark: ev.outcome === "deflected_out" ? p2 : null });
    } else if (ev.outcome === "out") {
      anns.push({ kind: "pass", p0, p1: ev.exit, dash: [2, 3], life: 0.9, ttl: 0.9, xmark: ev.exit });
    } else if (ev.outcome === "keeper") {
      anns.push({ kind: "pass", p0, p1: ev.end, dash: [4, 3], life: 0.8, ttl: 0.8 });
    } else {                                        // ctl_fail | loose
      anns.push({ kind: "pass", p0, p1: ev.end || tgt, dash: [4, 3], life: 0.8, ttl: 0.8 });
    }
  } else if (ev.type === "carry") {
    const end = posAt(k, idxOfTid[ev.tid]);
    anns.push({ kind: "carry", p0: [ev.x, ev.y], p1: end, life: 1.2, ttl: 1.2 });
  } else if (ev.type === "shot") {
    const t = teamOfTid[ev.tid];
    const gx = t === 0 ? PITCH_L : 0;
    const aim = [gx, 34 + ev.place[0]];             // engine-decided placement
    if (ev.outcome === "goal") {
      anns.push({ kind: "shot", p0: [ev.x, ev.y], p1: aim, life: 1.2, ttl: 1.2 });
      anns.push({ kind: "burst", p0: aim, life: 1.6, ttl: 1.6 });
      if (pendingMatch) swapAt = k + 1.2;           // swap streams at the restart
    } else if (ev.outcome === "post") {
      anns.push({ kind: "shot", p0: [ev.x, ev.y], p1: aim, life: 1.2, ttl: 1.2, xmark: aim });
      if (ev.reb) anns.push({ kind: "pass", p0: aim, p1: ev.reb, dash: [2, 3], life: 1.0, ttl: 1.0 });
    } else if (ev.outcome === "save") {
      anns.push({ kind: "shot", p0: [ev.x, ev.y], p1: aim, life: 1.2, ttl: 1.2, save: true });
    } else {                                        // off
      const past = [gx + (t === 0 ? 3 : -3), Math.max(1, Math.min(67, 34 + ev.place[0]))];
      anns.push({ kind: "shot", p0: [ev.x, ev.y], p1: past, life: 1.2, ttl: 1.2, xmark: past });
    }
  }
  $("#captiontext").textContent = cap;
}

function xmark(g, x, y, r) {
  g.beginPath();
  g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
  g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
  g.stroke();
}

function renderBoard(ts) {
  if (!bw || !bh) { sizeBoard(); requestAnimationFrame(renderBoard); return; }
  const dt = Math.min(0.06, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.drawImage(staticLayer, 0, 0, bw, bh);

  if (match) {
    cursor += dt * (5 / TICK);                      // ~5× real time
    if (cursor >= T_GAME - 1) {
      if (pendingMatch) { applyPendingMatch(); requestAnimationFrame(renderBoard); return; }
      cursor = 0; nextK = 0; anns = [];
    }
    if (swapAt >= 0 && cursor >= swapAt && pendingMatch) { applyPendingMatch(); requestAnimationFrame(renderBoard); return; }
    while (nextK <= Math.floor(cursor) && nextK < T_GAME) {
      if (match.byK[nextK]) spawnEvent(match.byK[nextK], nextK);
      nextK++;
    }
    const k = Math.min(Math.floor(cursor), T_GAME - 1);
    $("#score").textContent = `${scoreAt[k][0]} — ${scoreAt[k][1]}`;
    const secs = Math.round(k * TICK);
    $("#labclock").textContent =
      `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    $("#possbar i").style.width = `${(possAt[k] * 100).toFixed(1)}%`;
  }

  /* annotations under the pieces */
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    a.life -= dt;
    if (a.life <= 0) { anns.splice(i, 1); continue; }
    const alpha = Math.min(1, a.life / a.ttl + 0.15);
    ctx.globalAlpha = alpha;
    if (a.kind === "spot") {                        // dead-ball spot: double ring
      ctx.strokeStyle = GOLD; ctx.lineWidth = 1.2;
      for (const r of [0.8, 1.5]) {
        ctx.beginPath(); ctx.arc(mx(a.p0[0]), my(a.p0[1]), r * sc, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (a.kind === "burst") {
      ctx.strokeStyle = GOLD; ctx.lineWidth = 1.4;
      const r0 = (1 - a.life / a.ttl) * 3.2 + 1.2;
      for (let q = 0; q < 10; q++) {
        const th = q / 10 * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(mx(a.p0[0] + Math.cos(th) * r0 * 0.45), my(a.p0[1] + Math.sin(th) * r0 * 0.45));
        ctx.lineTo(mx(a.p0[0] + Math.cos(th) * r0), my(a.p0[1] + Math.sin(th) * r0));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = a.kind === "carry" ? INK_SOFT : GOLD;
      ctx.lineWidth = a.kind === "shot" ? 2 : 1.5;
      ctx.setLineDash(a.kind === "carry" ? [2, 3] : (a.dash || []));
      ctx.beginPath();
      ctx.moveTo(mx(a.p0[0]), my(a.p0[1]));
      ctx.lineTo(mx(a.p1[0]), my(a.p1[1]));
      ctx.stroke();
      ctx.setLineDash([]);
      if (a.xmark) { ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.4; xmark(ctx, mx(a.xmark[0]), my(a.xmark[1]), 4); }
      if (a.save) {                                 // thin double-tick across the ray
        const dx = a.p1[0] - a.p0[0], dy = a.p1[1] - a.p0[1], L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;
        const bxp = a.p0[0] + dx * 0.86, byp = a.p0[1] + dy * 0.86;
        ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
        for (const off of [-0.5, 0.5]) {
          ctx.beginPath();
          ctx.moveTo(mx(bxp + nx * 1.6 + dx / L * off), my(byp + ny * 1.6 + dy / L * off));
          ctx.lineTo(mx(bxp - nx * 1.6 + dx / L * off), my(byp - ny * 1.6 + dy / L * off));
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* pieces (sorted by y so lower pieces overlap upper) */
  const pos = PLAYERS.map((p, i) => match ? lerpPos(cursor, i) : p.anchor);
  const order = PLAYERS.map((_, i) => i).sort((a, b) => pos[a][1] - pos[b][1]);
  const h = 2.4 * sc;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = pieceFont;
  for (const i of order) {
    const p = PLAYERS[i], [x, y] = pos[i], X = mx(x), Y = my(y);
    ctx.fillStyle = "rgba(40,28,14,.16)";           // ground shadow
    ctx.beginPath(); ctx.ellipse(X, Y, 1.35 * sc, 0.5 * sc, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = TEAM_HEX[p.team];             // team ring underneath
    ctx.lineWidth = p.tid === selectedTid ? 2.2 : 1.3;
    ctx.beginPath(); ctx.ellipse(X, Y, 1.15 * sc, 0.46 * sc, 0, 0, Math.PI * 2); ctx.stroke();
    if (p.tid === selectedTid) {
      ctx.strokeStyle = GOLD; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(X, Y, 1.6 * sc, 0.66 * sc, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = INK;
    if (p.team === 0) drawPawn(ctx, X, Y, h); else drawObelisk(ctx, X, Y, h);
    ctx.fillStyle = INK_FAINT;
    ctx.fillText(String(p.tid), X + 1.45 * sc, Y - 0.5 * sc);
  }

  /* the golden ball — choreographed: flights, arcs, dead-ball ceremonies */
  if (match && choreo) {
    const b = choreo.ballAt(cursor);
    let bxm, bym, bz = b.z || 0;
    if (b.mode === "held" && b.held != null) {
      const p = lerpPos(cursor, b.held);
      bxm = p[0]; bym = p[1]; bz = 0;
    } else { bxm = b.x; bym = b.y; }
    ctx.fillStyle = "rgba(40,28,14,.20)";           // shadow shrinks as the ball rises
    ctx.beginPath();
    ctx.ellipse(mx(bxm), my(bym), Math.max(0.12, 0.4 - bz * 0.03) * sc,
      Math.max(0.06, 0.18 - bz * 0.015) * sc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    const r = (0.45 + bz * 0.035) * sc;
    ctx.beginPath(); ctx.arc(mx(bxm), my(bym) - (0.5 + bz * 0.65) * sc, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  requestAnimationFrame(renderBoard);
}

canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const xm = (e.clientX - r.left - ox) / sc, ym = (e.clientY - r.top - oy) / sc;
  let bi = -1, bv = 9;
  PLAYERS.forEach((p, i) => {
    const q = match ? lerpPos(cursor, i) : p.anchor;
    const d = Math.hypot(q[0] - xm, q[1] - ym);
    if (d < 3.2 && d < bv) { bv = d; bi = i; }
  });
  if (bi >= 0) selectPlayer(PLAYERS[bi].tid);
});

/* ================================================================ charts */
const tooltip = $("#tooltip");
const showTip = (html, x, y) => { tooltip.innerHTML = html; tooltip.style.display = "block"; tooltip.style.left = (x + 14) + "px"; tooltip.style.top = (y + 10) + "px"; };
const hideTip = () => { tooltip.style.display = "none"; };
const fmtE = (v) => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

/* ---- fitness (log-y) ---- */
function drawFitness() {
  const el = $("#fitchart");
  const W = el.clientWidth || 480, H = el.clientHeight || 170;
  const padL = 40, padR = 10, padT = 8, padB = 20;
  const vals = [DATA.noise_floor];
  for (const hh of hist) { vals.push(hh.median, hh.champLoss); if (hh.val != null) vals.push(hh.val); }
  const lo = Math.max(1e-3, Math.min(...vals) * 0.75), hi = Math.max(...vals) * 1.25;
  const G = Math.max(hist.length ? hist[hist.length - 1].gen : 1, 10);
  const X = (g) => padL + g / G * (W - padL - padR);
  const Y = (v) => padT + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block">`;
  /* log gridlines at 1-2-5 pattern */
  for (let dec = Math.floor(Math.log10(lo)); dec <= Math.ceil(Math.log10(hi)); dec++)
    for (const mfac of [1, 2, 5]) {
      const v = mfac * 10 ** dec;
      if (v < lo || v > hi) continue;
      s += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="${HAIRLINE}" stroke-width="1"/>
            <text x="${padL - 6}" y="${Y(v) + 3.5}" text-anchor="end" font-size="9.5" fill="${INK_FAINT}">${fmtE(v)}</text>`;
    }
  const gstep = G <= 20 ? 5 : G <= 60 ? 10 : G <= 150 ? 25 : 50;
  for (let g = 0; g <= G; g += gstep)
    s += `<text x="${X(g)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="${INK_FAINT}">${g}</text>`;
  /* noise floor */
  if (DATA.noise_floor >= lo && DATA.noise_floor <= hi) {
    s += `<line x1="${padL}" y1="${Y(DATA.noise_floor)}" x2="${W - padR}" y2="${Y(DATA.noise_floor)}"
           stroke="${INK_SOFT}" stroke-width="1" stroke-dasharray="5 4"/>
          <text x="${W - padR - 4}" y="${Y(DATA.noise_floor) - 4}" text-anchor="end" font-size="9.5"
           font-style="italic" fill="${INK_SOFT}">noise floor — θ* itself vs held-out · floor for the gold line</text>`;
  }
  if (hist.length) {
    // long sessions: cap drawn points (stride-decimate, always keep the last)
    const decimate = (arr, cap = 700) => {
      if (arr.length <= cap) return arr;
      const st = Math.ceil(arr.length / cap);
      const out = arr.filter((_, q) => q % st === 0);
      if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
      return out;
    };
    const path = (pts, pick, decorate = "") => {
      if (!pts.length) return "";
      return `<path d="${pts.map((hh, q) => `${q ? "L" : "M"}${X(hh.gen).toFixed(1)},${Y(pick(hh)).toFixed(1)}`).join("")}" fill="none" ${decorate}/>`;
    };
    const main = decimate(hist);
    const valPts = decimate(hist.filter((hh) => hh.val != null), 250);
    s += path(main, (hh) => hh.median, `stroke="${INK}" stroke-width="1" opacity="0.28"`);
    s += path(main, (hh) => hh.champLoss, `stroke="${INK}" stroke-width="2"`);
    s += path(valPts, (hh) => hh.val, `stroke="${GOLD}" stroke-width="1.4"`);
    for (const hh of valPts)
      s += `<circle cx="${X(hh.gen)}" cy="${Y(hh.val)}" r="2.6" fill="${GOLD}"/>`;
    const last = hist[hist.length - 1];
    s += `<circle cx="${X(last.gen)}" cy="${Y(last.champLoss)}" r="3" fill="${INK}"/>`;
  }
  s += `</svg>`;
  el.innerHTML = s;
  const svg = el.querySelector("svg");
  svg.addEventListener("mousemove", (e) => {
    if (!hist.length) return;
    const r = svg.getBoundingClientRect();
    const g = (e.clientX - r.left - padL) / (W - padL - padR) * G;
    let best = hist[0], bd = Infinity;
    for (const hh of hist) { const d = Math.abs(hh.gen - g); if (d < bd) { bd = d; best = hh; } }
    const bdown = latest?.breakdown
      ? Object.entries(latest.breakdown).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ")
      : "";
    showTip(`gen ${best.gen}<br>median ${best.median.toFixed(3)} · champion ${best.champLoss.toFixed(3)}` +
      (best.val != null ? ` · val ${best.val.toFixed(3)}` : "") +
      (bdown ? `<br><span style="opacity:.75">champ loss by family: ${bdown}</span>` : ""), e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", hideTip);
}

/* ---- microscope ---- */
const lap = (suc, att) => (suc + 1) / (att + 2);
function statsFor(tid) {
  return {
    train: DATA.train.stats.players[tid],
    val: DATA.val.stats.players[tid],
    sim: champStats ? champStats.players[tid] : null,
  };
}
function drawMicroscope() {
  const el = $("#microchart");
  const W = el.clientWidth || 480, H = el.clientHeight || 220;
  const s3 = statsFor(selectedTid);
  const rowH = H * 0.56, dialY = rowH + 14, dialH = H - dialY - 4;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block">`;

  const panel = (x0, w, title, labels, tr, sim, val, ns) => {
    const px = x0 + 6, pw = w - 14, py = 16, phh = rowH - py - 16;
    const n = labels.length, bwd = pw / n;
    let o = `<text x="${x0 + 6}" y="9" font-size="8.5" letter-spacing="1.5" fill="${INK_FAINT}" style="text-transform:uppercase">${title}</text>`;
    const Y = (v) => py + (1 - v) * phh;
    for (let b = 0; b < n; b++) {
      const cx = px + b * bwd + bwd / 2;
      o += `<rect x="${px + b * bwd + bwd * 0.22}" y="${Y(tr[b])}" width="${bwd * 0.56}" height="${Math.max(0.5, phh - (Y(tr[b]) - py))}" fill="${INK}" opacity="0.8"/>`;
      if (val) o += `<line x1="${cx - bwd * 0.34}" y1="${Y(val[b])}" x2="${cx + bwd * 0.34}" y2="${Y(val[b])}" stroke="${BLUE}" stroke-width="1.6" stroke-dasharray="3 2"/>`;
      o += `<text x="${cx}" y="${rowH - 4}" text-anchor="middle" font-size="8" fill="${INK_FAINT}">${labels[b]}</text>`;
      o += `<text x="${cx}" y="${Y(Math.max(tr[b], val ? val[b] : 0, sim ? sim[b] : 0)) - 3}" text-anchor="middle" font-size="7" fill="${INK_FAINT}">n=${ns[b]}</text>`;
    }
    if (sim) {
      // null bins = champion had no attempts there in his match — draw nothing
      let d = "", pen = false;
      sim.forEach((v, b) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${(px + b * bwd + bwd / 2).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      if (d) o += `<path d="${d}" fill="none" stroke="${GOLD}" stroke-width="1.3"/>`;
      sim.forEach((v, b) => { if (v != null) o += `<circle cx="${px + b * bwd + bwd / 2}" cy="${Y(v)}" r="2.4" fill="${GOLD}"/>`; });
    }
    o += `<line x1="${px}" y1="${py + phh}" x2="${px + pw}" y2="${py + phh}" stroke="${HAIRLINE}"/>`;
    return o;
  };

  /* pass completion by 6 bins */
  const pc = s3.train.pass_cmp;
  s += panel(0, W * 0.56, "pass completion — dist × press",
    PASS_BIN_LBL,
    pc.att.map((a, b) => lap(pc.suc[b], a)),
    s3.sim ? s3.sim.pass_cmp.att.map((a, b) => (a ? lap(s3.sim.pass_cmp.suc[b], a) : null)) : null,
    s3.val.pass_cmp.att.map((a, b) => lap(s3.val.pass_cmp.suc[b], a)),
    pc.att);

  /* carry length histogram (bin shares) */
  const ch = s3.train.carry_len.hist;
  const hshare = (hh) => { const t = hh.reduce((a, b) => a + b, 0); return hh.map((c) => (c + 1) / (t + hh.length)); };
  s += panel(W * 0.56, W * 0.44, "carry length (m)",
    CARRY_BIN_LBL, hshare(ch),
    s3.sim && s3.sim.carry_len.hist.some((c) => c > 0) ? hshare(s3.sim.carry_len.hist) : null,
    hshare(s3.val.carry_len.hist), ch);

  /* one-bin dials: shot conv · tackle · intercept · ctl fail */
  const dials = [
    ["shot conv", (q) => [q.shot_conv.goals, q.shot_conv.att]],
    ["tackle", (q) => [q.tackle.won, q.tackle.opp]],
    ["intercept", (q) => [q.intercept.won, q.intercept.opp]],
    ["ctl fail", (q) => [q.receive.fail, q.receive.arr]],
  ];
  const dw = W / 4;
  dials.forEach(([name, f], di) => {
    const cx = di * dw + dw / 2, cy = dialY + dialH * 0.72, R = Math.min(dw * 0.32, dialH * 0.62);
    s += `<path d="M${cx - R},${cy} A${R},${R} 0 0 1 ${cx + R},${cy}" fill="none" stroke="${HAIRLINE}" stroke-width="3"/>`;
    const needle = (v, col, wl, len) => {
      const th = Math.PI * (1 - Math.max(0, Math.min(1, v)));
      return `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(th) * R * len}" y2="${cy - Math.sin(th) * R * len}" stroke="${col}" stroke-width="${wl}"/>`;
    };
    const [wT, aT] = f(s3.train), [wV, aV] = f(s3.val);
    s += needle(lap(wT, aT), INK, 2, 0.95);
    s += needle(lap(wV, aV), BLUE, 1.2, 0.8);
    if (s3.sim) { const [wS, aS] = f(s3.sim); if (aS > 0) s += needle(lap(wS, aS), GOLD, 1.6, 0.88); }
    s += `<text x="${cx}" y="${cy + 11}" text-anchor="middle" font-size="8.5" letter-spacing="1.2" fill="${INK_FAINT}" style="text-transform:uppercase">${name}</text>`;
    s += `<text x="${cx}" y="${cy + 21}" text-anchor="middle" font-size="8" fill="${INK_SOFT}">${lap(wT, aT).toFixed(2)} <tspan fill="${INK_FAINT}">n=${aT}</tspan></text>`;
  });
  s += `</svg>`;
  el.innerHTML = s;
}

/* ---- genome: parallel coordinates / recovered-vs-true ---- */
function drawGenome() {
  const el = $("#genomechart");
  const W = el.clientWidth || 480, H = el.clientHeight || 160;
  const padL = 16, padR = 16, padT = 8, padB = 18;
  const pi = idxOfTid[selectedTid];
  const AX = (d) => padL + d / 10 * (W - padL - padR);
  const Y = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block">`;
  for (let d = 0; d < 11; d++) {
    s += `<line x1="${AX(d)}" y1="${padT}" x2="${AX(d)}" y2="${H - padB}" stroke="${HAIRLINE}"/>
          <text x="${AX(d)}" y="${H - 6}" text-anchor="middle" font-size="8.5" fill="${INK_FAINT}">${DIM_SHORT[d]}</text>`;
  }
  const strand = (arr, off, col, wd, op, dash = "") =>
    `<path d="${Array.from({ length: 11 }, (_, d) => `${d ? "L" : "M"}${AX(d).toFixed(1)},${Y(arr[off + d]).toFixed(1)}`).join("")}"
      fill="none" stroke="${col}" stroke-width="${wd}" opacity="${op}" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`;
  if (!sealBroken) {
    if (popZ) {
      const npop = popZ.length / (N * 11);
      for (let p = 0; p < npop; p++) s += strand(popZ, p * N * 11 + pi * 11, INK, 1, 0.12);
    }
    if (champZ) s += strand(champZ, pi * 11, GOLD, 2, 1);
  } else {
    /* recovered vs true, all 12 players, per param */
    const truth = DATA.sealed.theta_true;
    for (let d = 0; d < 11; d++) {
      const tv = [], fv = [];
      PLAYERS.forEach((p, q) => { tv.push(truth[p.tid][d]); fv.push(champZ ? champZ[q * 11 + d] : 0.5); });
      for (let q = 0; q < N; q++) {
        s += `<line x1="${AX(d)}" y1="${Y(tv[q])}" x2="${AX(d)}" y2="${Y(fv[q])}" stroke="${INK_FAINT}" stroke-width="0.7" opacity="0.55"/>
              <circle cx="${AX(d)}" cy="${Y(tv[q])}" r="2.2" fill="none" stroke="${CRIMSON}" stroke-width="1"/>
              <circle cx="${AX(d)}" cy="${Y(fv[q])}" r="1.8" fill="${GOLD}"/>`;
      }
      const mu = tv.reduce((a, b) => a + b, 0) / N;
      const ssTot = tv.reduce((a, b) => a + (b - mu) ** 2, 0) || 1e-9;
      const ssRes = tv.reduce((a, b, q) => a + (fv[q] - b) ** 2, 0);
      s += `<text x="${AX(d)}" y="${padT - 1}" text-anchor="middle" font-size="7.5" fill="${INK_SOFT}">R²${Math.max(-9.9, 1 - ssRes / ssTot).toFixed(1)}</text>`;
    }
    if (champZ) s += strand(champZ, pi * 11, GOLD, 2, 1);
    s += strand(DATA.sealed.theta_true[selectedTid], 0, CRIMSON, 1.4, 0.9, "5 3");
  }
  s += `</svg>`;
  el.innerHTML = s;
}

/* ---------------------------------------------------------------- roster */
const ROLE = { back: "left back", back2: "right back" };
const roleOf = (p) => ROLE[p.archetype] ?? p.archetype;
{
  const strip = $("#rosterstrip");
  for (const p of [...PLAYERS].sort((a, b) => a.team - b.team || a.slot - b.slot)) {
    const d = document.createElement("span");
    d.className = "rdot"; d.dataset.tid = p.tid;
    d.innerHTML = `<i style="background:${TEAM_HEX[p.team]}"></i>${p.tid}`;
    d.title = `№ ${p.tid} — ${roleOf(p)}`;
    d.onclick = () => selectPlayer(p.tid);
    strip.appendChild(d);
  }
}
function selectPlayer(tid) {
  selectedTid = tid;
  document.querySelectorAll(".rdot").forEach((r) => r.classList.toggle("sel", +r.dataset.tid === tid));
  const p = PLAYERS[idxOfTid[tid]];
  $("#microname").textContent = `№ ${tid} — ${roleOf(p)}`;
  $("#genomename").textContent = `№ ${tid}`;
  drawMicroscope(); drawGenome();
}

/* ---------------------------------------------------------------- seal */
function updateSeal() {
  const btn = $("#seal");
  if (sealBroken) return;
  const ready = latest && latest.gen >= 60 && valCount >= 5;
  btn.disabled = !ready;
  btn.title = ready ? "break the seal — reveal θ*" : "run longer";
}
$("#seal").onclick = () => {
  if (sealBroken || !champZ) return;
  sealBroken = true;
  $("#genomehint").textContent = "gold = recovered · crimson = sealed truth θ*";
  buildReveal();
  $("#reveal").classList.add("open");
  drawGenome();
};
$("#revealclose").onclick = () => $("#reveal").classList.remove("open");

function buildReveal() {
  const truth = DATA.sealed.theta_true;
  const grid = $("#revealgrid");
  const tally = { identified: 0, ridge: 0, unidentified: 0 };
  let html = "";
  for (let d = 0; d < 11; d++) {
    const tv = [], fv = [];
    PLAYERS.forEach((p, q) => { tv.push(truth[p.tid][d]); fv.push(champZ[q * 11 + d]); });
    const mad = tv.reduce((a, b, q) => a + Math.abs(fv[q] - b), 0) / N;
    const mu = tv.reduce((a, b) => a + b, 0) / N;
    const ssTot = tv.reduce((a, b) => a + (b - mu) ** 2, 0) || 1e-9;
    const ssRes = tv.reduce((a, b, q) => a + (fv[q] - b) ** 2, 0);
    const r2 = 1 - ssRes / ssTot;
    const verdict = mad < 0.12 ? "identified" : mad < 0.25 ? "ridge" : "unidentified";
    tally[verdict]++;
    const S = 92;
    let sc2 = `<svg viewBox="0 0 ${S} ${S}" width="100%" style="display:block;max-width:120px;margin:6px auto">`;
    sc2 += `<rect x="6" y="6" width="${S - 12}" height="${S - 12}" fill="none" stroke="${HAIRLINE}"/>`;
    sc2 += `<line x1="6" y1="${S - 6}" x2="${S - 6}" y2="6" stroke="${INK_FAINT}" stroke-dasharray="3 3" stroke-width="0.8"/>`;
    for (let q = 0; q < N; q++) {
      const X = 6 + tv[q] * (S - 12), Yv = S - 6 - fv[q] * (S - 12);
      sc2 += `<circle cx="${X}" cy="${Yv}" r="2.4" fill="${TEAM_HEX[PLAYERS[q].team]}" opacity="0.85"/>`;
    }
    sc2 += `<text x="${S / 2}" y="${S - 0.5}" text-anchor="middle" font-size="6.5" fill="${INK_FAINT}">true →</text>`;
    sc2 += `</svg>`;
    html += `<div class="rv"><div class="pname">${DATA.dims[d].name}</div>${sc2}
      <div class="verdict ${verdict}">${verdict}</div>
      <div class="nums">mean |Δz| ${mad.toFixed(3)} · R² ${r2.toFixed(2)}</div></div>`;
  }
  grid.innerHTML = html;
  const lastVal = [...hist].reverse().find((h) => h.val != null);
  const behave = lastVal ? `held-out behavior ${lastVal.val.toFixed(2)} vs noise floor ${DATA.noise_floor.toFixed(2)}` : "";
  $("#revealnote").textContent =
    `recovered genotype (gen ${latest ? latest.gen : "?"}, champion loss ${latest ? latest.champLoss.toFixed(2) : "—"}) vs sealed truth θ* — ` +
    `verdicts: |Δz| < .12 identified · < .25 ridge · else unidentified. ` +
    `${tally.identified} identified · ${tally.ridge} on ridges · ${tally.unidentified} unidentified${behave ? ` — yet ${behave}` : ""}: ` +
    `two games pin conduct, not character.`;
}

/* ---------------------------------------------------------------- transport */
$("#play").onclick = () => {
  running = !running;
  worker.postMessage({ type: running ? "run" : "pause" });
  $("#play").textContent = running ? "❚❚" : "▶";
};
document.querySelectorAll("#transport .mode").forEach((el2) => el2.onclick = () => {
  document.querySelectorAll("#transport .mode").forEach((x) => x.classList.remove("active"));
  el2.classList.add("active");
  speedMode = el2.dataset.speed;
  worker.postMessage({ type: "speed", mode: speedMode });
});
$("#reset").onclick = () => {
  seed++;
  $("#seedno").textContent = seed;
  worker.postMessage({ type: "reset", seed });
  hist = []; latest = null; valCount = 0; sealBroken = false;
  evalsRate = null; lastRateT = 0; lastRateMatches = 0;
  pendingMatch = null; champStats = null; match = null; choreo = null;
  $("#score").textContent = "0 — 0"; $("#labclock").textContent = "00:00";
  $("#matchmeta").textContent = "";
  $("#captiontext").textContent = "the engine awaits its first champion…";
  $("#genomehint").textContent = "28 strands · gold = champion";
  $("#seal").disabled = true; $("#seal").title = "run longer";
  $("#reveal").classList.remove("open");
  updateCounters(); drawFitness(); drawGenome(); drawMicroscope();
  note(`reseeded · evolution restarts from dust`);
};

/* ---------------------------------------------------------------- resize */
const ro = new ResizeObserver(() => { sizeBoard(); drawFitness(); drawMicroscope(); drawGenome(); });
ro.observe(wrap);
ro.observe($("#panels"));

/* verification hooks (headless harness + debugging) */
window.__lab = {
  seek(t) { cursor = Math.max(0, t); nextK = Math.floor(cursor); anns = []; },
  info() { return { cursor, hasMatch: !!match, gen: latest ? latest.gen : 0 }; },
  events(kind) {
    if (!match) return null;
    return match.events
      .filter((e) => (kind === "shot" ? e.type === "shot" : kind === "restart" ? !!e.restart
        : kind === "out" ? e.outcome === "out" || e.outcome === "deflected_out" : true))
      .map((e) => ({ k: e.k, type: e.type, outcome: e.outcome, restart: e.restart || null }));
  },
};

/* ---------------------------------------------------------------- go */
sizeBoard();
selectPlayer(selectedTid);
drawFitness();
requestAnimationFrame(renderBoard);
