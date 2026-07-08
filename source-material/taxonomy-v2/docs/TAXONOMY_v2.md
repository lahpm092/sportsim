# Training Taxonomy v2.0 — Reference Manual

**Scope:** Anaerobic and resistance training prescription, registration, and analysis.
**Status:** Foundation frozen at method layer (A complete).
**Date:** 2026-06-09.
**Companion files:** `taxonomy_v2.yaml`, `taxonomy_v2_methods_part2.yaml`, `validator_functions_spec.md`, `flag_catalog.yaml`, `drift_rules.yaml`.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Evolution from v1.1](#2-evolution-from-v11)
3. [Conceptual Architecture](#3-conceptual-architecture)
4. [The Six Zone Classification Strategies](#4-the-six-zone-classification-strategies)
5. [The Nine Methods](#5-the-nine-methods)
6. [The Three Complex Families](#6-the-three-complex-families)
7. [Flags and Drift Detection](#7-flags-and-drift-detection)
8. [Hooks Reserved for v3 and Beyond](#8-hooks-reserved-for-v3-and-beyond)
9. [Glossary](#9-glossary)

---

## 1. Executive Summary

Training taxonomy v2 is a complete formal specification of how anaerobic and resistance training methods are organized, parameterized, validated, and progressed. It builds on v1.1 (which established zones, force-velocity modifiers, and parallel categories) by elevating training methods themselves from labels to first-class citizens with their own schemas, parameters, classification strategies, and validation logic.

Where v1.1 had nine methods listed as enum values, v2 has nine methods with **40 declared variants**, each carrying its own canonical defaults, parameter ranges, time topology, stopping rules, drift detection rules, and zone classification strategy. The foundation is designed to be **executable**: every decision is captured in declarative YAML rules that a generic validation engine can interpret, with strategic escape hatches into code (`fn:` hooks) where the logic is too complex for declarative expression.

The system distinguishes between **prescription** (what was planned), **execution** (what happened), and **partial** (what was started but not completed) as block states, enabling the retrospective comparison that future automation will use to learn an athlete's patterns. It treats `family`, `intent_declared`, and other critical decisions as **mandatory declared fields** rather than inferences, preserving historical immutability for analysis.

The end goal — automated routine generation and progression with minimal external input — is not implemented in v2. But v2 lays the structural groundwork: every method has a `progression_logic` hook reserved for v3, drift detection has reverse-indexed targeting for generator selection, and the validation pipeline is engineered so that "the generator chose X" produces data that is semantically identical to "the coach declared X."

---

## 2. Evolution from v1.1

### What v1.1 had

- **6 zones** (Z1-Z6) on the neural-to-metabolic continuum.
- **6 force-velocity modifiers** (FV1-FV6) as intent/velocity tags.
- **4 parallel categories** (ballistic, plyometric, olympic, dynamic_effort) for movements outside the Z1-Z6 axis.
- **9 method tags** (straight, cluster, drop, rest_pause, contrast, complex, emom, amrap, pyramid) — but only `straight` and `amrap` were truly parameterized; the others were placeholder labels.
- **Layer 4 classification algorithm** with weighted scoring (reps 0.5, load 0.3, RIR 0.2).
- **Viability check** (Epley inverse) and tie-breaker logic.
- **Method-aware validation routes** declared but not fully implemented.

### What v2 adds

**Methods as first-class citizens.** Each method has:
- A formal `method_definition` (id, name, structure_modifier, intent_resolution, time_topology, stopping_rule, validation_route, exercise_count_rule, zone_classification_rule, drift_rules, variants).
- Multiple variants with their own defaults, parameter schemas (with `range_canonical` and `range_extended`), and work_unit extensions.
- A dedicated validator function.

**Work_unit as canonical atomic unit.** Replaces v1.1's `set` and the polymorphic component objects implicit in EMOM, contrast, and complex. One base object, multiple extensions declared per method.

**State lifecycle.** `prescribed | executed | partial` formalized as a block field with allowed transitions, enabling retrospective validation and execution tracking.

**Three categories instead of two.** `main`, `parallel`, and the new `conditioning` (for circuit methods that don't classify in Z1-Z6).

**Six zone classification strategies.** Formalized as named functions, each method declares which strategy it uses. The original "first continuous effort" principle is refined and exceptions are explicit.

**Drift detection as declarative system.** 30 drift rules in YAML, evaluated by a generic engine. Each rule says "if these conditions are true, the block probably should be method X instead of Y."

**Formal flag system.** 117 flags with three severities (`informational`, `structural_hard`, `viability`) and four graduated viability levels (`ok`, `warning_mild`, `warning_strong`, `hard_fail`). Each flag has structured `detail` following one of four base patterns.

**Mandatory declared fields.** `family` (for complex) and `intent_declared` (for all methods) are declared, not inferred. The UI pre-populates them, but the values are written and immutable, supporting future automation.

**Contextual suggestions.** When the system detects drift or invalid prescriptions, it doesn't just say "this is wrong" — it inspects the block's parameters and suggests the appropriate method/variant. This pattern, formalized in A.9.7, is **the foundation for the v3 generator**.

### What v2 explicitly does not have

- **Catalog of exercises (Layer B).** Mentioned and reserved as `exercise_ref`, but not built. Several validations and the full mechanical_drop progression logic depend on it.
- **Autoregulation (Layer C).** Feedback loops from RPE/velocity to adjust prescriptions in flight.
- **Periodization (Layer D).** Composition of sessions into microcycles, mesocycles, macrocycles.
- **The generator itself (v3).** v2 prepares the data; v3 uses it.

---

## 3. Conceptual Architecture

### 3.1 The five conceptual layers

The taxonomy operates in five conceptual layers that work together:

**Layer 1 — Adaptation zones (Z1-Z6).** The primary axis. Six zones along the neural-to-metabolic continuum. Most methods classify their blocks into one of these zones.

**Layer 2 — Force-velocity modifiers (FV1-FV6).** A secondary axis tagging intent and execution velocity. Modifies the meaning of a zone (e.g., Z2 with FV1 is heavy strength; Z2 with FV2 is strength-speed).

**Layer 3 — Parallel and conditioning categories.** Movements that don't live on the Z1-Z6 axis. Parallel categories (ballistic, plyometric, olympic, dynamic_effort) have their own loading logic. Conditioning blocks (complex/circuit) operate on the energy system axis.

**Layer 4 — Classification algorithm.** The scoring engine that infers zones from reps/load/RIR. Refined in v2 with explicit strategies (six of them) and exceptions for methods that don't fit the standard pattern.

**Layer 5 — Energy systems.** Optional metadata (alactic, lactic, aerobic_power, mixed) tagging the dominant energy system. Becomes structural for circuit blocks.

### 3.2 The four data hierarchies

**Block hierarchy:** `session → exercise_block → work_unit`. Sessions contain multiple blocks; each block contains multiple work_units.

**Method hierarchy:** `method → variant → optionally family`. Cluster has variants (singles, doubles_triples, rest_pause_style); complex has variants organized into families (single_load_chain, independent_load_chain, circuit).

**Validation hierarchy:** `validation_result → zone_classification + viability + flags by severity + informative_metrics`. The result is a structured object, not a flat list of issues.

**Drift hierarchy:** `drift_rules → conditions → flag with suggestion`. Each method declares rules; the engine evaluates them.

### 3.3 The core principles

**Principle of declared immutability.** Critical decisions (family, intent_declared, zone_declared) are declared at block creation and never reinterpreted on read. This protects historical data from changes in classification logic.

**Principle of first continuous effort (refined).** The zone of a block is inferred from the first continuous effort, where "continuous" means without significant rest (>10s). Exceptions are declared per method.

**Principle of structural vs semantic validation.** Structural validation checks that the schema is satisfied. Semantic validation (drift detection) checks whether the user's intent matches the method declared. The two are orthogonal.

**Principle of graduated viability.** Some things are wrong (`structural_hard`, blocks acceptance). Some things are concerning but acceptable (`viability` with levels). Some things are just observations (`informational`). The asymmetry reflects reality.

**Principle of declarative-first.** Whenever possible, behavior is defined in YAML rules, not code. Code is reserved for what cannot be expressed declaratively (algorithms, estimations, complex pattern detection).

### 3.4 The three patterns that emerged

**Polymorphism of components.** The `work_unit` is a canonical base object extended by each method with its own fields. This pattern emerged organically through EMOM, contrast, and complex; consolidating it in A.9.5 makes it reusable for future methods.

**Strategy-based zone classification.** Different methods classify zone differently. The six strategies (`first_continuous_effort`, `first_segment`, `top_set`, `dominant_component_distribution`, `chain_complete`, `energy_system_dominant`) cover all current cases and are extensible.

**Contextual suggestions.** When validation flags fire or drift is detected, the system inspects the block's actual parameters to generate a suggestion — not a generic "try something else" but a specific "try X with parameters Y." This pattern, simple in v2, becomes the heart of the v3 generator.

---

## 4. The Six Zone Classification Strategies

Zones (Z1-Z6) describe adaptation along the neural-to-metabolic continuum. But different methods produce zones in structurally different ways. The six strategies formalize these patterns.

### 4.1 first_continuous_effort

**Used by:** straight, cluster, rest_pause, contrast (heavy component), amrap.

**Logic:** The zone is inferred from the first uninterrupted unit of work. For cluster, that's `reps_per_cluster` (a cluster of singles is Z1 regardless of total reps). For rest_pause, it's the activation reps. For amrap in `prescribed` state, it's the expected reps from Epley inverse; in `executed` state, it's the actual reps.

**Rationale:** A cluster of 5×1 at 90% is neurally Z1, even though total reps is 5. The first cluster is the unit of adaptation; subsequent clusters are repetitions of that unit. Same logic applies to rest_pause activation and contrast heavy components.

### 4.2 first_segment

**Used by:** drop (all variants).

**Logic:** The zone is inferred from the first segment of a drop set (before any drop). The drops themselves are intensification of that first segment.

**Difference from `first_continuous_effort`:** When `rest_between_drops_sec ≤ 10`, the drop set could technically be considered "continuous." The principle would then suggest summing reps across segments. We explicitly chose **not** to do this (option C from A.9.1), because drop's identity is "first segment + intensification," not "aggregated chain." But we report `zone_if_treated_as_continuous` as an informative metric so analysis can use either interpretation.

### 4.3 top_set

**Used by:** pyramid (ascending, descending, wave), emom/ascending_load.

**Logic:** The zone is inferred from the peak-intensity set in the block. For ascending pyramids, that's the last set; for descending, the first; for wave, the last set of the last wave; for ascending_load EMOM, the work in the final interval.

**Rationale:** Pyramids and ascending EMOMs are designed around a peak. The peak set defines the training intent; the other sets are warm-up or back-off relative to it.

### 4.4 dominant_component_distribution

**Used by:** pyramid/double, emom/alternating, complex/independent_load_chain (all four variants).

**Logic:** Each component or set in the block is classified independently. The block's zone is the most frequent zone (with tie-breaker by lower index). The full distribution and zone spread are reported as informative metrics.

**Rationale:** These methods deliberately span multiple zones simultaneously. A giant set for quads with squat (Z3), leg press (Z4), and lunges (Z5) doesn't have a single zone; it lives in three zones. The dominant zone is a useful summary, but the spread is what matters.

### 4.5 chain_complete

**Used by:** complex/single_load_chain (olympic_complex, strongman_complex, kb_flow, mace_flow).

**Logic:** The chain is treated as a single continuous effort. The zone is inferred from `total_reps_per_round` and the shared load.

**Rationale:** In single_load_chain, components flow into each other with minimal rest (≤5s). The "first continuous effort" is the entire chain, not any individual component. An olympic complex of clean_pull + hang_clean + front_squat + push_press at 65% with 2+2+3+3 reps is a 10-rep set at 65%, not a 2-rep set at 65%.

### 4.6 energy_system_dominant

**Used by:** complex/circuit (fixed_round_circuit, time_capped_circuit, chipper, tabata).

**Logic:** No Z1-Z6 classification. The block reports `dominant_energy_system` (alactic / lactic / aerobic_power / mixed), `estimated_total_duration`, and `work_to_rest_ratio`. Per-component zones are still computed as informative data.

**Rationale:** Circuit operates on the energy system axis, not the neuromechanical axis. Forcing a Z1-Z6 label on a 20-minute fixed_round_circuit produces a number that doesn't reflect the training stimulus. The honest answer is "this is lactic conditioning," not "this is Z5 with high spread."

### 4.7 Strategy mapping

Each method declares its strategy explicitly:

```
straight, cluster, rest_pause, contrast, amrap → first_continuous_effort
drop                                             → first_segment
pyramid/ascending, descending, wave              → top_set
emom/ascending_load                              → top_set
pyramid/double                                   → dominant_component_distribution
emom/alternating                                 → dominant_component_distribution
complex/independent_load_chain                   → dominant_component_distribution
complex/single_load_chain                        → chain_complete
complex/circuit                                  → energy_system_dominant
```

This mapping lives in `taxonomy_v2.yaml.zone_classification.method_to_strategy_mapping`.

---

## 5. The Nine Methods

### 5.1 straight

**Description:** Sets of the same exercise with the same load and reps, separated by declared rest.

**Variants:** 1 (default).

**When to use:** Most foundational method. Strength, hypertrophy, endurance — any time you want to repeat a defined effort multiple times.

**Key parameters:** load_pct_1rm, reps_target, rir_target, sets, rest_inter_set_sec.

**Zone classification:** first_continuous_effort.

**Exercise count:** exactly 1.

### 5.2 cluster

**Description:** A set fragmented into mini-groups ("clusters") separated by short intra-set rest. Load doesn't change between clusters.

**Variants:** 3.
- `singles` — 1+1+1+1+1, 15-20s rest. Max velocity per rep.
- `doubles_triples` — 2+2+2 or 3+3, 20-30s rest. Volume + velocity.
- `rest_pause_style` — 4-8+1-2+1-2, 10-15s rest. Hypertrophy via metabolic load.

**When to use:** To solve the conflict between high load and high volume. 4×5(1+1+1+1+1) at 90% gives 20 total reps with quality preserved.

**Zone classification:** first_continuous_effort (reps_per_cluster, not total reps).

**Frontier with rest_pause:** cluster pre-declares reps and clusters; rest_pause goes to failure each mini-tanda. Cluster rest is typically 15-25s; rest_pause is 10-20s. Overlap exists; the systems detect drift.

### 5.3 drop

**Description:** A set that continues after failure (or near it) by reducing load and continuing with no significant rest.

**Variants:** 4.
- `single_drop` — initial load + 1 drop.
- `double_drop` — initial load + 2 drops.
- `descending` — 3+ drops in succession.
- `mechanical_drop` — load unchanged; mechanical demand reduced via angle/leverage/assistance/ROM. 5 mechanisms covered.

**When to use:** Hypertrophy with intensification. mechanical_drop is critical for calisthenics and limited-equipment training.

**Zone classification:** first_segment (drop's exception to the continuous effort principle).

**Frontier with rest_pause:** drop reduces load; rest_pause maintains load. Different stimuli (metabolic vs mechanical).

### 5.4 rest_pause

**Description:** Activation set to failure (or near), short rest (10-20s), then mini-tandas with the same load until exhaustion.

**Variants:** 3.
- `myo_reps` — activation 12-20 reps @RIR 1, then mini-tandas of 3-5 reps. Origin: Børge Fagerli.
- `dc_style` — one heavy set, ~15 breaths, another heavy set, ~15 breaths, another. Origin: Doggcrapp.
- `mentzer_style` — single set to absolute failure, extended with techniques (negatives, partials, etc.). Origin: HIT.

**When to use:** Mass and hypertrophy with strong mechanical signal. Doggcrapp variant is the most strength-oriented.

**Zone classification:** first_continuous_effort (activation reps).

**Frontier with cluster:** rest_pause requires failure on activation (RIR ≤ 1) and shorter rests. Cluster preserves quality with pre-declared structure.

### 5.5 amrap

**Description:** "As Many Reps As Possible." A single set executed to failure (or to a declared stopping condition). Reps are output, not input.

**Variants:** 3.
- `to_failure` — single set to RIR 0. Pure testing.
- `time_capped` — max reps within a time limit. Conditioning + testing.
- `rep_capped` — reps until RIR target or cap. Autoregulation-friendly.

**When to use:** Testing capacity, calibrating 1RM (via Epley), or producing data for the system to learn from. The retrospective comparison (state=executed) is where amrap's value to v3 lives.

**Zone classification:** first_continuous_effort. In prescribed state uses Epley-inverse(load) as expected reps; in executed state uses actual reps.

**Frontier with straight:** rep_capped AMRAP that consistently reaches the rep_cap before the RIR target is functionally straight; the system flags this.

### 5.6 pyramid

**Description:** A sequence of sets where load and reps change in inverse relation between sets. Crosses multiple zones in a single block.

**Variants:** 5.
- `ascending` — load up, reps down. Classic warm-up to top set.
- `descending` — load down, reps up. Front-loaded strength + back-end hypertrophy.
- `double` — up to a peak then down symmetrically. High volume across zones.
- `wave` — 3-set waves with progressively heavier peaks. Origin: Poliquin.
- `multi_exercise_pyramid` — pyramid structure applied across multiple exercises in each round. Each round uses the same N exercises, with load increasing and reps decreasing across rounds. Popular in powerbuilding and high-volume systems (GVT with progression). Exception to pyramid's single-exercise rule, analogous to mechanical_drop within drop.

**When to use:** Exposure to multiple adaptations in a single block; calibrating top loads; building toward a peak. `multi_exercise_pyramid` is for sessions where you want pyramid structure but on multiple exercises simultaneously (e.g., squat + bench + row with shared load progression).

**Zone classification:** top_set for ascending/descending/wave/multi_exercise_pyramid; dominant_component_distribution for double.

**Frontier with straight:** if load variance < 10%, pyramid is functionally straight; flag fires.

**Frontier with circuit:** for multi_exercise_pyramid, if load doesn't change meaningfully across rounds, drift to fixed_round_circuit fires.

### 5.7 emom

**Description:** "Every Minute On the Minute." Each interval (typically 60s) begins a new bout of work; remaining time is rest.

**Variants:** 4.
- `every_minute` — standard 60s interval.
- `every_n_seconds` — custom interval (30s, 45s, 90s, 2 min).
- `alternating` — multiple exercises rotating per interval.
- `ascending_load` — same exercise; load rises each interval.

**When to use:** Conditioning with controlled pacing; testing under fatigue; HYROX/CrossFit-style work.

**Zone classification:** first_continuous_effort by default; dominant_component_distribution for alternating; top_set for ascending_load.

**Frontiers:**
- emom/every_minute with 4 min duration, 30s interval, 20s/10s work/rest → drifts to tabata.
- emom/alternating with 3+ exercises and >90s interval → drifts to circuit.
- emom with single interval → drifts to amrap/time_capped.

### 5.8 contrast

**Description:** Two or more exercises coupled within the same set, alternating between high-intensity and explosive components. The structure is designed to exploit post-activation potentiation (PAP).

**Variants:** 4.
- `heavy_light` — classic heavy + explosive pair.
- `french_contrast` — 4 components covering the F-V spectrum (heavy_strength, heavy_plyo, loaded_explosive, unloaded_plyo). Origin: Cometti.
- `wave_contrast` — heavy+light pair repeating with heavier peaks each wave.
- `complex_pairs` — explosive primer before the heavy set (reverse contrast).

**When to use:** Power development; transferring strength to expression of velocity. Cornerstone for athletes in jumping/throwing/sprinting sports.

**Zone classification:** first_continuous_effort (from the heavy component, by `reps_per_rep`).

**Frontier with superset:** contrast requires shared movement pattern between components (e.g., squat + jump squat). Superset typically uses antagonist or independent patterns. Flag fires if pattern coherence breaks.

### 5.9 complex

**Description:** A chain of N exercises executed as a unit. Three structurally distinct families.

**Variants:** 13, organized into 3 families.

| Family | Variants | Distinguishing trait |
|---|---|---|
| single_load_chain | olympic_complex, strongman_complex, kb_flow, mace_flow | Shared load (same implement) |
| independent_load_chain | giant_set, accessory_complex, peripheral_heart_action, superset, antagonist_giant_set | Independent loads per component |
| circuit | fixed_round_circuit, time_capped_circuit, chipper, tabata | Time-driven; conditioning intent |

**When to use:** Depends entirely on family.
- single_load_chain: technical mastery (olympic), conditioning (kb), accumulation (strongman).
- independent_load_chain: hypertrophy density (giant_set, antagonist_giant_set), conditioning (PHA), time savings (superset).
- circuit: pure conditioning, HYROX/CrossFit work, mental toughness (chipper).

**Zone classification:** depends on family.
- single_load_chain → chain_complete.
- independent_load_chain → dominant_component_distribution.
- circuit → energy_system_dominant (no Z classification).

**The dispatcher pattern.** complex is the only method with a two-level validator: top-level `validate_complex` dispatches to `validate_single_load_chain`, `validate_independent_load_chain`, or `validate_circuit` based on declared family. This is the most complex piece of the v2 system, justifying its own complete chapter in section 6.

---

## 6. The Three Complex Families

Complex is structurally distinct from other methods because it represents a category of compound training rather than a single technique. The three families are functionally different ways of organizing component chains.

### 6.1 single_load_chain

**Distinguishing property:** all components share the same physical load (same implement, not released).

**Implications:**
- Load is prescribed once at the block level, not per component.
- Load is limited by the weakest component in the chain.
- Rest between components is 0-5 seconds (transition time only).
- Order matters: technically complex components first (technique degrades with fatigue).

**Variants:**

**olympic_complex** — chain of olympic derivatives (clean pull → hang clean → front squat → push press). Technical mastery + neural training. Cargas 60-75% of weakest link. Typical: 3-6 components, 2-3 reps each, 3-6 rounds.

**strongman_complex** — chain of heavy movements with same implement, less technical (deadlift → row → RDL → hang clean). Origin: barbell complex by Dan John. Cargas 30-60% of weakest link. Higher reps per component (5-10). Conditioning with significant loads.

**kb_flow** — kettlebell chain where the bell never touches the ground. Coordination, mobility under load, conditioning. Single KB declared. 3-8 components, 3-8 reps each.

**mace_flow** — analogous to kb_flow with mace or club. Rotational and bilateral patterns. Smaller load (7-12 kg typical).

### 6.2 independent_load_chain

**Distinguishing property:** each component has its own load, equipment, and potentially location.

**Implications:**
- Load is per-component, not block-level.
- Each component can fall in a different zone.
- Rest between components is 0-60 seconds.
- Order matters by muscle group strategy, not technical safety.

**Variants:**

**giant_set** — 4+ exercises for the same muscle group, executed consecutively. Saturation hypertrophy. Cargas typically decrease through the chain (harder first, easier later). 3-4 rounds.

**accessory_complex** — 3+ exercises with assistance/accessory purpose. May not target same muscle group. Used for prehab, balance, sport-specific work. More permissive rest (30-90s between components).

**peripheral_heart_action (PHA)** — 5-8 exercises alternating upper and lower body deliberately. Forces blood redistribution; significant cardiovascular demand without local saturation. Origin: Bob Gajda, popularized by Vince Gironda.

**superset** — exactly 2 exercises paired. Antagonist (push/pull) or upper/lower. Time efficiency + density.

**antagonist_giant_set** (added in A.10) — 4-6 exercises organized into 2-3 antagonist pairs. Each pair alternates components with opposing muscle groups, allowing local rest while the antagonist works. Doubles total volume vs a standard giant_set in the same time. Each component declares `pair_index` (which pair it belongs to) and `role_in_pair` (agonist | antagonist). Popular in bodybuilding for chest/back, biceps/triceps, and quad/hamstring pairings. With `pairs_count: 1` it collapses to a superset; the drift system flags this.

### 6.3 circuit

**Distinguishing property:** time and structure dominate over individual prescription. Components are typically light or bodyweight; the block's identity is its temporal structure.

**Implications:**
- Energy system tag is mandatory (not Z1-Z6).
- Stops by clock or completion, not by failure.
- Rest is minimal between components.
- Per-component classification is informative only; block-level is energy-system-based.

**Variants:**

**fixed_round_circuit** — N components, M rounds, declared rest between rounds. Predictable structure. CrossFit-style or HYROX-style WODs.

**time_capped_circuit** — multi-exercise AMRAP. As many rounds as possible within time limit. "Cindy" benchmark is canonical example.

**chipper** — long list of exercises with high front-loaded reps, executed once in order. 5-10 components, 20-50 reps typical. Mental toughness + sustained conditioning.

**tabata** — fixed structure: 8 rounds × 20s work / 10s rest = 4 minutes. 1-2 exercises max. Origin: Izumi Tabata's research.

### 6.4 Choosing the right family

The decision tree is mostly structural:

```
Are all components done with the same physical load/implement?
├─ Yes → single_load_chain
│       ├─ Olympic derivatives → olympic_complex
│       ├─ Barbell movements, less technical → strongman_complex
│       ├─ Kettlebell flow → kb_flow
│       └─ Mace/club rotational → mace_flow
│
├─ No, each component has independent load → independent_load_chain
│       ├─ 2 exercises → superset
│       ├─ 4-6 exercises in antagonist pairs → antagonist_giant_set
│       ├─ 4+ exercises, same muscle group → giant_set
│       ├─ Alternating upper/lower → peripheral_heart_action
│       └─ Mixed assistance/accessory → accessory_complex
│
└─ Time-driven, conditioning intent → circuit
        ├─ Fixed rounds + rest → fixed_round_circuit
        ├─ AMRAP rounds in time → time_capped_circuit
        ├─ Single pass, high front-loaded reps → chipper
        └─ Canonical 20/10 × 8 → tabata
```

When the choice is ambiguous, drift detection rules guide the user toward the correct family.

---

## 7. Flags and Drift Detection

### 7.1 Three severities

**informational** — observations that don't block the block. Suggestions for better labeling, notable patterns, helpful context. Examples: "this looks more like X" or "1RM may be underestimated."

**structural_hard** — the block violates the schema of its declared method. Blocks acceptance until fixed. Examples: cluster with multiple exercises, contrast with wrong roles, PHA with broken alternation.

**viability** — the prescription is physiologically questionable. Graduated by level (warning_mild, warning_strong, hard_fail). Examples: 10 reps at 90% (overprescribed), 5 reps at 50% (underloaded for rep range).

### 7.2 The asymmetry of severity

`overall_coherent` is `false` if and only if there is at least one `structural_hard` flag or at least one `viability` flag at `hard_fail` level. Informational flags and softer viability levels do not affect coherence.

This asymmetry reflects how the system treats different concerns:
- Schema violations are non-negotiable.
- Severe physiological issues block.
- Mild or moderate concerns surface but allow proceeding.
- Stylistic or semantic suggestions never block.

### 7.3 Flag structure

Every flag is a structured object, not a string:

```yaml
flag:
  id: unique snake_case
  severity: informational | structural_hard | viability
  level: ok | warning_mild | warning_strong | hard_fail | null
  message: human-readable description with placeholders
  detail: structured object following one of four base patterns
  suggestion: optional contextual recommendation
  related_flags: cross-references to related flags
```

The four detail patterns:
- **component_pattern** — flags about specific components (PHA alternation, giant_set patterns, olympic_complex order).
- **viability_pattern** — flags about physiological viability (overprescribed, underloaded, etc.).
- **drift_pattern** — flags suggesting alternative methods (X resembles Y).
- **consistency_pattern** — flags about internal data consistency (cluster reps mismatch, family mismatch).

### 7.4 Drift detection

Drift is the system's mechanism for recognizing when a block's declared method doesn't capture what the user is actually doing. It's distinct from structural validation:

- **Structural validation** asks: "Does this satisfy the schema?"
- **Drift detection** asks: "Even if the schema is satisfied, is the intent captured by another method better?"

The drift engine is declarative: 30 rules in `drift_rules.yaml`, each specifying:
- Origin method/variant (where the rule applies).
- Target method/variant (what the user probably wants).
- Conditions (boolean expressions; all must be true).
- Severity (typically informational; structurally_hard for incompatibilities).
- Suggestion (contextual recommendation).

The engine evaluates conditions against the block state. When a rule fires, a drift flag is emitted.

### 7.5 The drift catalog at a glance

30 rules organized by origin method, covering the major frontiers between methods:

- **cluster ↔ rest_pause** (boundary at intra-set rest length).
- **drop ↔ rest_pause** (boundary at load delta size).
- **contrast ↔ complex/single_load_chain** (load uniformity across components).
- **contrast ↔ complex/independent_load_chain/superset** (shared vs antagonist patterns).
- **emom ↔ complex/circuit** (multi-exercise vs strict timing).
- **emom ↔ tabata** (specific canonical structure).
- **complex/SLC ↔ complex/ILC** (load independence).
- **complex/circuit ↔ amrap** (single component case).
- **straight ↔ amrap/rep_capped** (RIR-driven prescription).
- **multi_exercise_pyramid ↔ fixed_round_circuit** (load progression magnitude; added in A.10).
- **antagonist_giant_set ↔ superset** (pairs_count collapse; added in A.10).

A reverse index (`target_method_index`) lists which rules suggest each target method. This is the foundation for v3 generator selection: "to choose method X, here are the patterns that lead to X being the right choice."

### 7.6 Contextual suggestions

When validation flags fire (especially structural_hard like wrong exercise count), the system doesn't just say "this is wrong." It inspects the block's parameters and generates a specific recommendation.

Example: a user declares straight with 2 exercises.
- Structural validation flags `straight_exercise_count_invalid`.
- Contextual suggestion engine inspects:
  - Are loads similar? → consider complex/superset.
  - Are loads divergent (one heavy, one explosive)? → consider contrast/heavy_light.
  - Same patterns? → consider single_load_chain.
  - Three or more would be → complex variants.

This pattern of contextual suggestion is **the foundation for the v3 generator**. v2 builds it as a side feature of validation; v3 turns it into the primary engine.

---

## 8. Hooks Reserved for v3 and Beyond

Throughout v2 we explicitly reserved hooks for future capabilities. These are not implemented but are formal anchors in the schema.

### 8.1 progression_logic per variant

Every variant declares `progression_logic: null`. This is the structural hook where progression rules will live in v3.

For each variant, progression_logic will specify:
- **Progression axis** — what increases week-to-week (load, reps, sets, density).
- **Progression rate** — how much per microcycle.
- **Deload triggers** — when to reset.
- **Mastery criteria** — when to graduate to a different variant.

In v2 the hook is null. v3 populates it.

### 8.2 The exercise catalog (Layer B)

`exercise_ref` appears throughout the schema as `string | null`. When Layer B (catalog) is built, exercises become first-class entities with:
- Biomechanical attributes (movement pattern, joints, muscles, chain).
- Loading metrics (percent_1rm, absolute_load, bodyweight_ratio, etc.).
- Progression graph (which exercises connect to which, with mechanism tags).
- Mechanical demand index (objective measure of the exercise's mechanical demand, not user-dependent).

Several validations depend on B:
- mechanical_drop's progression validation.
- contrast's pattern coherence checks.
- giant_set's muscle group coherence.
- complex/single_load_chain's load feasibility per component.

In v2 these validations either work with user-declared metadata (fragile) or are deferred. In v3 they become reliable.

### 8.3 Athlete profile

Reserved as a hook in v1.1; still hook in v2. The athlete profile holds:
- 1RM per exercise.
- Training history.
- Injuries and contraindications.
- Training age.
- Subjective feedback (perceived effort patterns).

When this exists, validation becomes personalized: "this prescription is unrealistic for this athlete" becomes a data-driven assertion, not a heuristic.

### 8.4 Autoregulation (Layer C)

Reserved hook. When implemented, RPE/velocity feedback during execution will:
- Adjust subsequent sets in the same session.
- Inform progression decisions across sessions.
- Trigger deload when accumulated fatigue is too high.

### 8.5 Periodization (Layer D)

The compositional layer. Sessions become elements of microcycles; microcycles of mesocycles; mesocycles of macrocycles. Each level introduces its own rules:
- Microcycle: weekly distribution of demands.
- Mesocycle: 3-8 week blocks with goal-specific structure.
- Macrocycle: annual planning, peaking, off-season.

In v2, sessions are independent. In Layer D, they become part of a longer arc.

### 8.6 The state machine for prescriptions

`prescribed | executed | partial` is the formal state at the block level. v3 will extend this to handle:
- Substitutions (athlete swaps exercise for available equipment).
- Modifications (athlete adjusts load due to readiness).
- Cancellations (session interrupted; how to handle pending blocks).

The state machine in v2 is binary at the work_unit level (`execution_status: executed | skipped | interrupted | pending`); v3 will likely add states for tracking modifications.

---

## 9. Glossary

**Block** — short for `exercise_block`. The structural unit containing a method, its variants, and a list of work_units.

**Canonical range** — the typical, "expected" range for a parameter. Outside this but within extended range produces drift flags.

**Cluster** — a mini-group of reps within a set, separated from other clusters by short intra-set rest.

**Component** — a sub-unit of a compound method (EMOM, contrast, complex). Implemented as a `work_unit` with method-specific extension.

**Contextual suggestion** — automatic generation of a specific alternative when a flag fires, based on inspection of the block's parameters.

**Continuous effort** — work performed without significant rest (>10s). The unit of zone classification under the refined principle.

**Detail pattern** — one of four base structures (`component_pattern`, `viability_pattern`, `drift_pattern`, `consistency_pattern`) that flag `detail` fields follow.

**Drift** — when a block satisfies the schema of its declared method but its parameters suggest the user's intent is better captured by another method.

**Drift bidirectional** — drift in both directions between two methods (A → B and B → A). Each direction declared separately.

**Drift unidirectional** — drift in one direction only (A → B exists; B → A doesn't).

**Energy system** — alactic, lactic, aerobic_power, mixed. Becomes structural in conditioning blocks.

**Epley inverse** — formula deriving theoretical maximum reps from a given %1RM. Foundation of viability checks.

**Executed** — block state indicating the block was performed. All work_units have actual data.

**Extended range** — the wider tolerance for a parameter. Outside this range produces structural_hard flags.

**Family** — for complex method only: single_load_chain, independent_load_chain, or circuit. Mandatory declared field.

**First continuous effort** — the first uninterrupted unit of work in a block. Used as the basis for zone classification.

**First segment** — for drop method: the first segment before any drop. Used as the basis for zone classification (exception to first_continuous_effort).

**Flag** — a structured indicator of an issue or observation. Has id, severity, level, message, detail, suggestion.

**Hard fail** — viability level indicating the prescription is physiologically unviable. Affects `overall_coherent`.

**Hook (fn:)** — reference in YAML to a function in code. Used when expression logic exceeds the declarative grammar.

**Informational** — flag severity for observations that don't block. Doesn't affect `overall_coherent`.

**Intent declared** — mandatory field declaring the user's intent for the block. Validated against intent_resolution candidates.

**Intent resolution** — set of rules in each method that match parameter patterns to intent categories. Used both for sugesting intent and for validating user declarations.

**Method** — one of the nine: straight, cluster, drop, rest_pause, amrap, pyramid, emom, contrast, complex.

**Mechanical demand index** — property of an exercise reflecting its mechanical demand. Lives in catalog (Layer B). Different from user's perceived effort.

**Method dispatcher** — function that routes validation to method-specific or family-specific handlers. The `validate_complex` is the primary example.

**Method params** — block field containing method-specific parameters (variant, family for complex, intent_declared, and method-specific fields).

**Mode** — for `dominant_component_distribution`: the most frequent zone across components.

**Pair index** — in antagonist_giant_set: integer declaring which antagonist pair a component belongs to. Each pair_index value must appear exactly twice (one agonist, one antagonist).

**Partial** — block state indicating some work_units were executed and others weren't.

**Perceived effort** — user's subjective measure of difficulty during execution. Lives at work_unit level (RIR/RPE in v1.1, may be enriched).

**Prescribed** — block state indicating the block is planned but not yet executed.

**Range canonical / range extended** — two-tier parameter ranges. Canonical is "typical"; extended is "acceptable."

**Role in pair** — in antagonist_giant_set: declares whether a component is the agonist or antagonist within its pair. Combined with pair_index, fully specifies the antagonist structure.

**Severity** — flag attribute: informational | structural_hard | viability.

**Strategy** — for zone classification: one of six (first_continuous_effort, first_segment, top_set, dominant_component_distribution, chain_complete, energy_system_dominant).

**Structural hard** — flag severity for schema violations. Blocks acceptance.

**Tie-breaker** — algorithm to resolve ties in zone classification: declared zone first, then lower zone index.

**Top set** — the peak-intensity set in a pyramid or ascending block. Used as the basis for zone classification.

**Variant** — sub-classification of a method (e.g., cluster has singles, doubles_triples, rest_pause_style).

**Viability** — flag severity for physiological concerns. Graduated by level (ok, warning_mild, warning_strong, hard_fail).

**Work unit** — atomic unit of work within a block. Unifies v1.1's set and the polymorphic component objects.

**Work-to-rest ratio** — work duration divided by rest duration. Key metric for circuit blocks.

**Zone (Z1-Z6)** — adaptation zones along the neural-to-metabolic continuum from v1.1.

---

## Document end

This document is intentionally human-readable. For implementation, use the machine-readable companions:
- `taxonomy_v2.yaml` + `taxonomy_v2_methods_part2.yaml` — the formal schema.
- `validator_functions_spec.md` — function-by-function specification.
- `flag_catalog.yaml` — all 117 flags.
- `drift_rules.yaml` — all 30 drift rules.

For coaching, training plan creation, or system understanding, this document is the entry point.

For changes or extensions, see A.10 and beyond in the design history.
