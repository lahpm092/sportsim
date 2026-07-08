---
name: taxonomy-v2
description: Working conventions and session protocol for Martin's Training Taxonomy v2 project — a formal YAML-based system for resistance/anaerobic training prescription, validation, autoregulation and periodization (layers A+B+C+D, design complete), foundation for an automatic routine generator (v3). Use this skill whenever the conversation involves the training taxonomy, its schemas or YAML files, the Prescriptor UI, the exercise catalog, training methods (cluster, drop set, EMOM, complex, etc.), periodization templates or mesocycles, autoregulation/RIR/deload rules, HYROX training programming, the taxonomy-v2 repo or PROJECT_STATE.md — even if the user just says "sigamos con el proyecto", "retomemos la taxonomía" or asks a small question about training program structure.
---

# Training Taxonomy v2 — Project Skill

Persistent conventions for working on Martin's training taxonomy project. The **source of truth is his Git repo** (`taxonomy-v2`), uploaded as a zip at session start — never conversational memory. This skill carries the HOW; the repo carries the WHAT; `PROJECT_STATE.md` inside the repo carries the live state and SUPERSEDES anything here when they conflict.

## 1. Session protocol (always)

**At session start, if project work is requested and no repo zip was uploaded: ask for it before substantive work.** The user zips with:
`cd ~/Documents/project && zip -r taxonomy-v2-session.zip taxonomy-v2 -x "taxonomy-v2/.git/*" -x "*.DS_Store"`

When the zip arrives, run the 4-step verification and report it:
1. Inventory: unzip, list files, no junk dirs / .DS_Store / empty folders.
2. Integrity: recompute SHA-256 of every file vs `MANIFEST.txt`; report identical/modified/missing/new explicitly. New files since last manifest are expected and named.
3. Parse: all YAMLs load; `flag_catalog.yaml` totals consistent (header == content == summary).
4. Live validators: `python3 tools/validate_catalog.py catalog/catalog_seed_part1.yaml catalog/catalog_seed_part2.yaml` and `python3 tools/validate_macro.py examples/macrocycle_hyrox_sample.yaml examples/template_examples.yaml` must PASS.

Only after green: "✓ sesión iniciada desde ground truth".

**At session close:** update `PROJECT_STATE.md` (state, decisions, pendings, next step), regenerate `MANIFEST.txt` (`find . -type f ! -name MANIFEST.txt ! -path "./.git/*" -exec sha256sum {} \; | sort -k2 > MANIFEST.txt`), package **project files only — never include `.git/`** (his local history rules), present the zip, and remind: download → `git add -A && git commit && git push`.

## 2. Repo map

```
flag_catalog.yaml      all flags, sections A-U (cross-layer)
methods/               Layer A: taxonomy_v2.yaml + part2 (9 methods, 40 variants), drift_rules.yaml
catalog/               Layer B: schema + seed (98 exercises, 2 parts)
autoregulation/        Layer C: schema + adjustment_rules (29 rules)
periodization/         Layer D: schema + 5 first-class models
docs/                  Human manuals per layer + validator_functions_spec.md (13 groups)
tools/                 Executable validators (catalog integrity, macro integrity)
examples/              Validated templates, sample HYROX macrocycle, HTML explorer
PROJECT_STATE.md       LIVE STATE — read it first, defer to it
```

## 3. Schema conventions (non-negotiable)

- snake_case ids, immutable once published; aliases for renames.
- Parameters declare `range_canonical` (typical) and `range_extended` (acceptable); outside extended → hard flag.
- Flag severities: `informational` / `structural_hard` / `viability` (levels ok→hard_fail). `overall_coherent=false` ⟺ any hard OR viability hard_fail. Flags are structured objects (id, severity, message_template, detail_schema ∈ {component, viability, drift, consistency}_pattern, suggestion_template).
- Declarative-first: behavior in YAML rules evaluated by the generic condition engine; code only via named `fn:*` hooks specified in validator_functions_spec.md.
- Declared immutability: `family`, `intent_declared`, zone are written, never inferred on read. Adjustments never rewrite: `prescribed_original → adjustments_applied → prescribed_effective → executed`.
- Authority Model C: every rule ships `suggest`; per-rule promotion to `auto` is a v3 hook. Deload always suggest.
- Asymmetry: reduce on 1 signal, increase on 2 consecutive; system brakes alone, never accelerates alone.
- Interference/model-drift rules: max `warning` for humans, but `v3_constraint: true` = hard constraint for the generator.
- Catalog: 2 levels (base + variation; pattern/implement change → new base), nodes `(exercise_id, variation_id|null)`, implicit ladders per `modifies` dimension, regressions/equivalence symmetry derived at load, ordinal anchor-calibrated indices (anchors immutable without version bump), hub-based strength ratios with confidence degradation; relative validation is the primary mode (templates).
- Periodization: templates 3 levels, composition by reference, fork-with-lineage (no inheritance), instances freeze template version, exercise placeholders = catalog queries with equivalence fallback; the event is the only immovable date.

## 4. Validation discipline (the practice that has saved this project)

- Every YAML edited gets parsed immediately after the edit; cross-file references re-verified (exercise refs vs catalog, variant refs vs taxonomy, rule→flag refs vs flag_catalog).
- Every counter (totals in headers/summaries) is recomputed programmatically, never by hand.
- Every new validator gets **fault-injection tested**: deliberately break inputs and confirm the designed error IDs fire. A validator that never fails is unverified.
- Beware duplicate top-level YAML keys (silent overwrite) — keep one section per key per file.

## 5. Working style (Martin)

- Step-by-step substeps (X.0, X.1…) with a formal "cierre definitivo" recap per substep, then numbered questions (typically 3) at the end; wait for answers before proceeding.
- He often answers "tu recomendación" — give a clear recommendation with reasoning, then proceed on it.
- Mark architectural vulnerabilities and future hooks explicitly as **MARCA** (v3 hooks, pending promotions, deferred decisions); they get recorded in PROJECT_STATE.
- Spanish for conversation; English for technical nomenclature in schemas/code. Concise technical confirmations; no padding.
- He is a HYROX competitor with exercise-science expertise: defer to his calibration on physiology (loads, ratios, thresholds); he defers to system-design judgment on architecture.

## 6. Current frontier

Design complete (A+B+C+D). Next: **Prescriptor v2** (block/session builder UI with live validation) — building without external skill repos (his decision), iterating on one codebase. Then v3 generator (all hooks planted: `progression_logic`, `week_structure_logic`, drift target index, template library as corpus). Check PROJECT_STATE.md §6-8 for pending minor items and the agreed next step.
