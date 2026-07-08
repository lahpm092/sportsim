# Validator Functions Specification — Training Taxonomy v2.0

**Companion document to:** `taxonomy_v2.yaml` + `taxonomy_v2_methods_part2.yaml`
**Status:** specification (no implementation; implementation is a separate phase)
**Last updated:** 2026-06-09

This document specifies every function the validator must implement to operate on the taxonomy v2 schema. Each function has a name, purpose, signature, behavior, and dependencies. Implementations are intentionally not provided — this is a contract, not code.

---

## Conventions

- **Naming:** `snake_case`. Functions starting with `validate_` are validators; with `classify_` are zone classifiers; with `compute_` or `estimate_` are calculators; with `build_` are constructors.
- **Signature notation:** `fn_name(arg_name: type) -> return_type`. Optional args are marked `arg_name: type | null = null`.
- **Side effects:** all functions are pure (no I/O, no mutation of inputs). They read the block and produce a result object.
- **Errors:** functions return result objects with `flags` lists. They never throw on bad input; bad input produces flags.
- **Hooks** (the seven `fn:*` from A.9.9.5) are documented in Group 10.

---

## Group 1 — Zone Classification Functions

The six strategies formalized in A.9.2. Each is invoked by the dispatcher based on the `zone_classification_rule.strategy` field of the method definition.

### `classify_first_continuous_effort`

**Purpose:** Classify zone using the first continuous unit of work in the block.

**Applies to:** straight, cluster, rest_pause, contrast (heavy component), amrap.

**Signature:**
```
classify_first_continuous_effort(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Call `identify_first_continuous_unit(block, method_def)` to get the primary unit.
2. Build a pseudo_set with `{reps, load, rir}` from the primary unit.
3. Call `classify_zone(pseudo_set)` (Group 2) to get the zone.
4. Return `ZoneClassificationResult` with `zone_inferred`, `strategy_applied = 'first_continuous_effort'`.

**Dependencies:** `identify_first_continuous_unit`, `classify_zone`.

**Notes:** For AMRAP in `state=prescribed`, the primary unit uses `epley_inverse(load_pct)` as `reps`. In `state=executed`, uses `reps_actual`.

---

### `classify_first_segment`

**Purpose:** Classify zone using the first segment of a drop set (before any drop). Exception to "continuous effort" principle.

**Applies to:** drop (all variants).

**Signature:**
```
classify_first_segment(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Build pseudo_set: `{reps: reps_first_segment, load: first_load_pct_1rm, rir: 0}`.
2. Call `classify_zone(pseudo_set)`.
3. If `rest_between_drops_sec <= 10`, additionally compute `zone_if_treated_as_continuous`:
   - Sum reps across all segments using `epley_inverse` per drop.
   - Weight load average.
   - Call `classify_zone` with these aggregate values.
4. Return result with `zone_inferred` from step 2 and `informative.zone_if_treated_as_continuous` from step 3 (or null if rest > 10s).

**Dependencies:** `classify_zone`, `epley_inverse`, `compute_drop_aggregate_reps_load`.

---

### `classify_top_set`

**Purpose:** Classify zone using the peak-intensity set in a block where multiple sets traverse different intensities.

**Applies to:** pyramid (ascending, descending, wave), emom/ascending_load.

**Signature:**
```
classify_top_set(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Call `identify_top_set(block, method_def)`:
   - For pyramid/ascending: last set generated.
   - For pyramid/descending: first set.
   - For pyramid/wave: last set of the last wave.
   - For emom/ascending_load: work_unit at final interval with final load.
2. Build pseudo_set from the top set.
3. Call `classify_zone(pseudo_set)`.
4. Return result with `zone_inferred` and `strategy_applied = 'top_set'`.

**Dependencies:** `identify_top_set`, `classify_zone`, `generate_pyramid_sets`.

---

### `classify_dominant_component_distribution`

**Purpose:** Classify zone using the most-frequent zone across components, with breakdown reporting.

**Applies to:** pyramid/double, emom/alternating, complex/independent_load_chain (all variants).

**Signature:**
```
classify_dominant_component_distribution(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Iterate over each component (or set, depending on method) in the block.
2. For each, build pseudo_set and call `classify_zone` (or `classify_zone_fallback_no_1rm` if no `load_pct_1rm`).
3. Collect `zones_per_component`.
4. Compute `zone_primary = mode(zones_per_component)`. Apply tie-breaker (lower zone index).
5. Compute `zones_breakdown` (map of zone → count).
6. Compute `zone_spread = len(unique(zones_per_component))`.
7. If `zone_spread >= 4`, flag `complex_zone_spread_excessive` (informational).
8. Return result with `zone_inferred = zone_primary` and informative metrics.

**Dependencies:** `classify_zone`, `classify_zone_fallback_no_1rm`, `apply_zone_tie_breaker`.

---

### `classify_chain_complete`

**Purpose:** Classify zone treating the chain as a single continuous effort.

**Applies to:** complex/single_load_chain (all variants).

**Signature:**
```
classify_chain_complete(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Compute `total_reps_per_round = sum(c.reps for c in components)`.
2. For variants `olympic_complex`, `strongman_complex`:
   - Build pseudo_set: `{reps: total_reps_per_round, load: shared_load_pct_1rm_of_weakest, rir: estimated_chain_rir}`.
   - Call `classify_zone(pseudo_set)`.
3. For variants `kb_flow`, `mace_flow`:
   - Build pseudo_set without load: `{reps: total_reps_per_round, rir: estimated_chain_rir}`.
   - Call `classify_zone_fallback_no_1rm(pseudo_set)`.
4. Return result with `zone_inferred` and `informative.total_reps_per_round`, `informative.total_reps_block`.

**Dependencies:** `classify_zone`, `classify_zone_fallback_no_1rm`, `estimate_chain_rir`.

---

### `classify_energy_system_dominant`

**Purpose:** No Z classification. Reports energy system dominance and metabolic metrics. Exception to the Z1-Z6 axis.

**Applies to:** complex/circuit (all variants).

**Signature:**
```
classify_energy_system_dominant(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Compute `total_work_sec = estimate_total_work_duration(block)` (Group 7).
2. Determine `dominant_energy_system`:
   - `total_work_sec < 30` → alactic
   - `< 180` → lactic
   - `< 600` → aerobic_power
   - else → mixed
3. Compute `zones_per_component` (informational only): classify each component independently. Components without `load_metric == percent_1rm` get null.
4. Compute `work_to_rest_ratio` via `compute_work_to_rest_ratio`.
5. Return result with `zone_inferred = null`, `strategy_applied = 'energy_system_dominant'`, and informative metrics.

**Dependencies:** `estimate_total_work_duration`, `classify_zone`, `compute_work_to_rest_ratio`.

---

## Group 2 — Layer 4 Algorithm

Core scoring and zone resolution. Functions of Capa 4 from v1.1 refined in A.9.

### `classify_zone`

**Purpose:** Score a pseudo_set against all six zones and return the best-fit zone, applying tie-breaker and threshold.

**Signature:**
```
classify_zone(pseudo_set: {reps, load_pct, rir}) -> ZoneInferenceResult
```

**Behavior:**
1. For each zone Z1..Z6: compute `score(Z) = 0.5 * match_reps + 0.3 * match_load + 0.2 * match_rir`.
2. Identify zone with maximum score.
3. If max score < 0.70: return `{zone: null, flag: no_coherent_zone, scores: {...}}`.
4. If tie (top two zones within 0.001 score): apply `apply_zone_tie_breaker`.
5. Return `{zone, scores, tie_broken_by: <reason>}`.

**Dependencies:** `match_range`, `apply_zone_tie_breaker`.

---

### `match_range`

**Purpose:** Compute match score for a value against a [min, max] range with linear decay.

**Signature:**
```
match_range(value: number, range: {min, max}) -> float in [0, 1]
```

**Behavior:**
- If `value in [min, max]`: return 1.0.
- Else: compute `distance = (value < min ? min - value : value - max)`.
- Return `max(0, 1 - distance / max(range_span, 2))`.

---

### `apply_zone_tie_breaker`

**Purpose:** Resolve ties when multiple zones have the same max score.

**Signature:**
```
apply_zone_tie_breaker(scores: {Z1, ..., Z6}, declared_zone: Zone | null) 
  -> {zone, tie_broken_by}
```

**Behavior:**
1. If `declared_zone` is one of the tied: return that zone, `tie_broken_by = 'declared_zone'`.
2. Else: pick the zone with the lower index (conservative neural bias). Return with `tie_broken_by = 'lower_zone_index'`.

---

### `classify_zone_fallback_no_1rm`

**Purpose:** Classify zone when `load_pct_1rm` is unavailable (bodyweight, absolute load without 1RM reference).

**Signature:**
```
classify_zone_fallback_no_1rm(pseudo_set: {reps, rir}) -> ZoneInferenceResult
```

**Behavior:**
1. For each zone: compute `score(Z) = (0.5/0.7) * match_reps + (0.2/0.7) * match_rir` (renormalized).
2. Apply same threshold (0.70) and tie-breaker logic as `classify_zone`.
3. Return result with flag `validation_route: fallback_no_1rm`.

**Dependencies:** `match_range`, `apply_zone_tie_breaker`.

---

### `compute_zone_score`

**Purpose:** Helper for one-off zone scoring (used by `classify_zone` and by drift detection).

**Signature:**
```
compute_zone_score(zone_def: ZoneDef, pseudo_set: {reps, load_pct, rir}) -> float
```

**Behavior:**
- Returns `0.5 * match_range(reps, zone_def.reps) + 0.3 * match_range(load_pct, zone_def.load_pct_1rm) + 0.2 * match_range(rir, zone_def.rir)`.

---

## Group 3 — Viability and Epley

Viability check from v1.1, now with graduated levels from A.9.3.

### `epley_inverse`

**Purpose:** Estimate maximum theoretical reps at a given %1RM using inverted Epley formula.

**Signature:**
```
epley_inverse(load_pct_1rm: number) -> integer
```

**Behavior:**
1. Consult the canonical Epley table (defined in YAML `epley_table`).
2. For values between table entries: linear interpolation.
3. Return rounded integer.

**Table (canonical):**
| %1RM | Reps max |
|---|---|
| 100 | 1 |
| 95 | 2 |
| 90 | 4 |
| 85 | 6 |
| 80 | 8 |
| 75 | 10 |
| 70 | 12 |
| 65 | 15 |
| 60 | 18 |
| 55 | 22 |
| 50 | 30 |

---

### `compute_viability`

**Purpose:** Compare prescribed reps against theoretical maximum and produce viability flag with graduated level.

**Signature:**
```
compute_viability(reps_target: integer, load_pct_1rm: number) -> ViabilityResult
```

**Behavior:**
1. `reps_max_teorico = epley_inverse(load_pct_1rm)`.
2. `delta = reps_target - reps_max_teorico`.
3. `delta_pct = (delta / reps_max_teorico) * 100`.
4. Determine `level`:
   - `delta <= 0 AND delta >= -4`: ok
   - `delta < -4`: warning_mild (flag `underloaded_for_rep_range`)
   - `0 < delta_pct <= 15`: warning_mild (flag `overprescribed_or_load_too_high`)
   - `15 < delta_pct <= 30`: warning_strong
   - `delta_pct > 30`: hard_fail
   - `abs(delta) <= 1`: also report informational `near_max_effort`
5. Return `{reps_max_teorico, delta, delta_pct, level, flags}`.

---

## Group 4 — Method-Aware Validation Dispatchers

The top-level entry points. Each method has its own dispatcher that calls common validations + method-specific validations.

### `validate_block`

**Purpose:** Top-level entry point. Dispatches to method-specific validator.

**Signature:**
```
validate_block(block: ExerciseBlock) -> ValidationResult
```

**Behavior:**
1. Read `block.method` and lookup `method_def` in taxonomy.
2. Validate state and method_params:
   - State is one of [prescribed, executed, partial].
   - `method_params.variant` exists in method_def.variants.
   - `method_params.intent_declared` is one of intent_resolution candidates or default.
   - For complex: `method_params.family` matches variant_def.family.
3. Call common validations (Group 6): `validate_work_unit`, `validate_exercise_count`, `validate_inputs_required_by_state`.
4. Dispatch to method-specific validator: `validate_<method>` (e.g., `validate_cluster`, `validate_complex`).
5. Call `detect_drift` (Group 5).
6. Call `compute_viability` for each work_unit (where applicable).
7. If `state == executed`: call `validate_prescribed_vs_executed` (Group 8).
8. Call `classify_zone_by_strategy` (resolves which Group 1 function to call).
9. Aggregate flags from all stages.
10. Compute `overall_coherent` per A.9.3 rule: false iff has structural_hard or viability.hard_fail.
11. Build and return `ValidationResult`.

**Dependencies:** all groups.

---

### `validate_straight`

**Purpose:** Method-specific validations for straight sets.

**Signature:**
```
validate_straight(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
- All validations handled by common functions; this method has no specific flags beyond exercise_count.
- Returns empty flag list (common functions handle everything).

---

### `validate_cluster`

**Purpose:** Method-specific validations for cluster sets.

**Signature:**
```
validate_cluster(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params against `range_canonical` (warning if outside) and `range_extended` (structural_hard if outside).
2. Validate total_reps consistency: `total_declared == reps_per_cluster * clusters_per_set * sets`.
3. Validate `reps_per_cluster <= zone_max_reps` for declared zone.
4. Validate intent ↔ load coherence: if intent=quality, flag if load < 75%.
5. Return flags list.

**Dependencies:** `validate_param_in_range`, `lookup_zone_max_reps`.

---

### `validate_drop`

**Purpose:** Method-specific validations for drop sets.

**Signature:**
```
validate_drop(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params against ranges.
2. For variant=mechanical_drop:
   - Validate `len(mechanical_progression) == drops_count + 1`.
   - Call hook `fn:check_drop_metric_inappropriate_for_component`.
3. Validate `drop_pct_per_drop in [10, 30]` (warning) or [15, 30] (canonical).
4. Validate `first_load_pct_1rm in [60, 85]`.
5. Validate `rest_between_drops_sec <= 15` (structural_hard if >15s).
6. Compute `total_reps_estimated` via `compute_drop_aggregate_reps_load`.

**Dependencies:** `validate_param_in_range`, `compute_drop_aggregate_reps_load`, `fn:check_drop_metric_inappropriate_for_component`.

---

### `validate_rest_pause`

**Purpose:** Method-specific validations for rest-pause.

**Signature:**
```
validate_rest_pause(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params.
2. Validate `activation_rir <= 2` (else flag `rp_activation_rir_above_threshold` structural_hard).
3. Validate `load_pct_1rm in [65, 88]`.
4. Validate `rest_intra_set_sec in [10, 20]` (else structural_hard).
5. Compute `max_realistic_mini_tandas = floor((100 - load_pct_1rm) / 7) - 1`. Flag if `mini_tandas_count_target > max_realistic + 1`.
6. Compute `total_reps_estimated` with 40% decay per mini-tanda.

**Dependencies:** standard helpers.

---

### `validate_amrap`

**Purpose:** Method-specific validations for AMRAP.

**Signature:**
```
validate_amrap(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params.
2. Validate `load_pct_1rm in [50, 90]`.
3. For variant=time_capped: require `time_cap_sec`.
4. For variant=rep_capped: require `rep_cap`.
5. If `state == executed`:
   - Compute `expected_reps = epley_inverse(load_pct)`.
   - `delta_actual = reps_actual - expected_reps`.
   - Flag `amrap_actual_below_expected` if `delta_actual < -4`.
   - Flag `amrap_actual_above_expected` if `delta_actual > +4`.

**Dependencies:** `epley_inverse`, standard helpers.

---

### `validate_pyramid`

**Purpose:** Method-specific validations for pyramid.

**Signature:**
```
validate_pyramid(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params.
2. Generate sets sequence via `generate_pyramid_sets` (Group 7).
3. Call hook `fn:check_pyramid_load_monotonic` (Group 10).
4. Validate monotonic inverse relation: as load increases, reps must decrease (and vice versa).
5. For variant=double: split into ascending and descending halves; validate each half.
6. For variant=wave: validate `sets_per_wave == 3` and each wave follows `wave_pattern`.
7. For variant=multi_exercise_pyramid (A.10):
   - Validate `exercises_per_round >= 2`.
   - Validate same exercises appear in every round (consistency).
   - Validate load progression across rounds is monotonic (flag `mep_load_not_monotonic_across_rounds`).
   - Validate reps progression inverse to load progression (flag `mep_reps_not_monotonic_inverse`).
   - Validate `total_reps_across_rounds <= 100` (flag `mep_total_volume_excessive`).
   - Validate `rounds_count >= 3` for meaningful pyramid (flag `mep_rounds_count_too_low`).
8. Validate total volume in [25, 50] reps (single-exercise variants).

**Dependencies:** `generate_pyramid_sets`, `fn:check_pyramid_load_monotonic`, `fn:check_multi_exercise_pyramid_consistency`.

---

### `validate_emom`

**Purpose:** Method-specific validations for EMOM.

**Signature:**
```
validate_emom(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params.
2. Compute `estimated_work_sec = estimate_work_duration(work_per_interval)` (Group 7).
3. Flag `emom_work_exceeds_interval` (viability hard_fail) if `estimated_work_sec > interval_sec * 0.85`.
4. Flag `emom_work_too_light_for_interval` if `estimated_work_sec < interval_sec * 0.2`.
5. Validate `interval_sec in [20, 240]`.
6. Validate `total_duration_min <= 30`.
7. For variant=alternating: validate `exercises_rotation` has 2-4 elements.
8. For variant=ascending_load: compute final load; flag if exceeds 95% or 1RM.
9. If single interval total: flag `emom_collapsed_to_amrap_timecapped` (informational).
10. Compute `work_to_rest_ratio`.

**Dependencies:** `estimate_work_duration`, `compute_work_to_rest_ratio`.

---

### `validate_contrast`

**Purpose:** Method-specific validations for contrast.

**Signature:**
```
validate_contrast(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate variant params.
2. Validate components count and roles match variant:
   - heavy_light: exactly 2, roles [heavy, explosive].
   - french_contrast: exactly 4, roles [heavy_strength, heavy_plyo, loaded_explosive, unloaded_plyo] in order.
   - complex_pairs: exactly 2, roles [primer, heavy].
3. For each heavy component: validate `load_pct_1rm in [80, 95]`.
4. For each explosive component: validate `load_pct_1rm <= 60` (if percent_1rm).
5. Validate `transition_rest_sec in [15, 90]` (canonical PAP window).
6. Validate that heavy and explosive components share movement_pattern (requires catalog; hook).

**Dependencies:** `fn:check_contrast_pattern_match` (future, requires catalog).

---

### `validate_complex` (Dispatcher)

**Purpose:** Top-level complex validator. Dispatches to family-specific validator.

**Signature:**
```
validate_complex(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Read `family = method_params.family`.
2. Validate `family` matches `variant_def.family` (else flag `complex_family_mismatch_with_variant`).
3. Call `validate_complex_common(block, method_def)`.
4. Dispatch based on family:
   - `single_load_chain` → `validate_single_load_chain`
   - `independent_load_chain` → `validate_independent_load_chain`
   - `circuit` → `validate_circuit`
5. Merge flags from common + family-specific.
6. Return combined flag list.

**Dependencies:** `validate_complex_common`, three family validators.

---

### `validate_complex_common`

**Purpose:** Validations common to all complex variants regardless of family.

**Signature:**
```
validate_complex_common(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate components count against variant `range_extended`.
2. Validate each component has `exercise_ref OR exercise_name`.
3. Compute `estimated_total = estimate_total_duration(block)` (Group 7).
4. Flag `complex_estimated_duration_excessive` if > 45 min.
5. Flag `complex_estimated_duration_too_short` if < 60 sec.

---

### `validate_single_load_chain`

**Purpose:** Family-specific validator for complex/single_load_chain.

**Signature:**
```
validate_single_load_chain(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate carga vs eslabón más débil (requires catalog; hook `fn:check_slc_load_appropriate_for_components`).
2. Call hook `fn:check_olympic_complex_technical_continuity` if variant=olympic_complex.
3. Validate `rest_between_components_sec <= 10` (structural_hard if exceeded).
4. Validate components don't have independent loads (flag `slc_components_have_independent_loads`).
5. Validate `technical_complexity_index` ordering: first component complexity ≥ avg(rest) - 1.5.

**Dependencies:** `fn:check_slc_load_appropriate_for_components`, `fn:check_olympic_complex_technical_continuity`.

---

### `validate_independent_load_chain`

**Purpose:** Family-specific validator for complex/independent_load_chain.

**Signature:**
```
validate_independent_load_chain(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. For variant=giant_set: call hook `fn:check_giant_set_muscle_group_coherence`.
2. For variant=peripheral_heart_action: call hook `fn:check_pha_strict_alternation`.
3. For variant=giant_set: validate monotonic non-increasing load progression (informational).
4. For variant=antagonist_giant_set (A.10):
   - Validate `len(components) == pairs_count * 2` (flag `ags_components_count_invalid`).
   - For each component: validate `pair_index in [0, pairs_count-1]` (flag `ags_pair_index_invalid`).
   - For each component: validate `role_in_pair` declared (flag `ags_role_in_pair_undeclared`).
   - Validate each `pair_index` appears exactly twice across components (flag `ags_pair_count_mismatch`).
   - For each pair: call hook `fn:check_pair_movement_patterns_antagonistic` (flag `ags_pair_not_antagonistic`, informational).
5. Validate `rest_between_components_sec in variant_canonical_range`.

**Dependencies:** `fn:check_giant_set_muscle_group_coherence`, `fn:check_pha_strict_alternation`, `fn:check_pair_movement_patterns_antagonistic`.

---

### `validate_circuit`

**Purpose:** Family-specific validator for complex/circuit.

**Signature:**
```
validate_circuit(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Validate each component has at least one work metric (reps, duration_sec, or distance_m).
2. For variant=fixed_round_circuit:
   - Compute `estimated_round_sec` and total duration; compare against `target_total_duration_min`.
   - Flag `circuit_duration_mismatch_target` if ratio < 0.7 or > 1.3.
3. For variant=time_capped_circuit:
   - Estimate rounds within time_cap; flag if < 3 (`tcc_rounds_too_few`).
4. For variant=chipper:
   - Call hook `fn:check_chipper_reps_monotonic_decreasing`.
   - Estimate duration; flag `chipper_estimated_duration_exhaustive` per A.8.8 thresholds (>30min warning_strong, >45min hard_fail).
5. For variant=tabata:
   - Validate fixed structure (8 rounds × 20s/10s).
   - Validate load + duration compatibility (flag `tabata_load_too_high_for_duration` if percent_1rm + load > 70).

**Dependencies:** `fn:check_chipper_reps_monotonic_decreasing`, `estimate_total_work_duration`.

---

## Group 5 — Drift Detection Engine

Generic engine that reads `drift_rules` from YAML and produces flags. From A.9.4.

### `detect_drift`

**Purpose:** Read declarative `drift_rules` from method_def and produce drift flags.

**Signature:**
```
detect_drift(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. For each rule in `method_def.drift_rules`:
   a. Evaluate all `conditions` via `evaluate_condition_expression`.
   b. If all true: construct flag via `build_drift_flag`.
2. If method_def has variants: also evaluate `variant_def.drift_rules`.
3. Return all drift flags.

**Dependencies:** `evaluate_condition_expression`, `build_drift_flag`.

---

### `evaluate_condition_expression`

**Purpose:** Parse and evaluate a string boolean expression against block state.

**Signature:**
```
evaluate_condition_expression(expression: string, block: ExerciseBlock) -> boolean
```

**Behavior:**
1. Parse expression per grammar from A.9.9.4:
   - Operators: `<, <=, >, >=, ==, !=, IN, NOT_IN`
   - Logical: `AND, OR, NOT`, parentheses
   - Auxiliary functions: `len(), mean(), mode(), sum(), count()`
   - Hooks: `fn:function_name` (invoke function by name)
2. Resolve field references via `resolve_dotted_path(block, path)`.
3. Evaluate to boolean.

**Dependencies:** `resolve_dotted_path`, all hooks.

**Notes:** This is the parser at the heart of the declarative system. Implementation must be robust to malformed expressions; on parse error, return false and log.

---

### `resolve_dotted_path`

**Purpose:** Resolve a dotted path (e.g., `components[0].load_pct_1rm`) into a value from the block.

**Signature:**
```
resolve_dotted_path(block: ExerciseBlock, path: string) -> any
```

**Behavior:**
- Split path by `.` and `[]`.
- Navigate through the block recursively.
- Return null if any segment is missing.

---

### `build_drift_flag`

**Purpose:** Construct a flag object from a drift rule that matched.

**Signature:**
```
build_drift_flag(rule: DriftRule, block: ExerciseBlock, method_def: MethodDefinition) 
  -> Flag
```

**Behavior:**
1. Generate flag id: `{method_def.id}_resembles_{rule.target_method}_{rule.target_variant or ''}`.
2. Populate `severity`, `message`, `suggestion` from rule.
3. Build `detail`:
   - `current_method`, `current_variant`
   - `suggested_method`, `suggested_variant`
   - `matching_indicators` (list of conditions that evaluated true)
4. Return Flag object.

---

## Group 6 — Work Unit Validation

### `validate_work_unit`

**Purpose:** Validate a single work_unit against its method's extension schema.

**Signature:**
```
validate_work_unit(unit: WorkUnit, method_def: MethodDefinition, variant_def: VariantDefinition) -> [flag]
```

**Behavior:**
1. Validate required fields per `variant_def.work_unit_required_fields`:
   - For each field: present and non-null.
   - For `one_of: [field_a, field_b]`: at least one present.
2. Validate `load_metric` ∈ allowed enum.
3. Validate extension fields per `variant_def.work_unit_extension`.
4. Apply renames for display (no validation impact).

**Dependencies:** standard validators.

---

### `validate_exercise_count`

**Purpose:** Validate the number of distinct exercises in the block against the method's rule.

**Signature:**
```
validate_exercise_count(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Determine effective rule:
   - If variant has `exercise_count_rule_override`: use it.
   - Elif variant is in `method_def.exercise_count_rule.exceptions`: use `exercise_count_rule_for_exception` from variant.
   - Else: use `method_def.exercise_count_rule`.
2. Count distinct exercises in block (either by `exercise_ref` or `exercise_name`).
3. If count < rule.min OR (rule.max != null AND count > rule.max):
   - Build flag `<method>_exercise_count_invalid` (structural_hard).
   - Generate `suggestion` automatically based on count and method (see Group 9).

**Dependencies:** standard helpers, `generate_contextual_suggestion`.

---

### `validate_inputs_required_by_state`

**Purpose:** Validate that the block has all required inputs for its current state.

**Signature:**
```
validate_inputs_required_by_state(block: ExerciseBlock, method_def: MethodDefinition) -> [flag]
```

**Behavior:**
1. Determine state: `block.state`.
2. Lookup `required = method_def.validation_route.inputs_required_by_state[state]`.
3. For each field in required: check present and non-null.
4. Build flag `method_required_input_missing` if any missing (structural_hard).

---

## Group 7 — Estimation Helpers

Helpers that compute duration, aggregate metrics, and derived values. Implementations are heuristic.

### `estimate_work_duration`

**Purpose:** Estimate the seconds a work_unit takes to execute.

**Signature:**
```
estimate_work_duration(unit: WorkUnit) -> integer (seconds)
```

**Behavior (heuristic):**
- If `duration_sec` provided: return it.
- If `distance_m` provided: estimate based on exercise type (assume sprint pace 4 m/s for running, 1.5 m/s for sled push).
- If `reps` provided:
  - Loaded with `percent_1rm`: ~3s per rep.
  - Bodyweight: ~2s per rep.
  - Ballistic / olympic: ~1.5s per rep.

**Dependencies:** none.

**Notes:** Heuristic is approximate. Override hook in v3 when catalog provides per-exercise typical_time_per_rep_sec.

---

### `estimate_total_work_duration`

**Purpose:** Aggregate work_duration across components or work_units of a block.

**Signature:**
```
estimate_total_work_duration(block: ExerciseBlock) -> integer (seconds)
```

**Behavior:**
- Sum `estimate_work_duration` per component/unit.
- Add rest periods according to method's `time_topology`.
- Multiply by rounds where applicable.

---

### `estimate_chipper_duration`

**Purpose:** Estimate duration of a chipper (single-pass sequence).

**Signature:**
```
estimate_chipper_duration(components: [WorkUnit]) -> integer (seconds)
```

**Behavior:**
- Sum `estimate_work_duration` for each component (one pass, no rounds).
- Add ~5s transition between components.
- Add additional time for fatigue-induced slowdown (heuristic: +20% if total work > 600s).

---

### `compute_work_to_rest_ratio`

**Purpose:** Compute the work-to-rest ratio for a block.

**Signature:**
```
compute_work_to_rest_ratio(block: ExerciseBlock) -> float
```

**Behavior:**
- `total_work_sec = estimate_total_work_duration(block)`.
- `total_rest_sec` = sum of all rest periods in the block (intra-set, inter-set, etc.).
- Return `total_work_sec / max(total_rest_sec, 1)`.

---

### `generate_pyramid_sets`

**Purpose:** Generate the sequence of sets for a pyramid block from declared params.

**Signature:**
```
generate_pyramid_sets(variant: PyramidVariant, params: dict) -> [Set]
```

**Behavior:**
- For ascending/descending: interpolate load from first_set to last_set per `load_progression`.
- For double: generate ascending half + descending half.
- For wave: generate `waves_count` waves, each with `wave_pattern` reps and increasing load per `wave_load_increment_pct`.
- Apply `load_progression` (linear, geometric, custom).

**Dependencies:** none.

---

### `compute_drop_aggregate_reps_load`

**Purpose:** Compute aggregate reps and average load across all segments of a drop set.

**Signature:**
```
compute_drop_aggregate_reps_load(block: ExerciseBlock) -> {total_reps, avg_load}
```

**Behavior:**
1. Start with `total_reps = reps_first_segment`, `current_load = first_load_pct_1rm`.
2. For each drop i in 1..drops_count:
   - `current_load = first_load * (1 - drop_pct/100)^i`.
   - `reps_at_this_load = epley_inverse(current_load)`.
   - `total_reps += reps_at_this_load`.
3. `avg_load = weighted_average(loads, reps_per_segment)`.
4. Return `{total_reps, avg_load}`.

---

## Group 8 — Retrospective Validation (prescribed vs executed)

### `validate_prescribed_vs_executed`

**Purpose:** Compare prescription against execution and flag discrepancies. Only runs when `state == executed`.

**Signature:**
```
validate_prescribed_vs_executed(block: ExerciseBlock) -> {flags, metrics}
```

**Behavior:**
1. If `block.state != executed`: return empty.
2. For each work_unit:
   - Compute `delta_reps = reps_actual - reps_target`.
   - If `delta_reps < -2`: flag `prescribed_vs_executed_undershoot` (severity based on magnitude).
   - If `delta_reps > +2`: flag `prescribed_vs_executed_overshoot` (informational; suggests 1RM underestimated).
3. Compute aggregate metrics:
   - `total_reps_executed`, `total_reps_target`.
   - `completion_rate_pct = total_reps_executed / total_reps_target * 100`.
   - `avg_reps_delta = mean(delta_reps per unit)`.
4. Return `{flags, metrics}`.

**Dependencies:** none.

---

### `compute_block_completion`

**Purpose:** For partial blocks, compute completion percentage based on `execution_status` of each work_unit.

**Signature:**
```
compute_block_completion(block: ExerciseBlock) -> {completion_rate_pct, units_executed, units_total}
```

**Behavior:**
1. `units_total = len(block.work_units)`.
2. `units_executed = count(unit.execution_status == 'executed' for unit in block.work_units)`.
3. `completion_rate_pct = units_executed / units_total * 100`.
4. Return result.

---

## Group 9 — Constructors and Suggestions

### `build_flag`

**Purpose:** Construct a flag object with id, severity, message, detail, suggestion.

**Signature:**
```
build_flag(
  id: string,
  severity: enum,
  level: enum | null,
  message: string,
  detail: object,
  suggestion: string | null,
  related_flags: [string] = []
) -> Flag
```

**Behavior:**
- Construct Flag object per A.9.3 schema.
- Validate severity is one of [informational, structural_hard, viability].
- Validate level is one of [ok, warning_mild, warning_strong, hard_fail] when severity == viability, else null.

---

### `build_validation_result`

**Purpose:** Assemble the final `ValidationResult` object from all sources.

**Signature:**
```
build_validation_result(
  block: ExerciseBlock,
  zone_classification: ZoneClassificationResult,
  viability_results: [ViabilityResult],
  flags_by_severity: {informational, structural_hard, viability},
  informative_metrics: dict
) -> ValidationResult
```

**Behavior:**
1. Aggregate flags by severity, with viability sub-grouped by level.
2. Compute `overall_coherent`:
   - false iff `structural_hard` is non-empty OR `viability.hard_fail` is non-empty.
3. Build `intent` block from `intent_declared` and `intent_resolution` inference.
4. Populate `zone_classification_auxiliary` from results.
5. Return assembled ValidationResult.

---

### `generate_contextual_suggestion`

**Purpose:** Generate an automatic suggestion when a flag fires, inspecting block context.

**Signature:**
```
generate_contextual_suggestion(flag_id: string, block: ExerciseBlock) -> string
```

**Behavior:**
- Apply contextual rules from A.9.7.5:
  - If declared exercises = 1 and method requires >= 2: suggest straight/cluster/drop based on loads.
  - If declared exercises = 2 and method requires 1: suggest contrast/heavy_light or complex/superset based on patterns.
  - If declared exercises >= 3 and method requires 1: suggest complex/single_load_chain, /independent_load_chain, or /circuit based on cargas y conditioning indicators.
- Use information from intent_resolution and drift_rules of candidate methods to refine.

**Notes:** This is a **key function for v3**. The generator uses similar contextual inspection to choose methods automatically. Implementing this well in v2 lays groundwork for v3.

---

### `classify_zone_by_strategy`

**Purpose:** Dispatcher that routes to the correct zone classification function based on method's strategy.

**Signature:**
```
classify_zone_by_strategy(block: ExerciseBlock, method_def: MethodDefinition) 
  -> ZoneClassificationResult
```

**Behavior:**
1. Resolve effective strategy:
   - Check `variant_def.zone_classification_rule.strategy_override` first.
   - Else `method_def.zone_classification_rule.strategy_override_for_variant[variant]`.
   - Else `method_def.zone_classification_rule.strategy_override_for_family[family]` (complex only).
   - Else `method_def.zone_classification_rule.strategy`.
2. Dispatch to corresponding function from Group 1.

---

## Group 10 — Code Hooks (fn:*)

The seven hooks identified in A.9.9.5. These exist because their logic is not cleanly expressible in the declarative YAML condition grammar.

### `fn:check_olympic_complex_technical_continuity`

**Purpose:** Detect "technical valleys" in olympic_complex chains (high-complexity exercises bracketing low-complexity ones).

**Signature:**
```
fn:check_olympic_complex_technical_continuity(block: ExerciseBlock) -> boolean
```

**Behavior:**
1. Get `technical_complexity_index` for each component.
2. Compute `range_max - range_min`.
3. If range >= 4: return true (flag would fire).
4. Else: return false.

**Used in:** drift detection or `validate_single_load_chain`.

---

### `fn:check_chipper_reps_monotonic_decreasing`

**Purpose:** Verify chipper's reps_per_component is monotonically non-increasing.

**Signature:**
```
fn:check_chipper_reps_monotonic_decreasing(block: ExerciseBlock) -> boolean
```

**Behavior:**
- Returns true if reps_list is NOT monotonically non-increasing (flag would fire).

---

### `fn:check_pyramid_load_monotonic`

**Purpose:** Verify pyramid's load progression follows variant rules.

**Signature:**
```
fn:check_pyramid_load_monotonic(block: ExerciseBlock) -> boolean
```

**Behavior:**
- ascending: returns true if load is NOT strictly increasing.
- descending: returns true if load is NOT strictly decreasing.
- double: returns true if either half is NOT monotonic.
- wave: returns true if any wave does NOT follow `wave_pattern`.

---

### `fn:check_pha_strict_alternation`

**Purpose:** Verify PHA's body_segment alternation matches declared pattern.

**Signature:**
```
fn:check_pha_strict_alternation(block: ExerciseBlock) -> boolean
```

**Behavior:**
- For `alternation_pattern: strict_upper_lower`: check segments alternate [upper, lower, upper, lower, ...].
- For other patterns: check accordingly.
- Returns true if pattern is violated (flag would fire).

**Detail produced:** index of first violating component.

---

### `fn:check_giant_set_muscle_group_coherence`

**Purpose:** Verify giant_set components target same muscle group.

**Signature:**
```
fn:check_giant_set_muscle_group_coherence(block: ExerciseBlock) -> boolean
```

**Behavior:**
- Get `movement_pattern` for each component.
- Compute unique patterns count.
- If unique > 2 (allowing some variation): return true (flag would fire).
- Compare against `target_muscle_group`; if patterns inconsistent with target, return true.

**Notes:** Reliable detection requires catalog. Until catalog exists, returns conservative result.

---

### `fn:check_slc_load_appropriate_for_components`

**Purpose:** Verify single_load_chain's shared load is feasible for all components.

**Signature:**
```
fn:check_slc_load_appropriate_for_components(block: ExerciseBlock) -> boolean
```

**Behavior:**
- For each component: check that the shared load makes physiological sense.
  - If component is `bodyweight_ratio` and shared_load is `percent_1rm`: incompatible (flag).
  - If component is plyometric and shared_load > 30%: usually incompatible.
  - If shared_load > 1RM of weakest link: flag.
- Returns true if any incompatibility found.

**Notes:** Reliable detection requires catalog.

---

### `fn:check_drop_metric_inappropriate_for_component`

**Purpose:** Verify drop's load metric matches component types (for mechanical_drop, especially).

**Signature:**
```
fn:check_drop_metric_inappropriate_for_component(block: ExerciseBlock) -> boolean
```

**Behavior:**
- If variant=mechanical_drop with `load_metric_primary: bodyweight_ratio` and components have `percent_1rm`: incompatible.
- Returns true if incompatible.

---

### `fn:check_multi_exercise_pyramid_consistency` (A.10)

**Purpose:** Verify multi_exercise_pyramid's same exercises appear in every round and that load/reps progression is coherent across rounds.

**Signature:**
```
fn:check_multi_exercise_pyramid_consistency(block: ExerciseBlock) -> boolean
```

**Behavior:**
1. Group work_units by `round_index` and `exercise_index_in_round`.
2. Verify that the same set of exercise references appears in every round.
3. Verify load progression across rounds is monotonic (either strictly increasing or decreasing).
4. Verify reps progression is inverse to load progression.
5. Returns true if any inconsistency is detected (flag would fire).

**Used in:** `validate_pyramid` for variant=multi_exercise_pyramid.

---

### `fn:check_pair_movement_patterns_antagonistic` (A.10)

**Purpose:** Verify that the two components within a pair (in antagonist_giant_set) have antagonistic movement patterns.

**Signature:**
```
fn:check_pair_movement_patterns_antagonistic(block: ExerciseBlock, pair_index: integer) -> boolean
```

**Behavior:**
1. Get both components with the given `pair_index`.
2. Compare `movement_pattern`:
   - push_h ↔ pull_h: antagonist ✓
   - push_v ↔ pull_v: antagonist ✓
   - squat ↔ hinge: antagonist ✓ (for posterior/anterior chain pairs)
   - same pattern: not antagonist (returns true = flag fires)
3. Returns true if patterns are NOT antagonistic.

**Notes:** Reliable detection requires catalog (Layer B) with formal movement_pattern enum. Until then, uses string comparison and a hardcoded antagonist table.

**Used in:** `validate_independent_load_chain` for variant=antagonist_giant_set.

---

## Group 11 — Catalog Functions (Layer B)

Added in B.7. These operate on the exercise catalog: resolution, ratio composition, graph navigation, and load-time integrity. Reference implementation of integrity checks exists in `validate_catalog.py` (verified by fault injection in B.6).

### `resolve_node`
**Purpose:** Resolve `(exercise_ref, variation_ref | null)` to a catalog node.
**Signature:** `resolve_node(exercise_ref, variation_ref) -> node | null`
**Behavior:** Lookup exercise by id or alias; if variation_ref given, locate within `variations`. Null on miss (callers degrade gracefully to v2 heuristics + informational flag).

### `demand`
**Purpose:** Effective mechanical demand of a node.
**Signature:** `demand(node) -> number`
**Behavior:** `base.mechanical_demand_index + (variation.mechanical_demand_delta ?? 0)`.

### `compose_ratio`
**Purpose:** Composed strength ratio between any two exercises via hub model (B.4).
**Signature:** `compose_ratio(exercise_a, exercise_b) -> {value, confidence, path}`
**Behavior:** ratio(A→hub_A) × inter_hub(hub_A→hub_B) × ratio(hub_B→B). Confidence = min(chain) degraded one level per inter-hub jump; 2+ jumps → low. Emits `ratio_composition_possibly_imprecise` (informational) when a 2+-jump ratio is consumed.

### `identify_weakest_link`
**Purpose:** Find structurally weakest component in a chain (SLC validation).
**Signature:** `identify_weakest_link(components) -> {weakest, confidence}`
**Behavior:** Express each component in global-hub units (back_squat equivalents) via `compose_ratio`; min wins. Confidence = min of all.

### `validate_slc_load`
**Purpose:** Relative weakest-link validation for single_load_chain (B.4.4).
**Signature:** `validate_slc_load(block, catalog) -> [flag]`
**Behavior:** If confidence == low → `slc_weakest_link_low_confidence` (informational), stop. Else compare declared anchor vs computed weakest → `slc_weakest_link_misidentified` (viability/warning_strong) on mismatch. PRIMARY mode for templates/program starts (no athlete data); absolute mode activates with future athlete profile.

### `implicit_ladder`
**Purpose:** Ordered intra-base ladder for a modifies-dimension (B.0.8).
**Signature:** `implicit_ladder(base, dimension) -> [node]`
**Behavior:** Filter variations sharing `dimension` in `modifies`; include base; sort by effective demand. Orthogonal dimensions never auto-connect.

### `validate_mechanical_progression`
**Purpose:** Validate mechanical_drop progression against the graph (B.2.5). Replaces v2 heuristic when catalog covers the steps.
**Signature:** `validate_mechanical_progression(block, catalog) -> [flag]`
**Behavior:** Resolve each step (miss → `mechanical_drop_step_not_in_catalog`, fallback to heuristic). Each transition valid via (a) implicit ladder descent same-base/same-dimension, or (b) explicit regression edge with matching mechanism → else `mechanical_drop_progression_invalid_path` (hard). Global demand monotonically decreasing → else `mechanical_drop_demand_not_decreasing` (hard).

### `derive_regressions`
**Purpose:** Generate inverse edges at load time (regressions never declared).
**Signature:** `derive_regressions(catalog) -> catalog`

### `derive_equivalence_symmetry`
**Purpose:** Materialize both directions of declared equivalences; detect contradictory double declarations → `catalog_equivalence_asymmetry_conflict`.
**Signature:** `derive_equivalence_symmetry(catalog) -> catalog`

### `validate_catalog_integrity`
**Purpose:** Load-time integrity: P1 (edge demand monotonic), P2 (DAG), P3 (targets resolvable), R1 (ranges), R2 (effective demand bounds), R3 (anchor immutability vs version). All violations are blocking catalog_errors — catalog does not load.
**Signature:** `validate_catalog_integrity(catalog) -> [catalog_error]`
**Reference implementation:** `validate_catalog.py`.

---

## Group 12 — Autoregulation Functions (Layer C)

Added in C.7. Signal computation, volume accounting, fatigue derivation, and the adjustment lifecycle.

### `compute_derived_signals`
**Signature:** `compute_derived_signals(work_unit | session) -> [derived_signal]`
**Behavior:** rir_delta, completion_ratio, load_compliance, velocity_loss_pct per work_unit; readiness_score/delta per day; session_rpe_load per conditioning block.

### `e1rm_estimate`
**Signature:** `e1rm_estimate(load, reps, rir_reported) -> {value, confidence}`
**Behavior:** Epley extended with RIR: `load × (1 + (reps + rir) / 30)`. Confidence degrades when reps > 10 or rir > 4. Reuses v1.1 Epley machinery.

### `e1rm_trend`
**Signature:** `e1rm_trend(exercise, window=3..5 sessions) -> pct_per_session`
**Behavior:** simple regression over recent e1rm_estimates of same exercise.

### `effective_sets`
**Signature:** `effective_sets(block) -> map<muscle_group, float>`
**Behavior:** method-aware set counting (C.3.2 table) × fractional contribution (primary 1.0 / secondary 0.5 / override) × effective-set threshold (rir ≤ 4, reported ?? target). Conditioning blocks return {} here.

### `muscle_volume_rolling`
**Signature:** `muscle_volume_rolling(group, window=7d) -> {sets, status}`
**Behavior:** accumulate effective_sets over rolling window; classify vs landmarks → below_mev | productive | high | exceeded.

### `conditioning_load_rolling`
**Signature:** `conditioning_load_rolling() -> {acute_7d, chronic_28d, acwr}`
**Behavior:** Foster session_rpe_load accumulation; ACWR = acute/chronic.

### `derive_fatigue_state`
**Signature:** `derive_fatigue_state(athlete_history) -> {state, evidence}`
**Behavior:** declarative any_2_of/all_of conditions (schema Section 6); returns the fired conditions as evidence. Interpretable by design.

### `evaluate_adjustment_rules`
**Signature:** `evaluate_adjustment_rules(horizon, context) -> [adjustment]`
**Behavior:** generic condition engine (Group 5) over the horizon's rule set with the C signal vocabulary; applies cooldowns, conflict resolution (higher severity wins, loser logged suppressed), and the session budget (3, then session_adjustment_budget_exceeded).

### `apply_adjustment`
**Signature:** `apply_adjustment(adjustment, target) -> updated_target`
**Behavior:** provenance-preserving: writes prescribed_effective from prescribed_original + adjustment; never mutates original; appends to adjustments_applied.

### `evaluate_deload_effectiveness`
**Signature:** `evaluate_deload_effectiveness(deload_proposal) -> effective | partial | ineffective`
**Behavior:** at deload_end + 7d compares readiness_acute, e1rm_estimates, fatigue_state transition vs pre-deload. Historical record for v3 personalization.

### `readiness_baseline_and_zone`
**Signature:** `readiness_baseline_and_zone(athlete_day) -> {baseline_14d, acute_3d, delta, zone}`
**Behavior:** rolling baselines; zone per C.6 thresholds with severe-single-item override; first 7 days accumulate without modulating.

---

## Group 13 — Periodization Functions (Layer D)

Added in D.6. Template materialization, structural validation per level, and C↔D integration.

### `materialize_template`
**Signature:** `materialize_template(mesocycle_template, start_date, athlete_context?) -> mesocycle_instance`
**Behavior:** 5-step pipeline: BIND dates → RESOLVE placeholders → SCALE volumes (landmark_relative + C.3 status when profile exists) → VALIDATE (template-time + materialization-time) → EMIT instance with prescribed session shells.

### `resolve_exercise_placeholder`
**Signature:** `resolve_exercise_placeholder(query, available_equipment?) -> {exercise_ref, via} | error`
**Behavior:** catalog query over enums/indices; preferred match by demand fit; fallback via equivalence edges (distance 1). Misses → template_placeholder_unresolvable (hard). Medium-similarity resolution → informational flag.

### `validate_microcycle`
**Signature:** `validate_microcycle(microcycle_template) -> [flag]`
**Behavior:** structural (slot refs, day validity, days_span 5-10), frequency_targets vs slots' primary_patterns, conditioning_budget, then evaluate_interference_rules.

### `evaluate_interference_rules`
**Signature:** `evaluate_interference_rules(microcycle) -> [flag]`
**Behavior:** declarative rules over slot attributes per scope (same_day | adjacent_day | microcycle). Max severity warning; only logical impossibility (microcycle_day_conflict) is hard. Rules carry v3_constraint: true — generator must satisfy them.

### `validate_mesocycle`
**Signature:** `validate_mesocycle(mesocycle_template, level?) -> [flag]`
**Behavior:** week continuity, micro refs, duration ranges, deload-overdue per effective threshold = min(level 4-7 inverse, model override), modifier conflicts, test weeks contain AMRAP, then validate_progression_vs_model.

### `validate_progression_vs_model`
**Signature:** `validate_progression_vs_model(progression_scheme, model) -> [flag]`
**Behavior:** model validation_rules over the structured ramp (monotonicity, relations, variant expectations) + model drift rules → mesocycle_progression_incoherent_with_model / periodization_model_drift.

### `validate_macrocycle`
**Signature:** `validate_macrocycle(macrocycle) -> [flag]`
**Behavior:** phase continuity (gaps warning, overlaps hard), event A taper presence, taper duration vs priority defaults, block realization adjacency to event A, A-events spacing (≥6 weeks).

### `derive_taper_state`
**Signature:** `derive_taper_state(date, macrocycle) -> {taper_declared, taper_ref}`
**Behavior:** inside active taper window → taper_declared true. Consumers: C.4 detraining suppression, fatigue interpretation, taper_not_producing_freshness monitor.

### `resolve_deload_interaction`
**Signature:** `resolve_deload_interaction(deload_proposal, mesocycle_instance) -> resolution`
**Behavior:** three scenarios (D.5.1): planned ≤10 days ahead → advance; within 21d suppression + overreached → planned_deload_insufficient flag; standalone → insert ad-hoc week. All suggest.

### `shift_or_absorb_weeks`
**Signature:** `shift_or_absorb_weeks(mesocycle_instance, inserted_week) -> updated_instance`
**Behavior:** default shift (+1 week duration); collision with A/B event → absorb the lightest standard week. Taper and event never move. Flags trail.

### `modulate_materialization_by_fatigue`
**Signature:** `modulate_materialization_by_fatigue(next_week, fatigue_state) -> week_plan`
**Behavior:** fresh/normal → per plan; accumulating → suggest HOLD (repeat previous week's modifiers, progression paused not lost); overreached → route to deload (D.5.1).

---

## Summary

**Total functions specified: 87**

Group | Count | Purpose
---|---|---
1. Zone classification | 6 | Strategy implementations
2. Layer 4 algorithm | 5 | Core scoring + ties + threshold
3. Viability + Epley | 2 | Physiological sanity
4. Method dispatchers | 12 | One per method + complex sub-dispatchers
5. Drift detection | 4 | Engine reads YAML rules
6. Work unit validation | 3 | Common validations
7. Estimation helpers | 6 | Heuristic durations and aggregates
8. Retrospective | 2 | prescribed vs executed
9. Constructors | 4 | Build flags and results
10. Code hooks | 9 | Logic not expressible in YAML (7 + 2 from A.10)
11. Catalog functions | 10 | Layer B: resolution, ratios, graph, load-time integrity
12. Autoregulation | 11 | Layer C: signals, volume, fatigue, adjustment lifecycle
13. Periodization | 11 | Layer D: materialization, level validation, C-D integration

---

## Implementation notes

**Priority for implementation:**

1. **Group 2** (Layer 4 algorithm) and **Group 3** (viability + Epley) are the most foundational. Implement first.
2. **Group 1** (zone classifiers) and **Group 6** (work unit validation) can be parallelized after Group 2.
3. **Group 5** (drift engine) requires a robust expression parser. Implement carefully; this is the heart of declarative validation.
4. **Group 4** (method dispatchers) is mechanical once Groups 1-3 are done.
5. **Group 10** (hooks) can be implemented incrementally as method support is added.
6. **Group 9** (constructors and suggestions) is "glue"; integrate after others are stable.

**Testing strategy:**

- Each function in Groups 1-3 has direct unit tests with known inputs.
- Group 4 dispatchers tested with full block fixtures per method.
- Group 5 drift engine tested by feeding YAML rules and verifying flag outputs.
- Group 10 hooks tested per-hook with specific edge cases (from A.8.8 cases).

**Marca para A.9.10.c y .d:**

The full flag catalog (A.9.10.c) and drift rules catalog (A.9.10.d) provide the data inputs to these functions. They must be in sync.
