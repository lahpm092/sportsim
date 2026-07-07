# SportSim — a chess engine for football

Real match video → SAM 3 temporal masks → symbolic behavioral abstraction →
stochastic-differential player models → CMA-ES evolution → a playable board.

## The idea

Chess engines understand a position because every piece has known dynamics.
SportSim learns the dynamics of real players from video: each player becomes a
7-parameter stochastic differential equation (anchor spring, drag, ball
coupling, noise, top speed, ball-following gains), and evolution tunes those
parameters until the simulated player moves like the filmed one. The fitted
parameters ARE the player's "piece rules" — then the engine can replay, predict
(shadow), extrapolate (dream), score transfers, and search counter-strategies.

## Pipeline (Mac mini PoC)

```
data/raw/clip.mp4                    18 s of Atlético–Sevilla (CC BY 3.0, Samsung España)
  01_segment.py     SAM 3 text-prompted instance masks per frame («soccer player», «ball»), MPS
  02_track.py       Hungarian tracklets + jersey-color team k-means
  02b_homography.py pan-compensated image→pitch-meters mapping (LK + RANSAC chain)
  03_features.py    symbolic tokens (33-symbol alphabet), motif codebook, style vectors
  04_model.py       social-force SDE, semi-implicit Euler–Maruyama, 7 params/player
  05_evolve.py      CMA-ES ghost-conditioned fits; --selftest = synthetic recovery preflight
  06_simulate.py    closed-loop team sim: shadow / dream / transfer-fit / counter-strategy
  07_export.py      segmentation overlay film + viz data bundle
viz/                three.js board (sepia & ink) — python3 -m http.server -d viz 8777
runpod/             H100 package: true SAM3 video tracking + industrial evolution (DEPLOY.md)
```

## Run

```bash
source .venv/bin/activate
cd pipeline
python 01_segment.py --video ../data/raw/clip.mp4 --repo ../models/sam3
python 02_track.py && python 02b_homography.py && python 03_features.py
python 05_evolve.py --selftest        # pipeline must recover known params first
python 05_evolve.py
python 06_simulate.py && python 07_export.py
cd .. && python3 -m http.server -d viz 8777   # open http://localhost:8777
```

## Honesty ledger (one 18 s clip)

Identifiable: σ (noise), γ (drag), v_max (lower bound), ρ (home base).
Ridge-coupled: k_home↔γ, k_ball↔β — the L2 prior picks the point; restart
spread is the honest uncertainty. Frozen by design: stamina, per-player
separation, pass policies (need minutes-to-hours of footage — that's what the
H100 package is for). Fitness < 1.0 means beating inertial extrapolation.

## Weights & licenses

SAM 3 via ungated mirror `jetjodh/sam3` (byte-identical to gated
`facebook/sam3`, SAM License). Footage: Atlético de Madrid × Sevilla FC,
Samsung España via Internet Archive, CC BY 3.0 — attribution kept in the app
footer. transformers ≥ 5.0, torch MPS.
