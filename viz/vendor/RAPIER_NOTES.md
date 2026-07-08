# rapier3d-compat — vendoring notes

## What & where

- `viz/vendor/rapier3d-compat.js` — **@dimforge/rapier3d-compat 0.19.3**, 2,238,701 bytes.
- Provenance: `npm pack @dimforge/rapier3d-compat` → `dimforge-rapier3d-compat-0.19.3.tgz`
  (2026-07-08, registry.npmjs.org) → `package/rapier.mjs` copied verbatim except for two
  surgical edits:
  1. stripped the trailing `//# sourceMappingURL=rapier.mjs.map` (map not shipped → devtools 404 noise);
  2. wrapped the internal init payload `xA(Lg.toByteArray("…").buffer)` as
     `xA({module_or_path: …})` — the compat build calls its own loader with the deprecated
     positional signature and printed
     `"using deprecated parameters for the initialization function"` on every init.
- upstream `rapier.mjs` sha256 `bce2c762b440101ebf8cbff038a71fe1884488becd0a53b9a7c0a7e3daf13a2b`.
- Single file, zero imports, zero fetches: the 1.5 MB wasm is inlined as a 2.09 MB base64
  string and decoded at `init()`. The `new URL("rapier_wasm3d_bg.wasm","<deleted>")` you can
  grep inside is a dead fallback branch — never taken because init always passes the bytes.
  Safe for `file://`-less static serving; no COOP/COEP headers needed.

## API idioms (as used in goal-physics.js / physics-test.js)

```js
import RAPIER from "./vendor/rapier3d-compat.js";  // default export = frozen namespace
await RAPIER.init();                               // decodes + instantiates wasm; MUST run before anything else
RAPIER.version();                                  // "0.19.3"

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;                           // fixed dt; step() takes no args

// static collider: no body needed
world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz)
  .setTranslation(x, y, z).setRestitution(0.65).setFriction(0.8));

// cylinders are Y-aligned, args (halfHeight, radius); rotate desc for other axes
RAPIER.ColliderDesc.cylinder(1.28, 0.06);                       // goalpost
RAPIER.ColliderDesc.cylinder(3.78, 0.06)                        // crossbar: Y→X
  .setRotation({ w: Math.SQRT1_2, x: 0, y: 0, z: Math.SQRT1_2 });

// dynamic ball
const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
  .setTranslation(0, 0.11, 16).setLinearDamping(0.05).setAngularDamping(0.6)
  .setCcdEnabled(true));                                        // ← essential, see below
world.createCollider(RAPIER.ColliderDesc.ball(0.11)
  .setRestitution(0.65).setFriction(0.6).setDensity(77), rb);   // ρ≈77 → ≈0.43 kg

rb.setTranslation({x,y,z}, true); rb.setLinvel({x,y,z}, true); rb.setAngvel({x,y,z}, true);
const p = rb.translation(), q = rb.rotation();   // fresh {x,y,z} / {x,y,z,w} each call
```

- Combine rules: contact restitution defaults to **Average** of the two colliders —
  a "dead" wall vs a bouncy ball still returns ~0.33. Force it with
  `.setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)`.

## CCD

25–30 m/s ball vs a 6 cm post tunnels at 1/60 s (0.4–0.5 m per step) — `setCcdEnabled(true)`
on the RigidBodyDesc fixes posts and crossbar reliably. **Gotcha:** CCD is not bulletproof
against *thin static walls when the ball is simultaneously in ground contact* (fast
daisy-cutter vs a 0.16 m-thick backstop tunneled in testing). Make invisible catch geometry
≥ 0.5 m thick instead of relying on CCD.

## Stepping

- Fixed-dt accumulator: `acc += min(0.1, frameDt); while (acc >= 1/60) { world.step(); acc -= 1/60; }`
  Clamp the frame delta or a background-tab wakeup spirals.
- For buttery visuals at high refresh, interpolate rendering between the previous and current
  body transforms by `acc / h` (store `p_prev` before each step; `mesh.position.lerpVectors(p_prev, p, acc/h)`).
  physics-test.js skips this (60 Hz step ≈ display rate); do it in the theater page if 120 Hz
  displays stutter.
- `rb.translation()` allocates a fresh object per call — cache it if it shows in profiles.

## Other gotchas

- The default export is `Object.freeze`d — don't try to monkey-patch it.
- No tree-shaking possible (single opaque bundle); the 2.2 MB is the price of zero build.
  Gzips to ~0.9 MB if the server ever compresses.
- `init()` can be called under any name (`RAPIER.init()` or `import { init }`), is idempotent
  enough for one page, but don't call it concurrently from two modules — top-level-await it
  once in the entry module.
- Everything is plain `{x,y,z}` objects, never THREE.Vector3 — they interop fine in one
  direction (rapier accepts any object with the fields), but rapier's returns lack THREE methods.
