# Periodization — Layer D Reference Manual

**Scope:** Temporal organization of training — templates, microcycles, mesocycles, macrocycles, events, taper, and the C↔D integration.
**Status:** Layer D closed. **v2 design complete (A+B+C+D).**
**Date:** 2026-06-10.
**Companion files:** `periodization_schema.yaml`, `periodization_models.yaml`, `template_examples.yaml`.

---

## 1. What D adds

A defines the block, B the exercises, C the reaction. D answers the remaining question: how do sessions organize across time toward a dated goal? Four levels — session → microcycle → mesocycle → macrocycle — each with its own rules: the microcycle manages frequency and interference; the mesocycle manages progression and unloading; the macrocycle manages phases, events, and peaks.

## 2. Templates: the system's lingua franca

Templates exist at three levels (session, microcycle, mesocycle), composed by reference, varied by **fork with lineage** — never inheritance. Instances freeze their template version; deviations are traceable. Parameterization runs through relative loads (free, by A's design), scalable volumes (landmark_relative, fed by C.3), and **exercise placeholders**: catalog queries (pattern, implement, demand) resolved at materialization with equivalence-graph fallback — one template materializes differently in every gym without edits. Materialization is a 5-step pipeline (bind → resolve → scale → validate → emit) with validation in two times: template-time (structural + relative — the authoring mode, no athlete needed) and materialization-time (+ absolute checks when a profile exists). Templates are the lingua franca between human and generated programming: v3 will emit them, and completed instances plus C's outcomes are its training corpus. Two worked templates (strength 4+1 and HYROX concurrent 3+1) were validated end-to-end against the catalog and taxonomy.

## 3. Microcycle: slots, frequency, interference

A microcycle is typed **slots with intent** (strength/hypertrophy/power/conditioning/mixed/technique/recovery), not concrete sessions — the slot is the contract, the session the fulfillment. `days_span` ranges 5-10 (default 7); non-calendar microcycles are a variety input for the v3 generator. Frequency targets are validated structurally here while C.3 validates dose — complementary, never overlapping. The **interference catalog** (10 seed rules with physiological rationale: quality running ≥48h after heavy lower, no adjacent lactic-high days, power requires freshness, axial loading spacing, strength-before-conditioning same-day ordering, budgets, rest density, technique freshness) caps at *warning* — coaches violate interference deliberately — with one key user decision: **warnings for humans are constraints for the v3 generator** (`v3_constraint: true`). Noted for future: grip-intensive spacing before heavy pulls; hard-surface running before plyometrics.

## 4. Mesocycle: week types, progression, proactive deloads

Four week types: standard, **planned_deload** (reusing C.5's `prescription_deltas` verbatim — one deload language; reactive and proactive differ in trigger, not shape), **test** (materializes AMRAP blocks on hub lifts, feeding C.4's e1RM calibration with the highest-quality data — A's "pure measurement" method finds its structural home), and intro. Week modifiers are structured (dimension + delta + scope) and the progression scheme separates a structured ramp from prose, enabling coherence validation against the declared model. The deload-overdue threshold is a user decision worth highlighting: **4-7 weeks, inverse to athlete level** — advanced athletes train closer to their limits and accumulate fatigue faster (effective threshold = min(level, model override)).

## 5. Periodization models as first-class citizens

The exact symmetry with A's methods: labels elevated to schemas. Five models — linear (2 variants), undulating (2, with emphasis/specialization marked as its future home), block (3: one mesocycle = one block, the A→T→R sequence lives at macro), conjugate (the intensive consumer of placeholders and the equivalence graph as rotation engine; rotation is built-in fatigue management, hence the most relaxed deload threshold), and concurrent_hybrid (3 variants; interference rules mandatory; the tightest deload threshold — dual load accumulates fastest). Each carries `week_structure_logic`, the D-level analog of A's `progression_logic` hook: v2 validates expectations, v3 executes them. Four model-drift rules (linear that undulates, DUP with identical slots, concurrent with ramping strength, conjugate without rotation) — informational for humans, constraints for the generator.

## 6. Macrocycle, events, taper

The macro is instance-first, anchored to real dates. Events carry **A/B/C priority**: A gets the full taper and the whole macro aims at it; B gets a mini-taper; C is trained through. Phases use a closed 5-value vocabulary (general_prep, specific_prep, peak, competition, transition) plus **tags with a promotion criterion** — base and off_season live as tags because enum values must earn their place through distinct system behavior (off_season is a season segment containing phases, a category error as a purpose). The taper is formal: volume −50% (evidence range 40-60), **intensity and frequency maintained** (reducing intensity is the classic error), exponential by default, 8-14 days for A events. `taper_declared` closes C's loop in both directions: it suppresses the detraining flag and modulates fatigue interpretation, while `taper_not_producing_freshness` warns early if the taper isn't working. The event is the only immovable date in the system.

## 7. C↔D integration

Three resolutions: a reactive deload proposal within 10 days of a planned one **advances** the planned week (the plan was right about what; data corrects when); deload signals within the 21-day suppression window after a completed planned deload flag `planned_deload_insufficient` (a structural signal — recipe too light or mesocycle too aggressive); standalone proposals insert an ad-hoc week. Calendar arithmetic: **shift by default, absorb the lightest standard week when shifting collides with an event**. At materialization, C's fatigue_state modulates the week: accumulating → **HOLD** (repeat last week's modifiers — progression paused, not lost); overreached → route to deload. Volume status feeds template scaling (chronic exceeded trims; chronic below-MEV suggests adding), laying the exact infrastructure the future emphasis/specialization variant will use with asymmetric landmarks.

## 8. What D leaves for later

- **Prescriptor v2 (UI):** the implementation that makes all four layers usable.
- **v3 generator:** consumes everything — week_structure_logic per model, interference constraints, the template library + instance outcomes corpus, reverse planning from event dates, span variety, drift constraints.
- **Marked extensions:** macro_templates (canned programs), emphasis/specialization, the two noted interference rules, tag promotions as behavior accumulates.

---

*Machine consumption: `periodization_schema.yaml` + `periodization_models.yaml`. Examples: `template_examples.yaml`. Flags: Section U. Functions: Group 13.*
