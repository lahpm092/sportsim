/* lab-worker.js — module worker that owns the GA loop (SPEC §10).
 *
 * main→worker: {type:'init', data} {type:'run'} {type:'pause'}
 *              {type:'speed', mode:'cinematic'|'fast'|'max'} {type:'reset', seed}
 * worker→main: {type:'ready', parity:{maxAbsDiff, ok}}   parity = train stats
 *                recomputed from the stored train events vs stored stats
 *              {type:'gen', gen, best, median, val, breakdown, champZ, popZ, …}
 *                throttled to ≤4 posts/s (val evals + champion improvements
 *                always post); champZ/popZ transferred
 *              {type:'champ_match', gen, loss, positions, ball, events, score}
 *                on champion improvement, ≥2 s apart, transferables
 * Speeds: cinematic ≈1 gen/s · fast ≈4 gen/s · max unthrottled with 1 eval
 * game per genome (champion re-eval always 2).
 */
import { GA, extract, configureFromData } from "./lab-engine.js";

let data = null, ga = null, seed = 7;
let running = false, mode = "cinematic", loopOn = false;
let lastGenPost = 0, lastChampPost = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function numDiff(a, b) {           // max abs diff over numeric leaves, recursive
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b);
  if (a === null || b === null || a === undefined || b === undefined) return a === b ? 0 : Infinity;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, numDiff(a[i], b[i]));
    return m;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
    let m = 0;
    for (const k of ks) m = Math.max(m, numDiff(a[k], b[k]));
    return m;
  }
  return a === b ? 0 : Infinity;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    data = msg.data;
    configureFromData(data);       // tuned §3 constants + §7 weights from the pipeline
    const maxAbsDiff = numDiff(extract(data.train.games, data.players), data.train.stats);
    ga = new GA(data, { pop: 28, seed });
    self.postMessage({ type: "ready", parity: { maxAbsDiff, ok: maxAbsDiff < 1e-9 } });
  } else if (msg.type === "run") { running = true; loop(); }
  else if (msg.type === "pause") { running = false; }
  else if (msg.type === "speed") { mode = msg.mode; }
  else if (msg.type === "reset") {
    seed = msg.seed;
    ga = new GA(data, { pop: 28, seed });
    lastGenPost = 0; lastChampPost = 0;
  }
};

async function loop() {
  if (loopOn) return;
  loopOn = true;
  while (true) {
    if (!running || !ga) { await sleep(120); continue; }
    const t0 = performance.now();
    const r = ga.step({ games: mode === "max" ? 1 : 2 });
    const val = r.gen % 5 === 0 ? ga.valEval() : null;
    const now = performance.now();
    if (now - lastGenPost >= 250 || val != null || r.champImproved) {
      lastGenPost = now;
      const champZ = Float32Array.from(ga.champ.z);
      const popZ = ga.popFlat32();
      self.postMessage({ type: "gen", seed, gen: r.gen, best: r.best, median: r.median, val,
        breakdown: ga.champ.breakdown, champLoss: ga.champ.reportLoss ?? ga.champ.loss,
        champGen: ga.champ.gen,
        matches: ga.matches, pop: ga.pop, champZ, popZ }, [champZ.buffer, popZ.buffer]);
    }
    if (r.champImproved && now - lastChampPost >= 2000) {
      lastChampPost = now;
      const g = ga.champMatch();
      self.postMessage({ type: "champ_match", seed, gen: r.gen,
        loss: ga.champ.reportLoss ?? ga.champ.loss,
        positions: g.positions, ball: g.ball, events: g.events, score: g.score,
        possession: g.possession }, [g.positions.buffer, g.ball.buffer]);
    }
    const target = mode === "cinematic" ? 1000 : mode === "fast" ? 250 : 0;
    await sleep(Math.max(0, target - (performance.now() - t0)));
  }
}
