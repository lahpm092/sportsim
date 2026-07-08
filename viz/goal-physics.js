import * as THREE from "./vendor/three.module.js";

/* goal-physics — regulation goal (meshes + rapier colliders), verlet net cloth,
   ballistic launch solver. Frame: goal mouth in the plane z=0, net hangs into z<0,
   shots arrive from z>0. Self-contained; designed to be lifted into the theater page. */

/* ---------------------------------------------------------------- launch solver */
/* v0 such that p(T) = p0 + v0·T + ½·g·T² lands exactly on target at time T.
   Pure ballistics — linear damping on the body will make it land a whisker short;
   compensate with v0 *= (1 + c·T/2) at the call site if it matters. */
export function launchVelocity(p0, target, T, g = { x: 0, y: -9.81, z: 0 }) {
  return {
    x: (target.x - p0.x) / T - 0.5 * g.x * T,
    y: (target.y - p0.y) / T - 0.5 * g.y * T,
    z: (target.z - p0.z) / T - 0.5 * g.z * T,
  };
}

/* ---------------------------------------------------------------- goal builder */
/* Regulation frame: 7.32 m between inner post faces, crossbar underside at 2.44 m.
   Post centers sit at x = ±(3.66 + r), bar center at y = 2.44 + r. Static rapier
   cylinders for both posts + bar; stanchions/ground rails are visual only. An
   invisible backstop cuboid behind the net catches anything the cloth lets slip
   (pass { backstop: false } to omit). Returns { group, hw, barY, topY, depth }. */
export function buildGoal(scene, world, RAPIER, opts = {}) {
  const o = Object.assign({
    innerW: 7.32, barH: 2.44, postR: 0.06, depth: 2.0,
    ink: 0x1c1712, restitution: 0.65, friction: 0.4, backstop: true,
  }, opts);
  const hw = o.innerW / 2 + o.postR;      // 3.72 — post center
  const barY = o.barH + o.postR;          // 2.50 — bar center
  const topY = barY + o.postR;            // 2.56 — visual post top
  const mat = new THREE.MeshStandardMaterial({ color: o.ink, roughness: 0.6, flatShading: true });
  const g = new THREE.Group();
  const cyl = (r, len, seg = 6) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
    m.castShadow = true; g.add(m); return m;
  };
  const stat = desc => world.createCollider(desc.setRestitution(o.restitution).setFriction(o.friction));

  for (const s of [-1, 1]) {
    const post = cyl(o.postR, topY);
    post.position.set(s * hw, topY / 2, 0);
    stat(RAPIER.ColliderDesc.cylinder(topY / 2, o.postR).setTranslation(s * hw, topY / 2, 0));
    // back stanchion: post top → ground `depth` behind
    const st = cyl(0.045, Math.hypot(topY, o.depth), 5);
    st.position.set(s * hw, topY / 2, -o.depth / 2);
    st.rotation.x = Math.atan2(o.depth, topY);
    // side ground rail
    const rail = cyl(0.035, o.depth, 5);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(s * hw, 0.035, -o.depth / 2);
  }
  const bar = cyl(o.postR, 2 * hw + 2 * o.postR);
  bar.rotation.z = Math.PI / 2; bar.position.set(0, barY, 0);
  stat(RAPIER.ColliderDesc.cylinder(hw + o.postR, o.postR)
    .setTranslation(0, barY, 0)
    .setRotation({ w: Math.SQRT1_2, x: 0, y: 0, z: Math.SQRT1_2 }));  // Y → X
  const back = cyl(0.035, 2 * hw, 5);
  back.rotation.z = Math.PI / 2; back.position.set(0, 0.035, -o.depth);

  /* invisible catch-box: dead back + side walls just outside the netting so nothing
     escapes the goal. Thick (0.5 m) — a grounded 30 m/s ball tunnels a thin wall even
     with CCD on. Restitution 0 with Min combine ⇒ dead stop, the cloth sells the catch. */
  if (o.backstop) {
    const dead = desc => world.createCollider(desc
      .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setFriction(1));
    dead(RAPIER.ColliderDesc.cuboid(hw + 0.6, barY / 2 + 0.4, 0.25)
      .setTranslation(0, barY / 2, -(o.depth + 0.35)));                      // back, face at −(depth+0.10)
    for (const s of [-1, 1])
      dead(RAPIER.ColliderDesc.cuboid(0.25, barY / 2 + 0.4, (o.depth + 0.3) / 2)
        .setTranslation(s * (hw + 0.12 + 0.25), barY / 2, -(o.depth + 0.9) / 2)); // sides, faces at ±(hw+0.12), z ∈ [−0.3, −depth−0.6]
  }

  /* static side-net fans — visual only, the invisible side walls do the physics */
  {
    const pts = [];
    for (const s of [-1, 1]) {
      const x = s * hw;
      for (let k = 1; k <= 6; k++) {         // verticals: ground rail → hypotenuse (post top → stanchion foot)
        const t = k / 7;
        pts.push(new THREE.Vector3(x, 0.03, -o.depth * t), new THREE.Vector3(x, topY * (1 - t), -o.depth * t));
      }
      for (let k = 1; k <= 4; k++) {         // horizontals: post → hypotenuse
        const y = topY * k / 5;
        pts.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y, -o.depth * (1 - k / 5)));
      }
    }
    const side = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: o.ink, transparent: true, opacity: 0.45 }));
    g.add(side);
  }

  scene.add(g);
  return { group: g, hw, barY, topY, depth: o.depth };
}

/* ---------------------------------------------------------------- net cloth */
/* Verlet grid, cols × rows nodes. Rest pose: top row tied just behind the bar,
   sweeping back to a ground rail `depth` behind the line. Border fully pinned:
   top edge (crossbar), side edges (down the posts / stanchion profile), bottom
   edge (ground frame). Interior free — bulges on impact. Rendered as ink
   LineSegments over the structural edges (quad wireframe = net look).
   step() returns the number of node/edge contacts with the ball this frame. */
export class NetCloth {
  constructor(opts = {}) {
    const o = this.o = Object.assign({
      halfW: 3.72, barY: 2.50, depth: 2.0, cols: 20, rows: 11,
      iters: 3, damping: 0.985, gravity: -9.81, margin: 0.05,
      color: 0x1c1712, opacity: 0.55, floorY: 0.015,
    }, opts);
    const { cols, rows } = o;
    this.n = cols * rows;
    const pos = this.pos = new Float64Array(this.n * 3);
    this.prev = new Float64Array(this.n * 3);
    this.pin = new Uint8Array(this.n);
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const y = r === 0 ? o.barY : Math.max(0.02, o.barY * (1 - t));
      const z = r === 0 ? -0.05 : -(0.08 + (o.depth - 0.08) * Math.pow(t, 1.35));
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        pos[i] = -o.halfW + 2 * o.halfW * c / (cols - 1);
        pos[i + 1] = y; pos[i + 2] = z;
        if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) this.pin[r * cols + c] = 1;
      }
    }
    this.prev.set(pos);
    this.rest = pos.slice();
    // constraints: [iA, iB, restLen]; structural first (also the render edges), then shear
    const cons = [], id = (r, c) => r * cols + c;
    const link = (a, b) => {
      const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      cons.push(a, b, Math.hypot(dx, dy, dz));
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) link(id(r, c), id(r, c + 1));
      if (r + 1 < rows) link(id(r, c), id(r + 1, c));
    }
    this.nStruct = cons.length / 3;
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
      link(id(r, c), id(r + 1, c + 1)); link(id(r, c + 1), id(r + 1, c));
    }
    this.cons = new Float64Array(cons);
    // render buffer: 2 verts per structural edge
    this.vtx = new Float32Array(this.nStruct * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.vtx, 3));
    this.object3d = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: o.opacity }));
    this.object3d.frustumCulled = false;
    this.updateGeometry();
  }

  reset() { this.pos.set(this.rest); this.prev.set(this.rest); this.updateGeometry(); }

  /* sphere pushout of nodes + structural edges against one ball center.
     Edges matter: the grid (~0.39 m cells) is coarser than the ball. */
  _collide(bx, by, bz, R, count) {
    const { pos, pin, cons } = this;
    let contacts = 0;
    for (let i = 0; i < this.n; i++) {
      if (pin[i]) continue;
      const j = i * 3;
      const dx = pos[j] - bx, dy = pos[j + 1] - by, dz = pos[j + 2] - bz;
      const d = Math.hypot(dx, dy, dz);
      if (d < R) {
        const s = (R - d) / (d || 1e-9);
        pos[j] += dx * s; pos[j + 1] += dy * s; pos[j + 2] += dz * s;
        if (count) contacts++;
      }
    }
    for (let c = 0; c < this.nStruct * 3; c += 3) {
      const a = cons[c] * 3, b = cons[c + 1] * 3;
      const ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
      const ee = ex * ex + ey * ey + ez * ez || 1e-9;
      let t = ((bx - pos[a]) * ex + (by - pos[a + 1]) * ey + (bz - pos[a + 2]) * ez) / ee;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = pos[a] + ex * t - bx, qy = pos[a + 1] + ey * t - by, qz = pos[a + 2] + ez * t - bz;
      const d = Math.hypot(qx, qy, qz);
      if (d < R && d > 1e-9) {
        const push = (R - d) / d * 0.5;
        if (!pin[cons[c]]) { pos[a] += qx * push; pos[a + 1] += qy * push; pos[a + 2] += qz * push; }
        if (!pin[cons[c + 1]]) { pos[b] += qx * push; pos[b + 1] += qy * push; pos[b + 2] += qz * push; }
        if (count) contacts++;
      }
    }
    return contacts;
  }

  /* one fixed step; ball = {x,y,z} rapier translation (or null), ballR = collider radius.
     Pass prevBall (ball position before this world step) to get swept collision:
     at 26 m/s the ball moves 0.43 m per 1/60 s and would teleport through the cloth,
     so we run pushout at samples along the travel segment. */
  step(dt, ball, ballR = 0.11, prevBall = null) {
    const { pos, prev, pin, cons, o } = this;
    const damp = o.damping, gdt2 = o.gravity * dt * dt;
    for (let i = 0; i < this.n; i++) {
      if (pin[i]) continue;
      const j = i * 3;
      for (let k = 0; k < 3; k++) {
        const p = pos[j + k], v = (p - prev[j + k]) * damp;
        prev[j + k] = p;
        pos[j + k] = p + v + (k === 1 ? gdt2 : 0);
      }
    }
    let contacts = 0;
    const R = ballR + o.margin;
    let samples = null;
    if (ball) {
      const px = prevBall?.x ?? ball.x, py = prevBall?.y ?? ball.y, pz = prevBall?.z ?? ball.z;
      const travel = Math.hypot(ball.x - px, ball.y - py, ball.z - pz);
      const S = Math.min(8, Math.max(1, Math.ceil(travel / (R * 0.75))));
      samples = [];
      for (let s = 1; s <= S; s++) {
        const t = s / S;
        samples.push([px + (ball.x - px) * t, py + (ball.y - py) * t, pz + (ball.z - pz) * t]);
      }
    }
    for (let it = 0; it < o.iters; it++) {
      // distance constraints
      for (let c = 0; c < cons.length; c += 3) {
        const a = cons[c], b = cons[c + 1], rest = cons[c + 2];
        const ja = a * 3, jb = b * 3;
        const dx = pos[jb] - pos[ja], dy = pos[jb + 1] - pos[ja + 1], dz = pos[jb + 2] - pos[ja + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-9;
        const pa = pin[a], pb = pin[b];
        if (pa && pb) continue;
        const s = (d - rest) / d, wa = pa ? 0 : pb ? 1 : 0.5, wb = pa ? 1 : pb ? 0 : 0.5;
        pos[ja] += dx * s * wa; pos[ja + 1] += dy * s * wa; pos[ja + 2] += dz * s * wa;
        pos[jb] -= dx * s * wb; pos[jb + 1] -= dy * s * wb; pos[jb + 2] -= dz * s * wb;
      }
      if (samples) for (const [bx, by, bz] of samples)
        contacts += this._collide(bx, by, bz, R, it === 0);
      // floor
      for (let i = 0; i < this.n; i++)
        if (!pin[i] && pos[i * 3 + 1] < o.floorY) pos[i * 3 + 1] = o.floorY;
    }
    return contacts;
  }

  updateGeometry() {
    const { pos, cons, vtx } = this;
    for (let c = 0, v = 0; c < this.nStruct * 3; c += 3, v += 6) {
      const a = cons[c] * 3, b = cons[c + 1] * 3;
      vtx[v] = pos[a]; vtx[v + 1] = pos[a + 1]; vtx[v + 2] = pos[a + 2];
      vtx[v + 3] = pos[b]; vtx[v + 4] = pos[b + 1]; vtx[v + 5] = pos[b + 2];
    }
    this.object3d.geometry.attributes.position.needsUpdate = true;
  }
}
