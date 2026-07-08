/* match.js — the Theater: a live engine-v2 match rendered in 3D, sepia & ink.
 *
 * Simulation: playGame() (viz/lab-engine.js) with the sealed θ* genotypes from
 * transition_data.json — an endless exhibition, one recorded match at a time.
 * Kinematics: the Choreo module interprets the event stream (flights, arcs,
 * dead-ball ceremonies, restart glides); ticks are DILATED by paceOf() so
 * corners and kickoffs breathe.
 * Physics: rapier — but ONLY at the goalmouth. Each goal owns a rapier world
 * in the goal's local frame (posts, crossbar, ground, catch-box) plus a verlet
 * net cloth. When a shot launches, the golden ball becomes a dynamic body
 * aimed by the ballistic solver at the engine-decided placement — goals bulge
 * the net, woodwork rebounds ring true, saves bounce off the keeper piece —
 * then control blends back to the choreographer for the restart ceremony.
 */
import * as THREE from "./vendor/three.module.js";
import RAPIER from "./vendor/rapier3d-compat.js";
import { playGame, makePlayers, thetaStar, configureFromData, ENGINE } from "./lab-engine.js";
import { Choreo, captionOf } from "./choreo.js";
import { buildGoal, NetCloth, launchVelocity } from "./goal-physics.js";

/* ---------------------------------------------------------------- palette */
const PAPER = 0xefe6d0, INK = 0x1c1712;
const TEAM_HEX = ["#2e64b0", "#a13a24"], GOLD = "#a97b17";
const TEAM_COL = [new THREE.Color(TEAM_HEX[0]), new THREE.Color(TEAM_HEX[1])];
const PITCH_L = 105, PITCH_W = 68;
const BALL_R = 0.3;
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
configureFromData(DATA);
await RAPIER.init();

const PLAYERS = DATA.players, N = PLAYERS.length, TICK = DATA.engine.T ? DATA.engine.tick : 2;
const T_GAME = DATA.engine.T;
const idxOfTid = {}, teamOfTid = {};
PLAYERS.forEach((p, i) => { idxOfTid[p.tid] = i; teamOfTid[p.tid] = p.team; });
const THETA = new Float64Array(N * 11);
if (DATA.sealed?.theta_true)
  PLAYERS.forEach((p, i) => DATA.sealed.theta_true[p.tid].forEach((v, d) => { THETA[i * 11 + d] = v; }));
else THETA.set(thetaStar(makePlayers()));
const toWorld = (x, y, h = 0) => new THREE.Vector3(x - PITCH_L / 2, h, y - PITCH_W / 2);

/* ---------------------------------------------------------------- scene */
const stage = $("#stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(PAPER);
scene.fog = new THREE.Fog(PAPER, 160, 340);
const camera = new THREE.PerspectiveCamera(27, innerWidth / innerHeight, 1, 700);
let camTheta = 0, camPhi = 0.92, camR = 118, camDrift = true;
const camTarget = new THREE.Vector3(0, 0, 0);
const camFollow = new THREE.Vector3(0, 0, 0);
function placeCamera(t, dt) {
  camTarget.x += (THREE.MathUtils.clamp(camFollow.x * 0.66, -41, 41) - camTarget.x) * Math.min(1, dt * 1.1);
  camTarget.z += (THREE.MathUtils.clamp(camFollow.z * 0.45, -18, 18) - camTarget.z) * Math.min(1, dt * 1.1);
  const th = camTheta + (camDrift ? Math.sin(t * 0.00005) * 0.05 : 0);
  camera.position.set(camTarget.x + camR * Math.sin(camPhi) * Math.sin(th),
    camR * Math.cos(camPhi),
    camTarget.z + camR * Math.sin(camPhi) * Math.cos(th));
  camera.lookAt(camTarget);
}

scene.add(new THREE.HemisphereLight(0xfff6e0, 0xb09b72, 1.15));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
sun.position.set(-45, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.far = 220;
sun.shadow.bias = -0.0004;
scene.add(sun);

/* parchment ground (as main.js) */
function parchmentTexture() {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 680;
  const g = c.getContext("2d");
  g.fillStyle = "#e9dec2"; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 9000; i++) {
    const a = Math.random() * 0.05;
    g.fillStyle = Math.random() > .5 ? `rgba(120,95,60,${a})` : `rgba(255,250,235,${a})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1 + Math.random() * 2.4, 1 + Math.random() * 2.4);
  }
  for (let b = 0; b < 12; b += 2) {
    g.fillStyle = "rgba(105,85,55,0.028)";
    g.fillRect(b * c.width / 12, 0, c.width / 12, c.height);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(PITCH_L + 30, PITCH_W + 26),
  new THREE.MeshStandardMaterial({ map: parchmentTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true;
scene.add(ground);

/* ink pitch lines (same geometry as main.js) */
{
  const pts = [];
  const seg = (a, b) => { pts.push(toWorld(a[0], a[1]), toWorld(b[0], b[1])); };
  const rect = (x0, y0, x1, y1) => { seg([x0, y0], [x1, y0]); seg([x1, y0], [x1, y1]); seg([x1, y1], [x0, y1]); seg([x0, y1], [x0, y0]); };
  rect(0, 0, PITCH_L, PITCH_W);
  seg([PITCH_L / 2, 0], [PITCH_L / 2, PITCH_W]);
  const circle = (cx, cy, r, a0 = 0, a1 = Math.PI * 2, n = 56) => {
    for (let i = 0; i < n; i++) {
      const t0 = a0 + (a1 - a0) * i / n, t1 = a0 + (a1 - a0) * (i + 1) / n;
      seg([cx + r * Math.cos(t0), cy + r * Math.sin(t0)], [cx + r * Math.cos(t1), cy + r * Math.sin(t1)]);
    }
  };
  circle(PITCH_L / 2, PITCH_W / 2, 9.15);
  for (const side of [0, 1]) {
    const dir = side ? -1 : 1, gx = side ? PITCH_L : 0;
    rect(gx, (PITCH_W - 40.32) / 2, gx + dir * 16.5, (PITCH_W + 40.32) / 2);
    rect(gx, (PITCH_W - 18.32) / 2, gx + dir * 5.5, (PITCH_W + 18.32) / 2);
    const px = gx + dir * 11;
    circle(px, PITCH_W / 2, 0.28, 0, Math.PI * 2, 10);
    const a = Math.acos((16.5 - 11) / 9.15);
    circle(px, PITCH_W / 2, 9.15, side ? Math.PI - a : -a, side ? Math.PI + a : a, 20);
    circle(gx, 0, 1.2, side ? Math.PI / 2 : 0, side ? Math.PI : Math.PI / 2, 8);
    circle(gx, PITCH_W, 1.2, side ? Math.PI : Math.PI * 1.5, side ? Math.PI * 1.5 : Math.PI * 2, 8);
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.75 }));
  lines.position.y = 0.02;
  scene.add(lines);
}

/* ------------------------------------------------- goals: physics theaters */
/* Each goal = a rapier world in the GOAL'S LOCAL frame (mouth in plane z=0,
 * net toward z<0, field toward z>0) + a THREE group posed in world space.
 * goal 0 sits at pitch x=0 (faces +x), goal 1 at pitch x=105 (faces −x). */
const GRAV = { x: 0, y: -9.81, z: 0 };
function makeGoalTheater(side) {                    // side 0 → pitch x=0
  const world = new RAPIER.World(GRAV);
  world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.2, 30)
    .setTranslation(0, -0.2, 0).setRestitution(0.55).setFriction(0.7));
  const group = new THREE.Group();
  group.position.set(side === 0 ? -PITCH_L / 2 : PITCH_L / 2, 0, 0);
  group.rotation.y = side === 0 ? Math.PI / 2 : -Math.PI / 2;
  const frame = buildGoal(group, world, RAPIER, {});
  const cloth = new NetCloth({ halfW: frame.hw, barY: frame.barY, depth: frame.depth });
  group.add(cloth.object3d);
  scene.add(group);
  /* dynamic ball body, disabled until a shot needs it */
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 5, 25).setCcdEnabled(true)
    .setLinearDamping(0.25).setAngularDamping(2.0));
  world.createCollider(RAPIER.ColliderDesc.ball(BALL_R)
    .setRestitution(0.62).setFriction(0.5).setDensity(1), body);
  body.setEnabled(false);
  /* keeper block: kinematic capsule, parked until a save is staged */
  const keeper = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(0, -20, 0));
  world.createCollider(RAPIER.ColliderDesc.cylinder(1.0, 0.5)
    .setRestitution(0.35).setFriction(0.8), keeper);
  keeper.setEnabled(false);
  /* local ↔ world (see rotations above) */
  const toW = side === 0
    ? (l) => new THREE.Vector3(-PITCH_L / 2 + l.z, l.y, -l.x)
    : (l) => new THREE.Vector3(PITCH_L / 2 - l.z, l.y, l.x);
  const toL = side === 0
    ? (w) => ({ x: -w.z, y: w.y, z: w.x + PITCH_L / 2 })
    : (w) => ({ x: w.z, y: w.y, z: PITCH_L / 2 - w.x });
  return { world, group, cloth, body, keeper, toW, toL, frame };
}
const goals = [makeGoalTheater(0), makeGoalTheater(1)];

/* ---------------------------------------------------------------- pieces */
function pawnGeometry() {
  const prof = [[0.95, 0], [0.95, 0.16], [0.55, 0.34], [0.42, 1.05], [0.30, 1.55], [0.52, 1.78], [0.30, 2.02], [0.44, 2.35], [0.001, 2.62]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(prof, 8).toNonIndexed();
}
function obeliskGeometry() {
  const g1 = new THREE.CylinderGeometry(0.34, 0.72, 2.1, 4, 1); g1.translate(0, 1.05, 0);
  const g2 = new THREE.ConeGeometry(0.4, 0.55, 4); g2.translate(0, 2.35, 0);
  const base = new THREE.CylinderGeometry(0.95, 0.95, 0.16, 8); base.translate(0, 0.08, 0);
  return mergeGeoms([base.toNonIndexed(), g1.toNonIndexed(), g2.toNonIndexed()]);
}
function mergeGeoms(gs) {
  let total = 0; for (const g of gs) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3); let o = 0;
  for (const g of gs) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}
function blobShadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, "rgba(40,28,14,0.42)"); r.addColorStop(1, "rgba(40,28,14,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const blobTex = blobShadowTexture();
const GEO = [pawnGeometry(), obeliskGeometry()];
const PIECE_MAT = new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.62, metalness: 0.05, flatShading: true });

const pieces = PLAYERS.map((p) => {
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(GEO[p.team], PIECE_MAT);
  mesh.castShadow = true;
  grp.add(mesh);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.09, 4, 24),
    new THREE.MeshBasicMaterial({ color: TEAM_COL[p.team] }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.06;
  grp.add(ring);
  const sh = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTex, depthWrite: false }));
  sh.scale.set(3.6, 3.6, 1); sh.position.y = 0.01;
  scene.add(grp); scene.add(sh);
  grp.position.copy(toWorld(p.anchor[0], p.anchor[1]));
  return { grp, sh, team: p.team, tid: p.tid };
});

/* the golden ball + its shadow */
const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(GOLD), roughness: 0.35, metalness: 0.35, flatShading: true }));
ball.castShadow = true;
scene.add(ball);
const ballSh = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTex, depthWrite: false }));
ballSh.scale.set(1.6, 1.6, 1);
scene.add(ballSh);

/* ---------------------------------------------------------------- match */
let matchNo = 0, match = null, choreo = null, scoreAt = null;
let cursor = 0, nextK = 0;
function newMatch() {
  matchNo++;
  const seed = 4242 + matchNo * 17;
  match = playGame(PLAYERS, THETA, seed, { record: true });
  choreo = new Choreo(match, PLAYERS, DATA.engine);
  scoreAt = new Array(T_GAME);
  let g0 = 0, g1 = 0;
  for (let k = 0; k < T_GAME; k++) {
    const e = match.events[k];
    if (e && e.type === "shot" && e.outcome === "goal") { if (teamOfTid[e.tid] === 0) g0++; else g1++; }
    scoreAt[k] = [g0, g1];
  }
  cursor = 0; nextK = 0;
  endSession(false);
  goals.forEach((g) => g.cloth.reset());
  $("#matchno").textContent = `match ${matchNo} · seed ${seed}`;
  $("#caption").textContent = "kick-off — the pieces take the field";
}
const posAt = (k, i) => {
  const o = (Math.min(k, T_GAME - 1) * N + i) * 2;
  return [match.positions[o], match.positions[o + 1]];
};
function lerpPos(t, i) {
  const k = Math.min(Math.floor(t), T_GAME - 1), k2 = Math.min(k + 1, T_GAME - 1), a = t - k;
  const p = posAt(k, i), q = posAt(k2, i);
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 14) return a < 0.5 ? p : q;   // kickoff snap
  return [p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a];
}

/* --------------------------------------------------- shot physics session */
let session = null;                 // {gi, spec, t, T, prevL, ended}
const PHYS_H = 1 / 90;              // fixed step, match-seconds
let physAcc = 0;

function startSession(spec, k) {
  const team = teamOfTid[spec.ev.tid];
  const gi = team === 0 ? 1 : 0;                    // team 0 attacks pitch x=105
  const G = goals[gi];
  const srcW = toWorld(spec.src[0], spec.src[1], 0.25);
  const tgtW = toWorld(spec.target[0], spec.target[1], Math.max(0.12, spec.target[2]));
  const p0 = G.toL(srcW), p1 = G.toL(tgtW);
  const T = Math.max(0.35, spec.f * TICK);
  const damp = 0.25;
  const v0 = launchVelocity(p0, p1, T, GRAV);
  const comp = 1 + damp * T / 2;                    // linear-damping compensation
  G.body.setEnabled(true);
  G.body.setTranslation(p0, true);
  G.body.setLinvel({ x: v0.x * comp, y: v0.y * comp, z: v0.z * comp }, true);
  G.body.setAngvel({ x: 6 * Math.random() - 3, y: 0, z: 6 * Math.random() - 3 }, true);
  if (spec.outcome === "save") {                    // keeper piece blocks the lane
    const defT = 1 - team;
    const swIdx = PLAYERS.findIndex((p) => p.team === defT && p.slot === 0);
    const kp = posAt(k, swIdx);
    const kl = G.toL(toWorld(kp[0], kp[1], 0));
    G.keeper.setEnabled(true);
    G.keeper.setTranslation({ x: THREE.MathUtils.clamp(kl.x, -3.2, 3.2), y: 1.0, z: Math.max(0.5, kl.z) });
  }
  session = { gi, spec, k, t: 0, T, prevL: { ...p0 }, ended: false };
}
function endSession(blend = true) {
  if (!session) { goals.forEach((g) => { g.body.setEnabled(false); g.keeper.setEnabled(false); }); return; }
  const G = goals[session.gi];
  if (blend) {
    const tr = G.body.translation();
    blendFrom.copy(G.toW(tr)); blendT = 0.4;
  }
  G.body.setEnabled(false);
  G.keeper.setEnabled(false);
  session = null;
}
const blendFrom = new THREE.Vector3(); let blendT = 0;

/* ---------------------------------------------------------------- HUD */
let playing = true, speed = 3;
$("#play").onclick = () => { playing = !playing; $("#play").textContent = playing ? "❚❚" : "▶"; };
document.querySelectorAll("#transport .mode").forEach((el) => el.onclick = () => {
  document.querySelectorAll("#transport .mode").forEach((x) => x.classList.remove("active"));
  el.classList.add("active");
  speed = +el.dataset.speed;
});
const noteEl = $("#vignette-note");
let noteTimer = null;
function note(txt) {
  noteEl.textContent = txt;
  noteEl.style.opacity = 1;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { noteEl.style.opacity = 0; }, 2600);
}
const RESTART_NOTE = { throw_in: "THROW-IN", corner: "CORNER", goal_kick: "GOAL KICK", kickoff: "KICK-OFF" };

/* minimal orbit */
let dragging = false, px0 = 0, py0 = 0;
stage.addEventListener("pointerdown", (e) => { dragging = true; px0 = e.clientX; py0 = e.clientY; camDrift = false; });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  camTheta += (e.clientX - px0) * 0.004;
  camPhi = THREE.MathUtils.clamp(camPhi - (e.clientY - py0) * 0.003, 0.5, 1.25);
  px0 = e.clientX; py0 = e.clientY;
});
addEventListener("wheel", (e) => { camR = Math.min(230, Math.max(55, camR + e.deltaY * 0.08)); }, { passive: true });
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------------------------------------------------------- loop */
newMatch();
/* verification hooks (headless harness + debugging) */
window.__theater = {
  seek(t) { endSession(false); cursor = Math.max(0, t); nextK = Math.floor(cursor); blendT = 0; },
  info() {
    const k = Math.floor(cursor);
    return { cursor, k, matchNo, playing, session: session ? { ...session, spec: undefined } : null,
      ev: match.events[k] || null };
  },
  events(kind) {
    return match.events
      .filter((e) => (kind === "shot" ? e.type === "shot" : kind === "restart" ? !!e.restart
        : kind === "out" ? e.outcome === "out" || e.outcome === "deflected_out" : true))
      .map((e) => ({ k: e.k, type: e.type, outcome: e.outcome, restart: e.restart || null, post: e.post || null }));
  },
  setSpeed(v) { speed = v; },
  setPlaying(v) { playing = v; },
  balldbg() {
    const k = Math.max(0, Math.min(Math.floor(cursor), T_GAME - 1));
    const row = choreo.rows[k];
    return { cursor, k, b: choreo.ballAt(cursor), ev: match.events[k],
      src: row?.src || null, prevRest: row?.prevRest || null, rest: row?.rest || null,
      holder0: row?.holder0, holder1: row?.holder1,
      meshPos: { x: +ball.position.x.toFixed(2), y: +ball.position.y.toFixed(2), z: +ball.position.z.toFixed(2) },
      session: session ? { gi: session.gi, t: +session.t.toFixed(2), T: +session.T.toFixed(2) } : null };
  },
};
let lastTs = performance.now();
function frame(ts) {
  const dtWall = Math.max(0, Math.min(0.05, (ts - lastTs) / 1000));  // rAF ts can precede lastTs
  lastTs = ts;
  const k = Math.max(0, Math.min(Math.floor(cursor), T_GAME - 1));
  const pace = choreo.paceOf(k);
  const dtMatch = playing ? dtWall * speed / pace : 0;   // dilated match-seconds
  if (playing) {
    cursor += dtMatch / TICK;
    if (cursor >= T_GAME - 1) { note("FULL TIME"); newMatch(); requestAnimationFrame(frame); return; }
  }

  /* event edge: captions, notes, physics triggers */
  while (nextK <= Math.floor(cursor) && nextK < T_GAME) {
    const ev = match.events[nextK];
    if (ev) {
      $("#caption").textContent =
        captionOf(ev, (tid) => `№ ${tid}`, (tid) => (teamOfTid[tid] === 0 ? "Atlético" : "Sevilla"));
      if (ev.restart) note(`${RESTART_NOTE[ev.restart]} — ${teamOfTid[ev.tid] === 0 ? "ATLÉTICO" : "SEVILLA"}`);
      if (ev.type === "shot" && ev.outcome === "goal") note(`GOAL — № ${ev.tid}`);
      if (ev.type === "shot" && ev.outcome === "post") note(`OFF THE ${ev.post === "bar" ? "CROSSBAR" : "POST"}!`);
    }
    nextK++;
  }

  /* scoreboard + clock */
  $("#score").textContent = `${scoreAt[k][0]} — ${scoreAt[k][1]}`;
  const secs = Math.round(k * TICK);
  $("#clock").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  $("#half").textContent = `tick ${k}`;

  /* pieces */
  for (let i = 0; i < N; i++) {
    const [x, y] = lerpPos(cursor, i);
    const w = toWorld(x, y);
    pieces[i].grp.position.set(w.x, 0, w.z);
    pieces[i].sh.position.set(w.x, 0.011, w.z);
  }

  /* shot sessions: start when the launch instant passes */
  const spec = choreo.shotAt(k);
  const s = cursor - k;
  if (!session && playing && spec && s >= spec.s0 && s < 0.9) startSession(spec, k);
  if (session && (k > session.k + 1 || (k === session.k + 1 && s > 0.85))) endSession(true);

  /* physics stepping (in dilated match time) + cloth relaxation */
  physAcc = Math.min(physAcc + dtMatch, 8 * PHYS_H);
  while (physAcc >= PHYS_H) {
    physAcc -= PHYS_H;
    if (session) {
      const G = goals[session.gi];
      session.t += PHYS_H;
      G.world.timestep = PHYS_H;
      G.world.step();
      const tr = G.body.translation();
      G.cloth.step(PHYS_H, tr, BALL_R + 0.02, session.prevL);
      session.prevL = { x: tr.x, y: tr.y, z: tr.z };
      const lv = G.body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (session.t > session.T + 5 || (session.t > session.T && sp < 0.7)) endSession(true);
    }
  }
  for (const G of goals) if (!session || goals[session.gi] !== G) G.cloth.step(1 / 60, null);
  goals.forEach((G) => G.cloth.updateGeometry());

  /* the ball: physics session > blend > choreography */
  let bw;
  if (session) {
    const G = goals[session.gi];
    bw = G.toW(G.body.translation());
    const av = G.body.angvel();
    ball.rotation.x += av.x * dtMatch; ball.rotation.z += av.z * dtMatch;
  } else {
    const b = choreo.ballAt(cursor);
    if (b.mode === "held" && b.held != null) {
      const p = lerpPos(cursor, b.held);
      bw = toWorld(p[0], p[1], BALL_R);
      bw.x += 0.75; bw.z += 0.4;                    // at the piece's feet
    } else {
      bw = toWorld(b.x, b.y, Math.max(BALL_R, b.z + BALL_R));
    }
    ball.rotation.y += dtMatch * 1.5; ball.rotation.x += dtMatch * 0.9;
    if (blendT > 0) {
      blendT = Math.max(0, blendT - dtWall);
      const u = 1 - blendT / 0.4;
      bw.lerpVectors(blendFrom, bw, u * u);
    }
  }
  ball.position.copy(bw);
  ballSh.position.set(bw.x, 0.012, bw.z);
  const hsh = THREE.MathUtils.clamp(1.7 - bw.y * 0.25, 0.5, 1.7);
  ballSh.scale.set(hsh, hsh, 1);
  camFollow.copy(bw);

  placeCamera(ts, dtWall);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setTimeout(() => { loadingEl.style.opacity = 0; setTimeout(() => loadingEl.remove(), 900); }, 600);
