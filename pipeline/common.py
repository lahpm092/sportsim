"""Shared paths and helpers for the SportSim pipeline."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
FRAMES = DATA / "frames"
MASKS = DATA / "masks"
OUT = ROOT / "out"
VIZ_ASSETS = ROOT / "viz" / "assets"

for d in (RAW, FRAMES, MASKS, OUT, VIZ_ASSETS):
    d.mkdir(parents=True, exist_ok=True)

# Pitch dimensions in meters (FIFA standard-ish)
PITCH_L = 105.0
PITCH_W = 68.0


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f)
    return path


def load_json(path):
    with open(path) as f:
        return json.load(f)


def device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"
