"""H100-scale evolution: the same CMA-ES machinery, industrial settings.

Parallelizes per-player fits across CPU cores (the H100 pod ships 20+ vCPUs;
the SDE fits are numpy-bound — the GPU stays busy with segmentation batches).
Scales: population 24, 120 generations, 4 restarts, 16 stochastic rollouts.

Usage (on pod, after run_segment.py + pipeline steps 02/02b/03):
  python runpod/run_evolve.py --run /workspace/runs/<clip> [--gens 120] [--pop 24]
"""
import argparse
import importlib
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))


def fit_one(payload):
    j, run_dir, gens, pop, restarts = payload
    os.environ["OMP_NUM_THREADS"] = "2"
    sys.path.insert(0, str(Path(run_dir)))
    E = importlib.import_module("05_evolve")
    M = importlib.import_module("04_model")
    E.N_ROLL = 16
    feat = json.load(open(Path(run_dir) / "out" / "features.json"))
    obs, teams, ball, _ = E.build_arrays(feat)
    p = feat["players"][j]
    ev = E.GhostEvaluator(obs, teams, ball, j, feat["dt"])
    if len(ev.train_w) < 3:
        return None
    t0 = time.time()
    best_f, best_z, hist = E.evolve_player(ev, gens, pop, restarts, tid=p["tid"])
    phys = M.z_to_phys(best_z, ev.lo, ev.hi)
    val_F = float(ev.evaluate(best_z[None], ev.val_w, gen_seed=999)[0]) if ev.val_w else None
    seed_F = float(ev.evaluate(np.full((1, 7), 0.5), ev.train_w, gen_seed=0)[0])
    print(f"[evolve] tid={p['tid']} F {seed_F:.3f} -> {best_f:.3f} ({time.time()-t0:.0f}s)", flush=True)
    return {"tid": p["tid"], "team": p["team"], "style": p["style"],
            "train_windows": len(ev.train_w), "val_windows": len(ev.val_w),
            "rho": np.round(ev.rho, 2).tolist(),
            "seed_F": round(seed_F, 4), "final_F": round(float(best_f), 4),
            "val_F": round(val_F, 4) if val_F else None,
            "params": {n: round(float(v), 4) for n, v in zip(M.PARAM_NAMES, phys)},
            "z": np.round(best_z, 4).tolist(), "gens": hist}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="run directory containing out/features.json")
    ap.add_argument("--gens", type=int, default=120)
    ap.add_argument("--pop", type=int, default=24)
    ap.add_argument("--restarts", type=int, default=4)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    args = ap.parse_args()

    # stage pipeline modules next to the run so workers import the same code
    run_dir = Path(args.run)
    pipe = Path(__file__).resolve().parent.parent / "pipeline"
    for f in ("04_model.py", "05_evolve.py", "common.py"):
        (run_dir / f).write_text((pipe / f).read_text())

    feat = json.load(open(run_dir / "out" / "features.json"))
    payloads = [(j, str(run_dir), args.gens, args.pop, args.restarts) for j in range(len(feat["players"]))]
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        results = [r for r in ex.map(fit_one, payloads) if r]
    out = {"dt": feat["dt"], "param_names": ["k_home", "gamma", "k_ball", "sigma", "v_max", "beta_x", "beta_y"],
           "players": results}
    with open(run_dir / "out" / "evolution.json", "w") as f:
        json.dump(out, f)
    print(f"[evolve] {len(results)} players in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
