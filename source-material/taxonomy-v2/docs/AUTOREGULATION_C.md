# Autoregulation — Layer C Reference Manual

**Scope:** The adaptive control loop of Training Taxonomy v2 — feedback signals, adjustments, volume accounting, fatigue state, deload, readiness.
**Status:** Layer C closed.
**Date:** 2026-06-10.
**Companion files:** `autoregulation_schema.yaml`, `adjustment_rules.yaml`.

---

## 1. What C adds

Layers A and B validate prescriptions *before* and record executions *after*. C closes the loop: **the system observes what happens and proposes adjustments**. Three time horizons, each its own sub-engine: pre-session (readiness modulates today), intra-session (RIR feedback adjusts remaining sets), inter-session (trends modulate the next session).

## 2. The four governing principles

**Immutability with provenance.** An adjustment never rewrites a prescription. Every work_unit carries `prescribed_original → adjustments_applied → prescribed_effective → executed`. The distance between planned and needed is the most valuable training datum for v3 — it is never silently lost.

**Suggest, don't impose (Model C).** Every rule declares `authority`; v2 ships everything as `suggest`. The field exists so v3 can promote individual rules to `auto` once data proves them. Deload proposals are always suggest. The athlete who reports honest RIR is already autoregulating; the system formalizes and proposes, it does not supplant judgment.

**Asymmetry.** Reduce on one signal; increase only on two consecutive signals, capped at +5%/session. An unusually good day is usually noise; an unusually bad day is usually signal. The system brakes on its own but never accelerates on its own (the green_light_day flag exists looking ahead to v3 automation).

**Graceful absence.** No rule may assume reported signals exist. Missing data → the rule sleeps. No nagging. Total friction budget for a typical session: ~20 taps, under a minute.

## 3. Signals (C.1)

Level 0 (automatic, zero friction): reps_completed, load_used, set_failed, times — already produced by the executed state. Level 1 (reported): RIR per set (scale truncated at "5+" — self-report precision beyond that does not exist; UI pre-populates the target so the common case is one tap), RPE CR-10 once per conditioning block, a 4-item readiness questionnaire (sleep, soreness, energy, stress; ≤15s; optional), ad-hoc pain flags (region + severity 1-10), and optional bar velocity. Derived signals do the analytical work: rir_delta, e1RM estimates (Epley + RIR), undershoot streaks, ACWR of conditioning load, readiness deltas vs the athlete's own 14-day baseline.

## 4. The intra-session engine (C.2)

Runs after each set, each block close, and immediately on pain. Core conversion: **1 RIR ≈ 2.5% load** (3.0 near max, 2.0 in high-rep zones). Twelve rules, but the deeper design is the **method adjustment profile**: every method declares which knobs are adjustable and which are protected. Cluster protects load (extend rest, then cut clusters); rest_pause's activation RIR is structurally 0 (RIR ≥3 flags the load as too light); AMRAP adjusts nothing — it *is* the measurement; pyramid protects the structure but trims the planned peak when approach sets undershoot; contrast never loads the explosive component to compensate. Cascade prevention: one load rule per block, conflict resolution by severity, hard budget of 3 adjustments per session (the 4th becomes a flag: the problem is the plan, not the day).

Pain semantics: 1-3 logged; 4-6 substitution via catalog equivalences avoiding the region (first real consumer of B.2.4 edges) or −20% fallback; 7+ suggest ending the block plus professional consultation. The system grades prudence; it never interprets pain.

## 5. Volume per muscle group (C.3)

Fractional counting (primary 1.0, secondary 0.5, catalog override) over a **rolling 7-day window**, with method-aware set conventions (drop = 1 + 0.5/segment, rest_pause = 1.5, cluster = 1, contrast pair = 1) and an effective-set threshold (RIR ≤ 4 — warmups and approach sets exclude themselves). Conditioning lives in a separate bucket (Foster session-RPE load) feeding ACWR. Status per group vs configurable RP-style landmarks (MEV/MAV/MRV, population defaults, athlete calibration marked for v3): below_mev | productive | high | exceeded. This is the engine that exposes invisible indirect volume — triceps quietly accumulating 11 effective sets from five pressing exercises.

## 6. The inter-session engine and fatigue state (C.4)

Acts on the **next session only** (week-level modulation is Layer D). Nine rules: pattern-level load reductions on undershoot streaks, progression holds and resumes, MRV-driven accessory trimming, ACWR guards (spike >1.5, detraining floor <0.8 suppressed during declared taper), and escalation flags. The fatigue model is an **interpretable discrete state** (fresh / normal / accumulating / overreached) derived from declarative any-2-of conditions — an explicit rejection of opaque numeric scores. Every state transition carries the conditions that fired it. The most trusted signal is objective: estimated 1RM declining ≥5% across 3 sessions on hub lifts.

## 7. Deload (C.5)

**Reactive only** — evidence-driven. Scheduled deloads belong to D (interaction marked: a reactive deload near a planned one should advance it, not duplicate). Default recipe: volume deload, **−40% sets, intensity maintained, 7 days, conditioning capped at 50% of chronic**. The escalation chain ensures proportionality: set adjustment → next-session adjustment → accessory trimming → local deload → global deload, each level firing only when the previous proved insufficient, with a 21-day suppression window after any completed deload. Post-deload effectiveness is measured automatically (readiness, e1RM, state transition) — the record from which v3 learns which deload type works for *this* athlete.

## 8. Readiness (C.6)

Deviation from the athlete's own baseline, never absolute values. Green (Δ ≥ −0.5): silence. Yellow (−1.2 < Δ < −0.5): trim accessories 20%, hold progression — protect what matters, cut the optional. Red (Δ ≤ −1.2): −10% global plus the option of a light technique session. A single item at 1/5 forces minimum yellow regardless of the mean. First 7 days accumulate baseline without modulating; no questionnaire, no modulation, no nagging.

## 9. What C leaves for later

- **Layer D** consumes fatigue_state and volume_status for week/mesocycle structure, formalizes `taper_declared`, and owns scheduled deloads.
- **Catalog addendum pending:** `loaded_regions` per exercise + `fn:exercise_loads_region` (powers pain-driven substitution).
- **v3 hooks planted:** per-rule authority promotion to auto, reporter-reliability calibration (`signal_confidence`), athlete-specific landmark calibration, deload-type personalization, and stale-progress rotation suggestions via the drift target index.

---

*Machine consumption: `autoregulation_schema.yaml` + `adjustment_rules.yaml`. Block flags: Section T of `flag_catalog.yaml`. Functions: Group 12 of `validator_functions_spec.md`.*
