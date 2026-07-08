# Exercise Catalog — Layer B Reference Manual

**Scope:** Exercise catalog for Training Taxonomy v2 — entity model, progression graph, objective indices, strength ratios.
**Status:** Layer B closed. Seed catalog validated (integrity PASS).
**Date:** 2026-06-10.
**Companion files:** `catalog_schema.yaml`, `catalog_seed_part1.yaml`, `catalog_seed_part2.yaml`, `validate_catalog.py`.

---

## 1. Why Layer B exists

Layer A (methods) accumulated ten concrete debts that only an exercise catalog can pay: a stable `exercise_ref` identity, an objective `mechanical_demand_index` for mechanical_drop, `technical_complexity_index` as a catalog attribute with block override, `movement_pattern` as a closed enum, a progression graph, weakest-link validation for single_load_chain, `typical_time_per_rep_sec` for duration estimation, five unreliable `fn:*` hooks, `load_metric_primary` per exercise, and a formal antagonism table for antagonist_giant_set. Layer B converts ~15 fragile heuristics into reliable, data-driven validations.

## 2. The entity model (B.0)

**Two levels, no more:** `exercise` (base) + `variation` (delta over the base).

**The cut rule:** changing the movement pattern or the primary implement creates a new base; modulating execution (tempo, ROM, grip, stance, surface, assistance, load position, bar type) creates a variation. Decided edge cases: pull-up vs chin-up are separate bases; trap bar / SSB are *variations* (bar_type dimension), marked for eventual promotion to implements.

**The calisthenics resolution (B.0.8):** real mechanical-drop progressions cross freely between variations of one base and jumps between bases. Therefore the graph operates on **resolvable nodes** `(exercise_id, variation_id | null)`, and variations sharing a `modifies` dimension within a base form an **implicit ladder** ordered by demand delta. Orthogonal dimensions (pause vs deficit) never auto-connect.

**Two progression modes (marked for v3):** loaded exercises progress by adding load; bodyweight exercises progress by *navigating the graph*. Edge `magnitude` (small/medium/large ≈ weeks/months/months+) is the datum the v3 generator consumes for the second mode.

## 3. Closed vocabularies (B.1)

- **23 movement patterns**, including the anti-patterns (anti_rotation, anti_extension, anti_lateral_flexion) and locomotion (run, ergs — required for HYROX).
- **22 muscle groups** at medium granularity. *Marked:* possible expansion for per-group accumulated volume/damage tracking in Layers C/D; the `primary_muscles` (1.0) / `secondary_muscles` (0.5) structure plus optional `muscle_contribution_override` already supports fractional volume counting.
- **22 implements** (special bars excluded by design — they are variations).
- **Antagonist pairs table** with three confidence levels (canonical / practical / weak) driving antagonist_giant_set validation semantics.

## 4. The progression graph (B.2)

Directed graph over resolvable nodes. Eight edge mechanisms: load, leverage, angle, assistance, range_of_motion, stability, complexity, tempo — one dominant per edge (audit flag tracks possibly-mixed cases). Structural properties enforced as **hard load-time errors**: P1 (every progression edge goes from lower to higher demand), P2 (acyclic), P3 (targets resolvable). Connectivity is not required. Regressions are derived, never declared. **Equivalence edges** (symmetric, distance-1, with optional load_translation) power the v3 substitution engine.

`validate_mechanical_progression` closes A.2's debt: each mechanical_drop transition must be an implicit-ladder descent or a regression edge with matching mechanism, with globally decreasing demand. Graceful fallback to v2 heuristics when steps are missing from the catalog.

## 5. Objective indices (B.3)

Two 0-10 scales, **ordinal by design**, anchored by reference exercises per pattern family.

- `technical_complexity_index`: learning cost (globally comparable). Anchors: leg extension 1 → goblet 3 → deadlift 5 → power clean 7 → snatch 9.
- `mechanical_demand_index`: strength demand. Fine-grained for bodyweight (it orders the calisthenics graph); coarse for loaded exercises (strength ratios carry the fine relations there).

**The compressed ceiling:** advanced calisthenics packs enormous difficulty into 8-10. Resolution: ordinal interpretation (numeric deltas don't encode acquisition cost — edge magnitude and node density do) plus densified anchors (push_h: OAP 7.5 → pseudo-planche PU 8.5 → straddle planche PU 9.5 → full planche PU 10). *Marked:* skill tracks (planche, front lever, OAC) need v3 treatment with hold-time mastery criteria. *Marked:* data-assisted recalibration once executed-state data accumulates.

Rules R1-R4 enforce ranges, bounded deltas (±3), anchor immutability (version bump required), and mutual index↔graph consistency via P1.

## 6. Strength ratios and the weakest link (B.4)

**Hub model:** each exercise declares its ratio vs its family hub (back_squat, deadlift, bench, OHP, pull-up, row, power clean); explicit inter-hub ratios connect families; cross-family comparison composes transitively with confidence degradation (min of chain, one level per hub jump, 2+ jumps → low, audited by flag).

**Weakest link:** components expressed in global-hub units (back_squat equivalents); minimum wins. Validation is **relative** (did the user anchor the shared load to the right exercise?) — and that relative mode is the *primary* mode for **templates and program starts**, where no athlete data exists. Absolute mode activates structurally unchanged when the athlete profile (future layer) provides known 1RMs.

## 7. Hooks resolved (B.5)

All five catalog-dependent hooks moved from stubs/hardcoded tables to data queries; two more (technical continuity, uniform duration) upgraded with catalog defaults + preserved block overrides + heuristic fallbacks. Seven blocking **catalog_errors** formalized as a category separate from block flags. Eight new block flags (catalog totals: 125 flags). Ten new validator functions (Group 11; totals: 65 functions).

## 8. The seed catalog (B.6)

**98 exercises, 102 variations, 200 graph nodes, 29 explicit edges, 20 anchors** across: barbell core + hubs, dumbbell counterparts (separate bases with equivalences + load_translation), olympic derivatives, 20 machine/cable exercises (with machine→free-weight stability edges), complete basic calisthenics lines (push, pull, dip, row, legs, core), the **full planche skill track** as stress test, kettlebell, and all HYROX stations + ergs (exercising distance/time load metrics).

Integrity validation **PASS** on P1-P3 and R1-R2, with the validator itself verified by deliberate fault injection (inverted demand, phantom target, out-of-range delta — all caught with the designed error IDs). `validate_catalog.py` is the first piece of running code in the system: the reference implementation of `validate_catalog_integrity`.

## 9. What B leaves for later

- **Athlete profile** (1RMs, history, constraints) → unlocks absolute validation.
- **Catalog population beyond seed** (~98 → hundreds) — content work, not schema work.
- **Layer C (autoregulation)** consumes `muscle_contribution_override` for accumulated volume per muscle group, plus executed-state data for index recalibration.
- **v3 generator** consumes: graph + magnitude (bodyweight progression), equivalences (substitution), strength ratios (template load suggestion), drift target index (method selection).

---

*For machine consumption: `catalog_schema.yaml`. For data: the two seed files. For integrity: run `python3 validate_catalog.py`.*
