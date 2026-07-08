import * as THREE from "./vendor/three.module.js";
import RAPIER from "./vendor/rapier3d-compat.js";
import { buildGoal, NetCloth, launchVelocity } from "./goal-physics.js";

/* physics-test — standalone proving ground: rapier ball vs regulation goal frame,
   verlet net catch, ballistic launch buttons. Goal mouth at z=0, shots from z=+16. */

await RAPIER.init();

/* ---------------------------------------------------------------- palette */
const PAPER = 0xefe6d0, INK = 0x1c1712, GOLD = 0xa97b17;

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
scene.fog = new THREE.Fog(PAPER, 55, 130);

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 300);
let camTheta = 0.55, camPhi = 1.18, camR = 16, camDrift = true;
const camTarget = new THREE.Vector3(0, 1.4, 1.5);
function placeCamera(t) {
  const th = camTheta + (camDrift ? Math.sin(t * 0.00006) * 0.05 : 0);
  camera.position.set(camTarget.x + camR * Math.sin(camPhi) * Math.sin(th),
    camTarget.y + camR * Math.cos(camPhi),
    camTarget.z + camR * Math.sin(camPhi) * Math.cos(th));
  camera.lookAt(camTarget);
}

scene.add(new THREE.HemisphereLight(0xfff6e0, 0xb09b72, 1.15));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
sun.position.set(-12, 20, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.far = 60;
sun.shadow.bias = -0.0004;
scene.add(sun);

/* parchment ground (trimmed from main.js) */
function parchmentTexture() {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 1024;
  const g = c.getContext("2d");
  g.fillStyle = "#e9dec2"; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 9000; i++) {
    const a = Math.random() * 0.05;
    g.fillStyle = Math.random() > .5 ? `rgba(120,95,60,${a})` : `rgba(255,250,235,${a})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1 + Math.random() * 2.4, 1 + Math.random() * 2.4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const groundTex = parchmentTexture();
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(3, 2);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(180, 120),
  new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

/* ink marks: goal line + penalty spot */
{
  const pts = [new THREE.Vector3(-12, 0.01, 0), new THREE.Vector3(12, 0.01, 0)];
  for (let i = 0; i < 10; i++) {
    const a0 = i / 10 * Math.PI * 2, a1 = (i + 1) / 10 * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a0) * 0.22, 0.01, 11 + Math.sin(a0) * 0.22),
      new THREE.Vector3(Math.cos(a1) * 0.22, 0.01, 11 + Math.sin(a1) * 0.22));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.75 })));
}

/* ---------------------------------------------------------------- physics */
const H = 1 / 60, BALL_R = 0.11, LIN_DAMP = 0.05;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
world.createCollider(RAPIER.ColliderDesc.cuboid(120, 0.1, 90).setTranslation(0, -0.1, 0)
  .setRestitution(0.6).setFriction(0.8));   // oversized vs the visual plane so misses roll away, not off the edge

const goal = buildGoal(scene, world, RAPIER);
const net = new NetCloth({ halfW: goal.hw, barY: goal.barY, depth: goal.depth });
scene.add(net.object3d);

const ballMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1),
  new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.35, flatShading: true }));
ballMesh.castShadow = true;
scene.add(ballMesh);
const ballBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
  .setTranslation(0, BALL_R, 16)
  .setLinearDamping(LIN_DAMP).setAngularDamping(0.6)
  .setCcdEnabled(true));                       // 25+ m/s vs a 6 cm post tunnels without CCD
world.createCollider(RAPIER.ColliderDesc.ball(BALL_R)
  .setRestitution(0.65).setFriction(0.6).setDensity(77), ballBody);   // ≈ 0.43 kg

/* ---------------------------------------------------------------- shots */
/* [label, p0, target, T] — launchVelocity gives the exact ballistic arc;
   ×(1 + c·T/2) first-order make-up for linear damping so it still lands on target */
const SHOTS = [
  ["into top corner", { x: 1, y: 0.25, z: 16 }, { x: 3.3, y: 2.2, z: -0.2 }, 0.62],
  ["off left post", { x: 0.5, y: 0.25, z: 16 }, { x: -3.72, y: 1.5, z: 0 }, 0.60],
  ["off crossbar", { x: 0, y: 0.25, z: 16 }, { x: 0.6, y: 2.5, z: 0 }, 0.60],
  ["wide", { x: -1, y: 0.25, z: 16 }, { x: 5.4, y: 1.7, z: -2 }, 0.72],
  ["low daisy-cutter goal", { x: 2, y: 0.15, z: 16 }, { x: -2.9, y: 0.16, z: -0.4 }, 0.55],
];
const shotName = document.getElementById("shotname"), outcomeEl = document.getElementById("outcome");
let outcome = "", prevZ = 16, prevVz = 0;
function setOutcome(s) { if (outcome !== s) { outcome = s; outcomeEl.textContent = s; } }

function launch([label, p0, target, T]) {
  const v = launchVelocity(p0, target, T), k = 1 + LIN_DAMP * T / 2;
  ballBody.setTranslation(p0, true);
  ballBody.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
  ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  net.reset();
  shotName.textContent = label;
  setOutcome("…");
  prevZ = p0.z; prevVz = v.z;
}
const shotsEl = document.getElementById("shots");
for (const s of SHOTS) {
  const b = document.createElement("button");
  b.textContent = s[0];
  b.onclick = () => launch(s);
  shotsEl.appendChild(b);
}

/* ---------------------------------------------------------------- stepping */
function substep() {
  const pPrev = ballBody.translation();      // pre-step pos → swept cloth collision
  world.step();
  const p = ballBody.translation();
  const contacts = net.step(H, p, BALL_R, pPrev);
  // the net catches: drag while inside the goal box, strong while the cloth is touching,
  // so the ball never flies through the back — the catch-box walls are the last resort
  const inNet = p.z < -0.06 && Math.abs(p.x) < 3.9 && p.y < 2.7;
  if (inNet) {
    const k = contacts > 0 ? 0.66 : 0.9;
    const v = ballBody.linvel(), w = ballBody.angvel();
    ballBody.setLinvel({ x: v.x * (k + 0.1), y: v.y * (k + 0.1), z: v.z * k }, true);
    ballBody.setAngvel({ x: w.x * 0.85, y: w.y * 0.85, z: w.z * 0.85 }, true);
  }
  // outcome heuristics
  const v = ballBody.linvel();
  if (prevZ > 0 && p.z <= 0)
    setOutcome(Math.abs(p.x) < 3.66 && p.y < 2.44 ? "GOAL" : "off target");
  if (outcome !== "GOAL" && prevVz < -2 && v.z > 2 && p.z > -0.5 && p.z < 1.5)
    setOutcome("off the woodwork!");
  prevZ = p.z; prevVz = v.z;
}

/* ---------------------------------------------------------------- orbit (main.js pattern) */
let dragging = false, px0 = 0, py0 = 0;
stage.addEventListener("pointerdown", e => { dragging = true; px0 = e.clientX; py0 = e.clientY; camDrift = false; });
addEventListener("pointerup", () => dragging = false);
addEventListener("pointermove", e => {
  if (!dragging) return;
  camTheta += (e.clientX - px0) * 0.004; px0 = e.clientX;
  camPhi = Math.min(1.5, Math.max(0.35, camPhi + (e.clientY - py0) * 0.003)); py0 = e.clientY;
});
addEventListener("wheel", e => { camR = Math.min(40, Math.max(6, camR + e.deltaY * 0.02)); }, { passive: true });
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------------------------------------------------------- loop: fixed dt accumulator */
let acc = 0, lastT = performance.now();
function loop(now) {
  acc += Math.min(0.1, (now - lastT) / 1000); lastT = now;
  while (acc >= H) { substep(); acc -= H; }
  const p = ballBody.translation(), q = ballBody.rotation();
  ballMesh.position.set(p.x, p.y, p.z);
  ballMesh.quaternion.set(q.x, q.y, q.z, q.w);
  net.updateGeometry();
  placeCamera(now);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
launch(SHOTS[0]);
requestAnimationFrame(loop);
document.getElementById("loading")?.remove();
