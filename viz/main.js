import * as THREE from "./vendor/three.module.js";

/* ---------------------------------------------------------------- palette */
const PAPER = 0xefe6d0, PAPER_DEEP = 0xe3d5b8, INK = 0x1c1712, INK_SOFT = 0x4a4036;
const TEAM_HEX = ["#2e64b0", "#a13a24"], GOLD = "#a97b17";
const TEAM_COL = [new THREE.Color(TEAM_HEX[0]), new THREE.Color(TEAM_HEX[1])];
const PITCH_L = 105, PITCH_W = 68;

/* ---------------------------------------------------------------- data */
async function j(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } }
const [SIM, EVO, FEAT] = await Promise.all([
  j("./assets/sim.json"), j("./assets/evolution.json"), j("./assets/features.json")]);

const loadingEl = document.getElementById("loading");
if (!SIM || !EVO) {
  loadingEl.querySelector(".mark").textContent = "awaiting pipeline output";
  throw new Error("run the pipeline first");
}
const N = SIM.tids.length, TEAMS = SIM.teams, TIDS = SIM.tids;
const evoByTid = Object.fromEntries(EVO.players.map(p => [p.tid, p]));
const featByTid = Object.fromEntries((FEAT?.players ?? []).map(p => [p.tid, p]));
const toWorld = ([x, y]) => new THREE.Vector3(x - PITCH_L / 2, 0, y - PITCH_W / 2);

/* ---------------------------------------------------------------- scene */
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAPER);
scene.fog = new THREE.Fog(PAPER, 150, 320);

const camera = new THREE.PerspectiveCamera(27, innerWidth / innerHeight, 1, 600);
let camTheta = 0.0, camPhi = 0.94, camR = 112, camDrift = true;
/* frame the action: aim at the centroid of observed play, biased toward pitch center */
const anchors = SIM.rho.map(r => toWorld(r));
const actionC = anchors.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / anchors.length);
const camTarget = actionC.multiplyScalar(0.75);
camTarget.y = 0;
function placeCamera(t) {
  const th = camTheta + (camDrift ? Math.sin(t * 0.00006) * 0.045 : 0);
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
sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.far = 220;
sun.shadow.bias = -0.0004;
scene.add(sun);

/* parchment ground */
function parchmentTexture() {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 680;
  const g = c.getContext("2d");
  g.fillStyle = "#e9dec2"; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 9000; i++) {
    const a = Math.random() * 0.05;
    g.fillStyle = Math.random() > .5 ? `rgba(120,95,60,${a})` : `rgba(255,250,235,${a})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1 + Math.random() * 2.4, 1 + Math.random() * 2.4);
  }
  for (let b = 0; b < 12; b++) { // whisper of mow bands
    if (b % 2) continue;
    g.fillStyle = "rgba(105,85,55,0.028)";
    g.fillRect(b * c.width / 12, 0, c.width / 12, c.height);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(PITCH_L + 26, PITCH_W + 22),
  new THREE.MeshStandardMaterial({ map: parchmentTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true;
scene.add(ground);

/* ink pitch lines */
function pitchLines() {
  const pts = [];
  const seg = (a, b) => { pts.push(toWorld(a), toWorld(b)); };
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
    circle(px, PITCH_W / 2, 9.15, side ? Math.PI - a : -a + 0, side ? Math.PI + a : a, 20);
    circle(side ? PITCH_L : 0, 0, 1.2, side ? Math.PI / 2 : 0, side ? Math.PI : Math.PI / 2, 8);
    circle(side ? PITCH_L : 0, PITCH_W, 1.2, side ? Math.PI : -Math.PI / 2 + Math.PI * 1.5, side ? Math.PI * 1.5 : Math.PI * 2, 8);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.75 }));
}
const lines = pitchLines(); lines.position.y = 0.02; scene.add(lines);

/* faint occupancy grid — the "chessboard" whisper */
{
  const pts = [];
  for (let i = 1; i < 10; i++) pts.push(toWorld([i * PITCH_L / 10, 0]), toWorld([i * PITCH_L / 10, PITCH_W]));
  for (let iy = 1; iy < 6; iy++) pts.push(toWorld([0, iy * PITCH_W / 6]), toWorld([PITCH_L, iy * PITCH_W / 6]));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.07 }));
  grid.position.y = 0.015; scene.add(grid);
}

/* goals: minimal ink frames */
for (const side of [0, 1]) {
  const gx = side ? PITCH_L : 0, d = side ? 1.4 : -1.4;
  const p = [[gx, (PITCH_W - 7.32) / 2], [gx, (PITCH_W + 7.32) / 2]];
  const posts = new THREE.Group();
  for (const q of p) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 5),
      new THREE.MeshStandardMaterial({ color: INK, roughness: .6, flatShading: true }));
    m.position.copy(toWorld(q)); m.position.y = 1.3; posts.add(m);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 7.32, 5),
    new THREE.MeshStandardMaterial({ color: INK, roughness: .6, flatShading: true }));
  bar.rotation.x = Math.PI / 2; bar.position.copy(toWorld([gx, PITCH_W / 2])); bar.position.y = 2.6;
  posts.add(bar); scene.add(posts);
}

/* ---------------------------------------------------------------- pieces */
function pawnGeometry() {           // team 0 — faceted pawn
  const prof = [[0.95, 0], [0.95, 0.16], [0.55, 0.34], [0.42, 1.05], [0.30, 1.55], [0.52, 1.78], [0.30, 2.02], [0.44, 2.35], [0.001, 2.62]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(prof, 8);
  return g.toNonIndexed();
}
function obeliskGeometry() {        // team 1 — tapered obelisk
  const g1 = new THREE.CylinderGeometry(0.34, 0.72, 2.1, 4, 1);
  g1.translate(0, 1.05, 0);
  const g2 = new THREE.ConeGeometry(0.4, 0.55, 4);
  g2.translate(0, 2.35, 0);
  const base = new THREE.CylinderGeometry(0.95, 0.95, 0.16, 8);
  base.translate(0, 0.08, 0);
  const merged = mergeGeoms([base.toNonIndexed(), g1.toNonIndexed(), g2.toNonIndexed()]);
  return merged;
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
const GEO = [pawnGeometry(), obeliskGeometry()];
const PIECE_MAT = new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.62, metalness: 0.05, flatShading: true });
const GHOST_MATS = [0, 1].map(t => new THREE.MeshBasicMaterial({
  color: TEAM_COL[t], wireframe: true, transparent: true, opacity: 0.4 }));

function blobShadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, "rgba(40,28,14,0.42)"); r.addColorStop(1, "rgba(40,28,14,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const blobTex = blobShadowTexture();

class Piece {
  constructor(team, tid, ghost = false) {
    this.team = team; this.tid = tid; this.ghost = ghost;
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(GEO[team], ghost ? GHOST_MATS[team] : PIECE_MAT.clone());
    this.mesh.castShadow = !ghost;
    this.mesh.userData.piece = this;
    this.group.add(this.mesh);
    if (!ghost) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.09, 4, 24),
        new THREE.MeshBasicMaterial({ color: TEAM_COL[team] }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.06;
      this.group.add(ring);
      const sh = new THREE.Sprite(new THREE.SpriteMaterial({ map: blobTex, depthWrite: false }));
      sh.scale.set(3.6, 3.6, 1); sh.position.y = 0.01;
      sh.material.rotation = 0; this.shadowSprite = sh;
      // trail
      this.trailN = 46; this.trailPos = new Float32Array(this.trailN * 3);
      this.trailCol = new Float32Array(this.trailN * 3);
      const tg = new THREE.BufferGeometry();
      tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
      tg.setAttribute("color", new THREE.BufferAttribute(this.trailCol, 3));
      this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 }));
      this.trail.frustumCulled = false;
      scene.add(this.trail);
      this.trailPts = [];
    }
    scene.add(this.group);
    if (this.shadowSprite) scene.add(this.shadowSprite);
    this.visibleTarget = 1;
  }
  setPos(p, visible = true) {
    if (p) { this.group.position.copy(toWorld(p)); }
    this.visibleTarget = visible && p ? 1 : 0.12;
    if (this.shadowSprite && p) this.shadowSprite.position.set(this.group.position.x, 0.01, this.group.position.z);
  }
  pushTrail() {
    if (!this.trail) return;
    this.trailPts.push(this.group.position.clone());
    if (this.trailPts.length > this.trailN) this.trailPts.shift();
    const paper = new THREE.Color(PAPER), inkc = TEAM_COL[this.team].clone().lerp(new THREE.Color(INK), 0.35);
    for (let i = 0; i < this.trailN; i++) {
      const p = this.trailPts[Math.max(0, this.trailPts.length - this.trailN + i)] ?? this.trailPts[0] ?? this.group.position;
      this.trailPos[i * 3] = p.x; this.trailPos[i * 3 + 1] = 0.08; this.trailPos[i * 3 + 2] = p.z;
      const a = i / this.trailN;
      const c = paper.clone().lerp(inkc, a * a * 0.9);
      this.trailCol[i * 3] = c.r; this.trailCol[i * 3 + 1] = c.g; this.trailCol[i * 3 + 2] = c.b;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.color.needsUpdate = true;
  }
  clearTrail() { this.trailPts.length = 0; if (this.trail) this.trail.visible = false; }
  tick(dt) {
    const target = this.visibleTarget;
    const m = this.mesh.material;
    if (!this.ghost) { m.opacity = m.opacity ?? 1; m.transparent = true; m.opacity += (target - m.opacity) * Math.min(1, dt * 6); }
    if (this.trail) this.trail.visible = this.trailPts.length > 2;
  }
}

const pieces = [], ghosts = [];
for (let i = 0; i < N; i++) {
  pieces.push(new Piece(TEAMS[i], TIDS[i], false));
  ghosts.push(new Piece(TEAMS[i], TIDS[i], true));
  ghosts[i].group.visible = false;
}
/* ball */
const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(GOLD), roughness: 0.35, metalness: 0.35, flatShading: true }));
ball.castShadow = true; ball.position.y = 0.62; scene.add(ball);
const ballGhost = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD), wireframe: true, transparent: true, opacity: 0.5 }));
ballGhost.visible = false; scene.add(ballGhost);

/* pass flash lines (dream mode) */
const flashes = [];
function flashPass(a, b) {
  const g = new THREE.BufferGeometry().setFromPoints([a.clone().setY(1.4), b.clone().setY(1.4)]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: new THREE.Color(GOLD), transparent: true, opacity: 0.9 }));
  scene.add(l); flashes.push({ l, life: 1 });
}

/* ---------------------------------------------------------------- timeline */
const OBS = SIM.observed, BOBS = SIM.ball_observed;
const T_OBS = OBS.length, DT = SIM.dt;
const modes = { REPLAY: "replay", SHADOW: "shadow", DREAM: "dream" };
let mode = modes.REPLAY, playing = true, tCursor = 0, speed = 1;
const durations = {
  replay: (T_OBS - 1) * DT,
  shadow: (SIM.shadow.xs.length - 1) * DT,
  dream: (SIM.dream.xs.length - 1) * SIM.dream.dt,
};
const scrub = document.getElementById("scrub"), clock = document.getElementById("clock");
const divEl = document.getElementById("divergence");
const playBtn = document.getElementById("play");

function sample(arr, t, dt) {
  const f = Math.min(t / dt, arr.length - 1.001);
  const i = Math.floor(f), a = f - i;
  const p0 = arr[i], p1 = arr[Math.min(i + 1, arr.length - 1)];
  if (p0 == null) return p1;
  if (p1 == null) return p0;
  return [p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a];
}

/* precomputed per-player position columns (avoid per-frame maps) */
const OBS_COL = Array.from({ length: N }, (_, i2) => OBS.map(r => r[i2]));
const SHADOW_COL = Array.from({ length: N }, (_, i2) => SIM.shadow.xs.map(r => r[i2]));
const DREAM_COL = Array.from({ length: N }, (_, i2) => SIM.dream.xs.map(r => r[i2]));

let lastTrailPush = 0;
function updateWorld(now) {
  const dur = durations[mode];
  if (playing) { tCursor += (now - (updateWorld.last ?? now)) / 1000 * speed; if (tCursor > dur) tCursor = 0, resetTrails(); }
  updateWorld.last = now;
  scrub.value = Math.round(tCursor / dur * 1000);
  clock.textContent = `${tCursor.toFixed(1)} s`;

  const pushTrails = now - lastTrailPush > 90;
  if (pushTrails) lastTrailPush = now;

  if (mode === modes.REPLAY) {
    for (let i2 = 0; i2 < N; i2++) {
      const p = sample(OBS_COL[i2], tCursor, DT);
      pieces[i2].setPos(p, p != null);
      ghosts[i2].group.visible = false;
      if (pushTrails && playing) pieces[i2].pushTrail();
    }
    const bp = BOBS ? sample(BOBS, tCursor, DT) : null;
    if (bp) { ball.position.copy(toWorld(bp)); ball.position.y = 0.62; ball.visible = true; } else ball.visible = false;
    ballGhost.visible = false;
    divEl.textContent = "";
  } else if (mode === modes.SHADOW) {
    const off = SIM.shadow.start * DT;
    for (let i2 = 0; i2 < N; i2++) {
      const p = sample(OBS_COL[i2], Math.min(off + tCursor, (T_OBS - 1) * DT), DT);
      pieces[i2].setPos(p, p != null);
      const gp = sample(SHADOW_COL[i2], tCursor, DT);
      ghosts[i2].group.visible = true;
      ghosts[i2].setPos(gp, true);
      if (pushTrails && playing) pieces[i2].pushTrail();
    }
    const bp = BOBS ? sample(BOBS, Math.min(off + tCursor, (T_OBS - 1) * DT), DT) : null;
    if (bp) { ball.position.copy(toWorld(bp)); ball.position.y = 0.62; ball.visible = true; } else ball.visible = false;
    const gb = sample(SIM.shadow.ball, tCursor, DT);
    ballGhost.visible = true; ballGhost.position.copy(toWorld(gb)); ballGhost.position.y = 0.62;
    const di = Math.min(Math.floor(tCursor / DT), SIM.shadow.divergence.length - 1);
    const dv = SIM.shadow.divergence[di];
    divEl.textContent = dv != null ? `engine ↔ reality: ${dv.toFixed(1)} m` : "";
  } else {
    for (let i2 = 0; i2 < N; i2++) {
      const p = sample(DREAM_COL[i2], tCursor, SIM.dream.dt);
      pieces[i2].setPos(p, true);
      ghosts[i2].group.visible = false;
      if (pushTrails && playing) pieces[i2].pushTrail();
    }
    const bp = sample(SIM.dream.ball, tCursor, SIM.dream.dt);
    ball.visible = true; ball.position.copy(toWorld(bp)); ball.position.y = 0.62;
    ballGhost.visible = false;
    const k = Math.floor(tCursor / SIM.dream.dt) * 2;
    for (const e of SIM.dream.events) {
      if (e.type === "pass" && Math.abs(e.k - k) < 1.5 && !e.flashed) {
        e.flashed = true;
        flashPass(pieces[e.from].group.position, pieces[e.to].group.position);
      }
    }
    divEl.textContent = "the engine dreams the game forward";
  }
  ball.rotation.y += 0.02; ball.rotation.x += 0.013;
}
function resetTrails() { pieces.forEach(p => p.clearTrail()); SIM.dream.events.forEach(e => delete e.flashed); }

/* transport wiring */
playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; };
playBtn.textContent = "❚❚";
scrub.oninput = () => { tCursor = scrub.value / 1000 * durations[mode]; };
document.querySelectorAll("#transport .mode").forEach(el => el.onclick = () => {
  document.querySelectorAll("#transport .mode").forEach(x => x.classList.remove("active"));
  el.classList.add("active");
  mode = el.dataset.mode; tCursor = 0; resetTrails();
});

/* minimal orbit: drag to rotate, wheel to zoom */
let dragging = false, px0 = 0;
stage.addEventListener("pointerdown", e => { dragging = true; px0 = e.clientX; camDrift = false; });
addEventListener("pointerup", () => dragging = false);
addEventListener("pointermove", e => {
  if (dragging) { camTheta += (e.clientX - px0) * 0.004; px0 = e.clientX; }
});
addEventListener("wheel", e => { camR = Math.min(210, Math.max(70, camR + e.deltaY * 0.08)); }, { passive: true });

/* picking */
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
stage.addEventListener("click", e => {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects(pieces.map(p => p.mesh));
  if (hits.length) selectPlayer(hits[0].object.userData.piece.tid);
});

/* ---------------------------------------------------------------- views */
const views = { board: null, film: document.getElementById("film"), evolution: document.getElementById("evolution") };
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  for (const k of ["film", "evolution"]) views[k].classList.remove("open");
  document.body.classList.toggle("overlay-open", b.dataset.view !== "board");
  if (b.dataset.view !== "board") views[b.dataset.view].classList.add("open");
});
document.getElementById("segvideo").addEventListener("loadedmetadata", e =>
  document.getElementById("filmmeta").textContent = `${e.target.duration.toFixed(1)} s · ${e.target.videoWidth}×${e.target.videoHeight}`);

/* ---------------------------------------------------------------- roster + player card */
const zstats = {};
{
  const keys = ["pace", "discipline", "ball_affinity", "cooperation", "aggression"];
  for (const k of keys) {
    const vals = EVO.players.map(p => p.style[k] ?? 0);
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length) || 1;
    zstats[k] = { mu, sd };
  }
}
function roleOf(p) {
  const team = p.team, ad = featByTid[p.tid]?.attack_dir ?? 1;
  const xs = EVO.players.filter(q => q.team === team).map(q => q.rho[0] * ad).sort((a, b) => a - b);
  const r = xs.indexOf(p.rho[0] * ad) / Math.max(1, xs.length - 1);
  return r < 0.34 ? "rear guard" : r < 0.67 ? "middle rank" : "vanguard";
}
const rosterList = document.getElementById("rosterlist");
let selectedTid = null;
for (const p of [...EVO.players].sort((a, b) => a.team - b.team || a.tid - b.tid)) {
  const row = document.createElement("div");
  row.className = "rosterrow"; row.dataset.tid = p.tid;
  row.innerHTML = `<span class="dot" style="background:${TEAM_HEX[p.team]}"></span>
    <span>№ ${p.tid}</span><span class="f">${p.final_F.toFixed(2)}</span>`;
  row.onclick = () => selectPlayer(p.tid);
  rosterList.appendChild(row);
}

function tokenGlyph(tok, size = 15) {
  if (tok === -1) return `<svg width="${size}" height="${size}"><text x="50%" y="72%" text-anchor="middle" font-size="11" fill="#8a7d6a">·</text></svg>`;
  if (tok === 0) return `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="2.2" fill="#4a4036"/></svg>`;
  const band = Math.floor((tok - 1) / 8) + 1, oct = (tok - 1) % 8;
  const ang = ((oct + 0.5) / 8) * 360 - 180;
  const w = 0.7 + band * 0.55;
  return `<svg width="${size}" height="${size}" viewBox="-8 -8 16 16">
    <g transform="rotate(${ang})"><line x1="-4.5" y1="0" x2="3.6" y2="0" stroke="#1c1712" stroke-width="${w}"/>
    <path d="M2.6,-2.6 L6.2,0 L2.6,2.6" fill="none" stroke="#1c1712" stroke-width="${w}"/></g></svg>`;
}

function selectPlayer(tid) {
  selectedTid = tid;
  document.querySelectorAll(".rosterrow").forEach(r => r.classList.toggle("sel", +r.dataset.tid === tid));
  pieces.forEach(p => {
    const on = p.tid === tid;
    p.mesh.material.emissive = new THREE.Color(on ? 0x8a6a10 : 0x000000);
    p.mesh.material.emissiveIntensity = on ? 0.22 : 0;
  });
  const p = evoByTid[tid], f = featByTid[tid];
  const card = document.getElementById("playercard");
  card.classList.add("open");
  document.getElementById("pcname").textContent = `Piece № ${tid}`;
  document.getElementById("pcrole").textContent =
    `${p.team === 0 ? "Atlético (blue)" : "Sevilla (crimson)"} · ${roleOf(p)} · fitness ${p.final_F.toFixed(2)}${p.val_F ? ` (val ${p.val_F.toFixed(2)})` : ""}`;
  const attrs = document.getElementById("pcattrs");
  const rows = [["pace", "pace"], ["discipline", "discipline"], ["ball_affinity", "ball affinity"],
    ["cooperation", "cooperation"], ["aggression", "aggression"]];
  attrs.innerHTML = rows.map(([k, label]) => {
    const z = Math.max(-2.2, Math.min(2.2, ((p.style[k] ?? 0) - zstats[k].mu) / zstats[k].sd));
    const pct = z / 2.2 * 50;
    const left = z < 0 ? 50 + pct : 50, wdt = Math.abs(pct);
    return `<div class="attr"><span class="name">${label}</span>
      <span class="barwrap"><span class="baseline"></span>
      <span class="bar" style="left:${left}%;width:${wdt}%"></span></span>
      <span class="val">${(p.style[k] ?? 0).toFixed(2)}</span></div>`;
  }).join("") + `<div class="attr"><span class="name">stamina</span>
      <span style="font-size:10.5px;font-style:italic;color:var(--ink-faint)">n/a — clip too short to identify</span></div>`;
  // motifs
  const ml = document.getElementById("motiflist");
  if (f && FEAT.codebook?.length && f.fingerprint?.length) {
    const top = f.fingerprint.map((w, i2) => [w, i2]).sort((a, b) => b[0] - a[0]).slice(0, 5);
    const wmax = top[0][0] || 1;
    ml.innerHTML = top.map(([w, i2]) => {
      const gram = FEAT.codebook[i2];
      return `<div class="motifrow">${gram.map(t => tokenGlyph(t)).join("")}
        <span class="mbar" style="width:${Math.round(w / wmax * 80)}px"></span>
        <span class="mc">${w.toFixed(3)}</span></div>`;
    }).join("");
  } else ml.innerHTML = `<div style="font-size:11px;color:var(--ink-faint);font-style:italic">no motifs mined</div>`;
  const pr = document.getElementById("paramrows");
  pr.innerHTML = Object.entries(p.params).map(([k, v]) => `<span>${k}</span><span>${(+v).toFixed(3)}</span>`).join("");
  drawFitness();
}

/* ---------------------------------------------------------------- charts */
const tooltip = document.getElementById("tooltip");
function showTip(html, x, y) { tooltip.innerHTML = html; tooltip.style.display = "block"; tooltip.style.left = (x + 14) + "px"; tooltip.style.top = (y + 10) + "px"; }
function hideTip() { tooltip.style.display = "none"; }

function linePath(xs, ys) { return xs.map((x, i2) => `${i2 ? "L" : "M"}${x.toFixed(1)},${ys[i2].toFixed(1)}`).join(""); }

function drawFitness() {
  const el = document.getElementById("fitchart");
  const W = 990, H = 300, padL = 44, padR = 14, padT = 10, padB = 30;
  const G = Math.max(...EVO.players.map(p => p.gens.length));
  const allF = EVO.players.flatMap(p => p.gens.map(g => g.elite));
  const ymin = Math.min(...allF, 0.55), ymax = Math.min(Math.max(...allF, 1.15), 2.2);
  const X = g => padL + g / (G - 1) * (W - padL - padR);
  const Y = v => padT + (1 - (Math.min(v, ymax) - ymin) / (ymax - ymin)) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  for (let v = Math.ceil(ymin * 5) / 5; v <= ymax + 1e-9; v += 0.2) {
    s += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="#d8c9a8" stroke-width="1"/>
          <text x="${padL - 8}" y="${Y(v) + 3.5}" text-anchor="end" font-size="10" fill="#8a7d6a">${v.toFixed(1)}</text>`;
  }
  s += `<line x1="${padL}" y1="${Y(1)}" x2="${W - padR}" y2="${Y(1)}" stroke="#4a4036" stroke-width="1" stroke-dasharray="4 4"/>
        <text x="${W - padR - 4}" y="${Y(1) - 5}" text-anchor="end" font-size="10" font-style="italic" fill="#4a4036">inertial parity</text>`;
  for (let g = 0; g < G; g += 10)
    s += `<text x="${X(g)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#8a7d6a">${g}</text>`;
  s += `<text x="${(padL + W - padR) / 2}" y="${H - 8 + 0}" text-anchor="middle" font-size="0" fill="#8a7d6a"></text>`;
  for (const p of EVO.players) {
    const sel = p.tid === selectedTid;
    const xs = p.gens.map(g2 => X(g2.g + (p.gens.length < G ? 0 : 0))).slice(0, G);
    const ys = p.gens.map(g2 => Y(g2.elite));
    s += `<path d="${linePath(xs, ys)}" fill="none" stroke="${sel ? TEAM_HEX[p.team] : "#4a4036"}"
      stroke-width="${sel ? 2.4 : 1}" opacity="${sel ? 1 : 0.22}" data-tid="${p.tid}"/>`;
    if (sel) {
      const last = p.gens[p.gens.length - 1];
      s += `<circle cx="${X(last.g)}" cy="${Y(last.elite)}" r="3.4" fill="${TEAM_HEX[p.team]}"/>
        <text x="${X(last.g) - 8}" y="${Y(last.elite) - 8}" text-anchor="end" font-size="11" fill="#1c1712">№ ${p.tid} — ${last.elite.toFixed(2)}</text>`;
    }
  }
  s += `</svg>`;
  el.innerHTML = s;
  el.querySelector("svg").addEventListener("mousemove", e => {
    const r = el.querySelector("svg").getBoundingClientRect();
    const g = Math.round((e.clientX - r.left) / r.width * (W) - padL) / ((W - padL - padR)) * (G - 1);
    const gi = Math.max(0, Math.min(G - 1, Math.round(g)));
    const p = selectedTid != null ? evoByTid[selectedTid] : EVO.players[0];
    const gen = p.gens[Math.min(gi, p.gens.length - 1)];
    showTip(`№ ${p.tid} · gen ${gen.g}<br>elite F ${gen.elite.toFixed(3)} · median ${gen.median.toFixed(3)}<br>σ<sub>cma</sub> ${gen.sigma_cma}`, e.clientX, e.clientY);
  });
  el.querySelector("svg").addEventListener("mouseleave", hideTip);
  document.getElementById("fitlegend").innerHTML =
    `<span><i style="width:14px;height:2px;background:${TEAM_HEX[0]};display:inline-block"></i> Atlético</span>
     <span><i style="width:14px;height:2px;background:${TEAM_HEX[1]};display:inline-block"></i> Sevilla</span>
     <span style="font-style:italic">select a piece to emphasize its lineage</span>`;
  // table twin
  const tb = document.getElementById("fittable");
  tb.innerHTML = `<table class="datat"><tr><th>piece</th><th>team</th><th>seed F</th><th>final F</th><th>val F</th><th>v max</th><th>σ</th><th>k ball</th></tr>` +
    EVO.players.map(p => `<tr><td>№ ${p.tid}</td><td>${p.team === 0 ? "ATM" : "SEV"}</td>
      <td>${p.seed_F.toFixed(2)}</td><td>${p.final_F.toFixed(2)}</td><td>${p.val_F?.toFixed(2) ?? "—"}</td>
      <td>${p.params.v_max.toFixed(1)}</td><td>${p.params.sigma.toFixed(2)}</td><td>${p.params.k_ball.toFixed(2)}</td></tr>`).join("") + `</table>`;
}
document.querySelector('[data-t="fittable"]').onclick = e => {
  const t = document.getElementById("fittable"), c = document.getElementById("fitchart");
  const showT = t.style.display === "none";
  t.style.display = showT ? "block" : "none"; c.style.display = showT ? "none" : "block";
  e.target.textContent = showT ? "chart" : "table";
};

function drawTactics() {
  const el = document.getElementById("tacchart");
  const W = 440, H = 170, padL = 40, padR = 12, padT = 10, padB = 26;
  const data = SIM.tactics;
  const ys = data.map(d => d.best), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const X = i2 => padL + i2 / (data.length - 1) * (W - padL - padR);
  const Y = v => padT + (1 - (v - ymin) / (ymax - ymin + 1e-9)) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  for (let i2 = 0; i2 <= 2; i2++) {
    const v = ymin + (ymax - ymin) * i2 / 2;
    s += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="#d8c9a8"/>
          <text x="${padL - 6}" y="${Y(v) + 3}" text-anchor="end" font-size="9.5" fill="#8a7d6a">${v.toFixed(2)}</text>`;
  }
  s += `<path d="${linePath(data.map((_, i2) => X(i2)), ys.map(Y))}" fill="none" stroke="#1c1712" stroke-width="2"/>`;
  data.forEach((d, i2) => { if (i2 % 3 === 0 || i2 === data.length - 1) s += `<text x="${X(i2)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="#8a7d6a">${d.g}</text>`; });
  const last = data[data.length - 1];
  s += `<circle cx="${X(data.length - 1)}" cy="${Y(last.best)}" r="3" fill="#a97b17"/>`;
  s += `</svg>`;
  el.innerHTML = s;
  const v = last.vector;
  document.getElementById("tacmeters").innerHTML = Object.entries({
    "line height": v.line_height, "width": v.width, "ball reactivity": v.ball_reactivity, "pressing": v.pressing,
  }).map(([k, val]) => `<div class="meterrow"><span class="name">${k}</span>
    <span class="track"><span class="fill" style="width:${Math.round(val * 100)}%"></span></span>
    <span class="val">${val.toFixed(2)}</span></div>`).join("");
}

function drawTransfer() {
  const t = SIM.transfer;
  document.getElementById("transfernote").textContent =
    `replacing № ${t.slot_tid} (weakest fit on the ${t.host_team === 0 ? "Atlético" : "Sevilla"} side) — candidates from the opposing XI, scored by formation integrity + occupancy preservation`;
  const max = Math.max(...t.candidates.map(c => c.fit_score));
  document.getElementById("transferlist").innerHTML = t.candidates.slice(0, 8).map((c, i2) =>
    `<div class="meterrow"><span class="name">${i2 === 0 ? "◆ " : ""}№ ${c.tid}</span>
      <span class="track"><span class="fill" style="width:${Math.round(c.fit_score / max * 100)}%;background:${i2 === 0 ? "#a97b17" : "#1c1712"}"></span></span>
      <span class="val">${c.fit_score.toFixed(3)}</span></div>`).join("");
}

function drawDivergence() {
  const el = document.getElementById("divchart");
  const W = 990, H = 180, padL = 44, padR = 14, padT = 10, padB = 26;
  const d = SIM.shadow.divergence.filter(x => x != null);
  const ymax = Math.max(...d) * 1.15;
  const X = i2 => padL + i2 / (d.length - 1) * (W - padL - padR);
  const Y = v => padT + (1 - v / ymax) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  for (let v = 0; v <= ymax; v += Math.ceil(ymax / 4)) {
    s += `<line x1="${padL}" y1="${Y(v)}" x2="${W - padR}" y2="${Y(v)}" stroke="#d8c9a8"/>
          <text x="${padL - 8}" y="${Y(v) + 3.5}" text-anchor="end" font-size="10" fill="#8a7d6a">${v} m</text>`;
  }
  s += `<path d="${linePath(d.map((_, i2) => X(i2)), d.map(Y))} L${X(d.length - 1)},${Y(0)} L${X(0)},${Y(0)} Z" fill="#1c1712" opacity="0.07"/>`;
  s += `<path d="${linePath(d.map((_, i2) => X(i2)), d.map(Y))}" fill="none" stroke="#1c1712" stroke-width="2"/>`;
  for (let sec = 0; sec <= (d.length - 1) * DT; sec += 3)
    s += `<text x="${X(sec / DT)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#8a7d6a">${sec}s</text>`;
  s += `</svg>`;
  el.innerHTML = s;
}

drawFitness(); drawTactics(); drawTransfer(); drawDivergence();
selectPlayer(EVO.players.reduce((a, b) => a.final_F < b.final_F ? a : b).tid);

/* ---------------------------------------------------------------- loop */
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  updateWorld(now);
  placeCamera(now);
  pieces.forEach(p => p.tick(dt)); ghosts.forEach(p => p.tick(dt));
  for (let i2 = flashes.length - 1; i2 >= 0; i2--) {
    const f = flashes[i2]; f.life -= dt * 1.2; f.l.material.opacity = Math.max(0, f.life) * 0.9;
    if (f.life <= 0) { scene.remove(f.l); flashes.splice(i2, 1); }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setTimeout(() => { loadingEl.style.opacity = 0; setTimeout(() => loadingEl.remove(), 900); }, 500);
