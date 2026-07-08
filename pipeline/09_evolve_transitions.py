"""GA recovery of the sealed 12x11 transition genome from two training games.

Genome = 12 players x 11 genes = 132 in [0,1], players-array order. Fitness =
the §7 loss of pooled 2-game sim stats vs the stored train stats; both eval
seeds are common random numbers per generation (base+2*gen, +1) so the whole
population faces the same match luck. GA per §8: pop 28, elitism 2, tournament
k=3; crossover per player-block — with p=.3 blend the block per gene
(alpha*a + (1-alpha)*b, alpha~U(0,1)), else swap whole blocks uniformly
(p=.5 per block); mutation per gene p=.15, +N(0, sigma_g) with
sigma_g = .18*exp(-gen/140), clip [0,1]; init pop ~ U(.15,.85).
Champion = best-of-gen re-scored on 2 fresh seeds (kills lucky genomes), kept
by running best re-eval loss. Engine/extractor/loss come from module 08
unmodified (its tuned constants incl. T=840 ride along); the champion's loss
family breakdown is tracked each generation.

Measurement conventions (spec leaves both open; chosen against sampling bias):
validation every 5 gens simulates 6 games on fixed seeds (mirrors the 6-game
val reference — 2-game val draws have sd ~1.0 at champion level, 6-game ~0.4);
`final.train` is re-measured at the end as the mean of 3 fresh 2-game evals,
because the running-min re-eval loss that drives selection is winner's-curse
biased ~1 sd low (measured: reported 1.83 vs true 3.17 at pop 16 / 25 gens).
CAVEAT: 6-game pooling deflates the loss MEAN ~1.7x, not just its sd (sampling
noise enters the squared error additively), so the 6-game `final.val` is NOT
on the same scale as `final.train` or the stored noise floor. `final.val_2g`
re-measures validation with the same 2-game protocol (mean of 3 fresh 2-game
sims vs the val reference); the selftest ratio and any comparison against
`noise_floor` use val_2g. The 6-game number is kept for the low-variance
history curve only.

Recovery verdict per param: mean |z_fit - z_true| over the 12 players —
identified < .12, ridge .12-.25, else unidentified. Two games cannot pin every
dimension; the honest gap is the point of the reveal.

Usage:
  python pipeline/09_evolve_transitions.py [--gens 120] [--pop 28] [--seed 7]
  python pipeline/09_evolve_transitions.py --selftest   # pop 16, gens 25
"""
import argparse
import importlib
import math
import shutil
import time

import numpy as np

from common import OUT, VIZ_ASSETS, load_json, save_json

TR = importlib.import_module("08_transitions")

ELITE = 2
TOURN_K = 3
P_BLEND = 0.30        # per player-block: blend instead of swap
P_MUT = 0.15          # per gene
SIGMA0, SIGMA_DECAY = 0.18, 140.0
INIT_LO, INIT_HI = 0.15, 0.85
VAL_EVERY = 5
VAL_GAMES = 6         # validation sims mirror the 6-game val reference
FINAL_EVALS = 3       # fresh 2-game evals averaged for the unbiased final train
IDENT, RIDGE = 0.12, 0.25   # mean |dz| verdict thresholds
ND = len(TR.DIM_NAMES)


# ---------------------------------------------------------------- fitness
def eval_genome(z, players, ref, seeds, T, breakdown=False):
    """Simulate 2 games, pool events (train-style), score vs ref stats."""
    Z = z.reshape(len(players), ND)
    games = [TR.simulate_game(Z, players, s, T) for s in seeds]
    return TR.loss(TR.extract_stats(games, players), ref, breakdown=breakdown)


# ---------------------------------------------------------------- GA step
def next_gen(P, F, rng, gen):
    """Elitism + vectorized tournament/crossover/mutation -> next population."""
    pop, nb = len(P), P.shape[1] // ND
    order = np.argsort(F)
    n = pop - ELITE
    cand = rng.integers(0, pop, (2, n, TOURN_K))
    par = np.take_along_axis(cand, np.argmin(F[cand], axis=2)[:, :, None], 2)[:, :, 0]
    A, B = P[par[0]].reshape(n, nb, ND), P[par[1]].reshape(n, nb, ND)
    child = np.where(rng.random((n, nb))[:, :, None] < 0.5, B, A)   # block swap
    alpha = rng.random((n, nb, ND))
    child = np.where(rng.random((n, nb))[:, :, None] < P_BLEND,     # block blend
                     alpha * A + (1 - alpha) * B, child).reshape(n, -1)
    sig = SIGMA0 * math.exp(-gen / SIGMA_DECAY)
    mut = rng.random(child.shape) < P_MUT
    child = np.clip(child + mut * rng.normal(0, sig, child.shape), 0.0, 1.0)
    return np.vstack([P[order[:ELITE]], child])


# ---------------------------------------------------------------- evolution
def evolve(data, gens, pop, seed):
    """Returns (champ dict, history, final val loss, unbiased final train loss)."""
    players = data["players"]
    T = int(data["engine"]["T"])
    train_ref, val_ref = data["train"]["stats"], data["val"]["stats"]
    val_seeds = tuple(seed + 555_000 + i for i in range(VAL_GAMES))   # fixed: val curve tracks the genome, not seed luck
    rng = np.random.default_rng(seed)
    P = rng.uniform(INIT_LO, INIT_HI, (pop, len(players) * ND))
    champ = {"z": None, "train": np.inf, "breakdown": None, "gen": -1}
    hist, val_l, t_all = [], None, time.time()
    for gen in range(gens):
        t0 = time.time()
        seeds = (seed + 2 * gen, seed + 2 * gen + 1)
        F = np.array([eval_genome(z, players, train_ref, seeds, T) for z in P])
        gi = int(np.argmin(F))
        fresh = (seed + 777_000 + 2 * gen, seed + 777_000 + 2 * gen + 1)
        re_l, re_bd = eval_genome(P[gi], players, train_ref, fresh, T, breakdown=True)
        if re_l < champ["train"]:
            champ = {"z": P[gi].copy(), "train": re_l, "breakdown": re_bd, "gen": gen}
        rec = {"gen": gen, "best": round(float(F[gi]), 4),
               "median": round(float(np.median(F)), 4),
               "champ": round(champ["train"], 4),
               "breakdown": {k: round(v, 5) for k, v in champ["breakdown"].items()}}
        if gen % VAL_EVERY == 0 or gen == gens - 1:
            val_l = eval_genome(champ["z"], players, val_ref, val_seeds, T)
            rec["val"] = round(val_l, 4)
        hist.append(rec)
        print(f"[evolve-t] gen {gen:3d}/{gens} best={F[gi]:7.3f} med={float(np.median(F)):7.3f} "
              f"champ={champ['train']:7.3f}"
              + (f" val={rec['val']:7.3f}" if "val" in rec else "            ")
              + f" sig={SIGMA0 * math.exp(-gen / SIGMA_DECAY):.3f} [{time.time() - t0:.1f}s]",
              flush=True)
        if gen < gens - 1:
            P = next_gen(P, F, rng, gen)
    # unbiased final train: the running-min above is winner's-curse biased low
    fin_tr = float(np.mean([eval_genome(champ["z"], players, train_ref,
                                        (seed + 888_000 + 2 * i, seed + 888_001 + 2 * i), T)
                            for i in range(FINAL_EVALS)]))
    # same-protocol validation: 2-game sims vs val ref (6-game pooling deflates
    # the mean ~1.7x — see docstring), comparable to fin_tr and the noise floor
    fin_val = float(np.mean([eval_genome(champ["z"], players, val_ref,
                                         (seed + 999_000 + 2 * i, seed + 999_001 + 2 * i), T)
                             for i in range(FINAL_EVALS)]))
    print(f"[evolve-t] {gens} gens in {time.time() - t_all:.0f}s — champion from gen "
          f"{champ['gen']}: selection min={champ['train']:.3f}, fresh train={fin_tr:.3f}, "
          f"val_2g={fin_val:.3f} (noise floor {data['noise_floor']:.3f}; "
          f"6-game val curve ends at {val_l:.3f}, deflated scale)")
    return champ, hist, val_l, fin_tr, fin_val


# ---------------------------------------------------------------- recovery
def recovery_rows(data, Zc):
    true = data["sealed"]["theta_true"]
    return [{"tid": p["tid"], "param": nm,
             "true": round(float(true[str(p["tid"])][j]), 4),
             "fit": round(float(Zc[i, j]), 4)}
            for i, p in enumerate(data["players"]) for j, nm in enumerate(TR.DIM_NAMES)]


def print_recovery(rows):
    print(f"[evolve-t] recovery — mean |dz| over 12 players "
          f"(identified <{IDENT} · ridge {IDENT}-{RIDGE} · unidentified >{RIDGE})")
    out = {}
    for nm in TR.DIM_NAMES:
        d = float(np.mean([abs(r["fit"] - r["true"]) for r in rows if r["param"] == nm]))
        v = "identified" if d < IDENT else ("ridge" if d <= RIDGE else "unidentified")
        out[nm] = (d, v)
        print(f"[evolve-t]   {nm:10s} mean|dz|={d:.3f}  {v}")
    return out


# ---------------------------------------------------------------- CLI
def main(args):
    data = load_json(OUT / "transition_data.json")
    print(f"[evolve-t] loaded transition_data.json — T={data['engine']['T']} "
          f"noise floor={data['noise_floor']:.4f} pop={args.pop} gens={args.gens} seed={args.seed}")
    champ, hist, val_l, fin_tr, fin_val = evolve(data, args.gens, args.pop, args.seed)
    Zc = champ["z"].reshape(len(data["players"]), ND)
    rows = recovery_rows(data, Zc)
    print_recovery(rows)
    fit = {"history": hist,
           "best_theta": {str(p["tid"]): [round(float(v), 4) for v in Zc[i]]
                          for i, p in enumerate(data["players"])},
           "recovery": rows,
           "final": {"train": round(fin_tr, 4), "val": round(val_l, 4),
                     "val_2g": round(fin_val, 4),
                     "noise_floor": data["noise_floor"]}}
    path = save_json(OUT / "transition_fit.json", fit)
    shutil.copy2(path, VIZ_ASSETS / "transition_fit.json")
    print(f"[evolve-t] wrote {path} + viz/assets copy")


def selftest(args):
    """Pop 16 / gens 25 on the real data: loss drop + generalization + recovery."""
    print("[evolve-t] selftest: pop 16, gens 25 on out/transition_data.json")
    data = load_json(OUT / "transition_data.json")
    champ, hist, val_l, fin_tr, fin_val = evolve(data, 25, 16, args.seed)
    print_recovery(recovery_rows(data, champ["z"].reshape(len(data["players"]), ND)))
    med0 = hist[0]["median"]
    drop = 1.0 - fin_tr / med0
    ratio = fin_val / fin_tr           # same 2-game protocol on both sides
    print(f"[evolve-t] gen-0 median={med0:.3f} champ train={fin_tr:.3f} "
          f"drop={drop:.0%} (need >= 35%)")
    print(f"[evolve-t] champ val_2g={fin_val:.3f} = {ratio:.2f}x train (need < 1.6x)")
    ok = drop >= 0.35 and ratio < 1.6
    print(f"[evolve-t] selftest {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gens", type=int, default=120)
    ap.add_argument("--pop", type=int, default=28)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    raise SystemExit(selftest(args) if args.selftest else main(args))
