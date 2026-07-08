#!/usr/bin/env python3
"""
test_compiler.py — fault-injection PERMANENTE del compilador de reglas (P3.1.5).

No basta con que el compilador funcione: cada guard de integridad debe DISPARAR
ante su falla. "Un validador que nunca falla está sin verificar" — esto lo evita
para el propio compilador. Cubre E1/E2/E3/TIER + traducción + round-trip positivo.

Corre standalone (`python3 tools/test_compiler.py`) y encadenado en el build.
Exit 0 = todo verde; exit 1 = alguna falla.
"""
import sys, os, shutil, tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rule_compiler as rc

ROOT = Path(__file__).resolve().parent.parent
PASS, FAIL = 0, 0


def ok(label, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ {label}")


def _temp_root_with(rule_yaml: str) -> Path:
    """Crea un root temporal con flag_catalog real + un prescriptor_rules.yaml dado."""
    d = Path(tempfile.mkdtemp(prefix="compiler_fi_"))
    (d / "rules").mkdir()
    (d / "rules" / "prescriptor_rules.yaml").write_text(rule_yaml)
    shutil.copy(ROOT / "flag_catalog.yaml", d / "flag_catalog.yaml")
    return d


def expect_builderror(label, rule_yaml, needle=None):
    d = _temp_root_with(rule_yaml)
    try:
        rc.compile_rules(d)
        ok(label + " (debía abortar)", False)
    except rc.BuildError as e:
        ok(label, needle is None or needle in str(e))
    except Exception as e:  # noqa
        ok(label + f" (BuildError, no {type(e).__name__})", False)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def expect_ok(label, rule_yaml):
    d = _temp_root_with(rule_yaml)
    try:
        rc.compile_rules(d)
        ok(label, True)
    except Exception as e:  # noqa
        ok(label + f" (no debía abortar: {e})", False)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- E1: regla sin `emits` ---
expect_builderror("E1 regla sin emits",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['rest_between_drops_sec > 1']\n",
    "E1")

# --- E2: emits a flag inexistente ---
expect_builderror("E2 flag fantasma",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['x > 1']\n    emits: flag_que_no_existe_xyz\n",
    "E2")

# --- E3: emits a flag fuera de scope (microcycle_plus) ---
import yaml
_flags = yaml.safe_load((ROOT / "flag_catalog.yaml").read_text())["flags"]
_mp = next(k for k, v in _flags.items() if v.get("applies_at") == "microcycle_plus")
expect_builderror("E3 flag fuera de scope",
    f"version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {{method: drop}}\n    when: ['x > 1']\n    emits: {_mp}\n",
    "E3")

# --- TIER: array selector y fn:* en regla T1 ---
expect_builderror("TIER array selector",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['components[0].load > 1']\n    emits: drop_rest_too_long\n",
    "TIER")
expect_builderror("TIER fn:* hook",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['fn:check(b)']\n    emits: drop_rest_too_long\n",
    "TIER")

# --- tier inválido / función no permitida / scope sin method / id duplicado ---
expect_builderror("tier inválido",
    "version: '1'\nrules:\n  - id: r\n    tier: T9\n    scope: {method: drop}\n    when: ['x > 1']\n    emits: drop_rest_too_long\n")
expect_builderror("función no whitelisteada",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['sqrt(x) > 1']\n    emits: drop_rest_too_long\n")
expect_builderror("scope sin method",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {}\n    when: ['x > 1']\n    emits: drop_rest_too_long\n")
expect_builderror("id duplicado",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['x>1']\n    emits: drop_rest_too_long\n  - id: r\n    tier: T1\n    scope: {method: drop}\n    when: ['x>1']\n    emits: drop_rest_too_long\n")

# --- positivos: construcciones que SÍ deben compilar ---
expect_ok("ok aritmética + floor + binding",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: emom, variant: ascending_load}\n    bindings: {v: 'starting_load_pct_1rm + load_increment_pct * floor(total_duration_min / 2)'}\n    when: ['v > 100']\n    emits: emom_ascending_exceeds_1rm\n")
expect_ok("ok variant_in + null literal",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: pyramid, variant_in: [ascending, descending]}\n    when: ['first_set_load_pct_1rm != null']\n    emits: pyramid_inverse_relation_violated\n")
expect_ok("ok component_role selector (Q2)",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: contrast}\n    bindings: {h: \"component_role('heavy').load_pct_1rm\"}\n    when: ['h != null', 'h > 95']\n    emits: contrast_heavy_load_too_high\n")
expect_ok("ok accesor de schema",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: complex}\n    when: ['total_rounds > canonical_max(total_rounds)']\n    emits: complex_rounds_count_excessive\n")

# --- P3.2: helpers de estimación T2 (aggregate_volume) ---
expect_ok("ok helper aggregate_volume (T2)",
    "version: '1'\nrules:\n  - id: r\n    tier: T2\n    scope: {method: pyramid, variant_in: [ascending, descending]}\n    bindings: {total_reps: 'aggregate_volume(first_set_reps, last_set_reps, sets_count)'}\n    when: ['total_reps > 50']\n    emits: pyramid_total_volume_too_high\n")
# helper inexistente debe ser rechazado por la whitelist (no es array/fn: → no TIER, sí función)
expect_builderror("helper no whitelisteado rechazado",
    "version: '1'\nrules:\n  - id: r\n    tier: T2\n    scope: {method: pyramid, variant: ascending}\n    bindings: {v: 'estimate_chipper_duration(first_set_reps)'}\n    when: ['v > 1']\n    emits: pyramid_total_volume_too_high\n")

# --- P3.3: helpers de zona/viabilidad T3 (epley_inverse, viability_level, zone_max_reps, zone_id) ---
expect_ok("ok helper epley_inverse + viability_level (T3)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: straight, variant: default}\n    bindings: {rmax: 'epley_inverse(load_pct_1rm)', vl: 'viability_level(reps_target, load_pct_1rm)'}\n    when: ['rmax != null', 'vl >= 1']\n    emits: overprescribed_or_load_too_high\n")
expect_ok("ok helper zone_max_reps + zone_id (T3)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: cluster}\n    bindings: {zr: 'zone_max_reps(load_pct_1rm, reps_per_cluster, 2)', zi: 'zone_id(load_pct_1rm, reps_per_cluster, 2)'}\n    when: ['zr != null', 'reps_per_cluster > zr']\n    emits: cluster_size_exceeds_zone_reps\n")
# helper de zona NO whitelisteado debe ser rechazado
expect_builderror("helper de zona no whitelisteado rechazado",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: straight, variant: default}\n    bindings: {v: 'classify_top_set(load_pct_1rm)'}\n    when: ['v > 1']\n    emits: overprescribed_or_load_too_high\n")

# --- round-trip positivo sobre la fuente REAL ---
res = rc.compile_rules(ROOT)
ok("round-trip real: 95 reglas (V3.6 completo: slc+superset+fc+misclassified)", res["rules"] == 95)
ok("round-trip real: 0 T4/T5 reservadas", res["reserved"] == 0)
ok("round-trip real: digest no vacío", bool(res["digest"]))
js = res["js"]
ok("JS contiene el selector component_role compilado", ".find(c=>c.role===" in js)
ok("JS contiene binding final_load_pct", "final_load_pct" in js)
ok("JS contiene accesor de schema (params_schema)", "params_schema" in js)
# P3.2: helper inyectado y referenciado
ok("helpers_js define aggregate_volume", "aggregate_volume" in res["helpers_js"])
ok("JS de reglas referencia __H.aggregate_volume", "__H.aggregate_volume" in js)
# P3.3: helpers de zona/viabilidad inyectados y referenciados
ok("helpers_js define epley_inverse", "epley_inverse" in res["helpers_js"])
ok("helpers_js define viability_level", "viability_level" in res["helpers_js"])
ok("helpers_js define classify_zone", "classify_zone" in res["helpers_js"])
ok("JS de reglas referencia __H.viability_level", "__H.viability_level" in js)
ok("JS de reglas referencia __H.zone_max_reps", "__H.zone_max_reps" in js)
# P5.5b — PHA alternation: block-helper inyectado y referenciado por la regla compilada
ok("helpers_js define _pha_scan", "_pha_scan" in res["helpers_js"])
ok("JS de reglas referencia __H.pha_first_alternation_break", "__H.pha_first_alternation_break" in js)
# P5.5c/P5.6/P5.7 — zone scorer + contrast/SLC helpers inyectados y referenciados
ok("helpers_js define zone_score", "zone_score" in res["helpers_js"])
ok("JS de reglas referencia __H.zone_spread", "__H.zone_spread" in js)
ok("JS de reglas referencia __H.fc_roles_wrong", "__H.fc_roles_wrong" in js)
ok("JS de reglas referencia __H.slc_first_tci", "__H.slc_first_tci" in js)
ok("JS de reglas referencia __H.variant_family", "__H.variant_family" in js)
ok("JS de reglas referencia __H.mep_rounds_inconsistent", "__H.mep_rounds_inconsistent" in js)
# P7.2 — motor de fuerza relativa: engine inyectado + helpers públicos referenciados
ok("helpers_js define _rel1rm (motor de fuerza relativa)", "_rel1rm" in res["helpers_js"])
ok("helpers_js define _weakest", "_weakest" in res["helpers_js"])
ok("JS de reglas referencia __H.slc_weakest_misidentified", "__H.slc_weakest_misidentified" in js)
ok("JS de reglas referencia __H.slc_ratio_max_jumps", "__H.slc_ratio_max_jumps" in js)

# --- V3.6: drift heurístico difuso (3 umbral duro + 1 clasificador difuso) ---
ok("helpers_js define superset_resembles_contrast", "superset_resembles_contrast" in res["helpers_js"])
ok("JS de reglas referencia __H.superset_resembles_contrast", "__H.superset_resembles_contrast" in js)
ok("helpers_js define resembles_french_contrast", "resembles_french_contrast" in res["helpers_js"])
ok("JS de reglas referencia __H.resembles_french_contrast", "__H.resembles_french_contrast" in js)
ok("helpers_js define _familyScores (clasificador difuso)", "_familyScores" in res["helpers_js"])
ok("JS de reglas referencia __H.family_misclassified", "__H.family_misclassified" in js)
ok("JS de reglas referencia __H.family_suggested", "__H.family_suggested" in js)

# --- P3.4: constructos nuevos + engine_rules ---
# helper de afinidad inyectado y usado por la regla migrada
ok("helpers_js define intent_off_method", "intent_off_method" in res["helpers_js"])
ok("JS de reglas referencia __H.intent_off_method", "__H.intent_off_method" in js)
# string literal en when (drift por intent) compila a comparación estricta de strings
ok("JS contiene comparación de string ('max_strength')", "=== 'max_strength'" in js)
# scope universal (method:null) → applies:b=>(true)
ok("JS contiene scope universal applies:b=>(true)", "applies:b=>(true)" in js)
# engine_rules copiadas al compiled doc
import yaml as _yaml
_doc = _yaml.safe_load((ROOT / "compiled" / "compiled_rules.yaml").read_text())
ok("compiled_rules.yaml contiene engine_rules (7)", len(_doc.get("engine_rules", [])) == 7)
ok("engine_rules incluye param_out_of_extended_range",
   any(e["id"] == "param_out_of_extended_range" for e in _doc.get("engine_rules", [])))

# accesor exercise_* compila a DATA.exercises[b.exercise]
expect_ok("ok accesor exercise_tpr (T1)",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: emom}\n    when: ['exercise_tpr != null', 'exercise_tpr > 2']\n    emits: emom_work_undefined\n")
# string literal exige comillas balanceadas: literal sin cerrar → token no reconocido
expect_builderror("string literal sin cerrar rechazado",
    "version: '1'\nrules:\n  - id: r\n    tier: T1\n    scope: {method: null}\n    when: [\"intent_declared == 'max_strength\"]\n    emits: intent_declared_inconsistent_with_parameters\n")
# engine_rule con emits a flag fantasma → E2
expect_builderror("engine_rule emits a flag inexistente → E2",
    "version: '1'\nrules: []\nengine_rules:\n  - id: er\n    emits: [flag_que_no_existe_xyz]\n    fidelity: implemented\n")

# ============================================================================
# P4.1 — FI de la familia F3 (agregaciones de array). Contrato P4.0 §6.
# ============================================================================
# positivo: any(...where...) en T4 compila
expect_ok("ok F3 any(components where ...) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method_in: [contrast, complex]}\n    when: ['any(components where exercise == null)']\n    emits: complex_component_exercise_undeclared\n")
# positivo: first(...).field para binding + catalog(c) en predicado
expect_ok("ok F3 first(...).cat_name + catalog(c) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    bindings: {component_name: \"first(components where role == 'heavy' AND catalog(c).mdi < 3).cat_name\"}\n    when: [\"any(components where role == 'heavy' AND catalog(c).mdi < 3)\"]\n    emits: contrast_heavy_low_demand\n")
# frontera: agregación fuera de T4 → BUILD ERROR
expect_builderror("agregación any(...) en T3 rechazada (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: contrast}\n    when: ['any(components where exercise == null)']\n    emits: contrast_heavy_low_demand\n",
    needle="tier T4")
# array no whitelisteado → BUILD ERROR
expect_builderror("array no whitelisteado en agregación → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    when: ['any(foo where exercise == null)']\n    emits: contrast_heavy_low_demand\n",
    needle="no whitelisteado")
# where malformado (sin where en any) → BUILD ERROR
expect_builderror("any(...) sin where → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    when: ['any(components)']\n    emits: contrast_heavy_low_demand\n",
    needle="requiere `where")
# campo de item inválido en predicado → BUILD ERROR
expect_builderror("campo de item no permitido en predicado → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    when: ['any(components where bogus_field > 1)']\n    emits: contrast_heavy_low_demand\n",
    needle="campo de item no permitido")
# catalog(c).<campo> inválido → BUILD ERROR
expect_builderror("catalog(c).<campo desconocido> → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    when: ['any(components where catalog(c).zzz < 3)']\n    emits: contrast_heavy_low_demand\n",
    needle="catalog(c)")
# first(...) sin .field → BUILD ERROR
expect_builderror("first(...) sin acceso .field → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    bindings: {x: 'first(components where exercise == null)'}\n    when: ['any(components where exercise == null)']\n    emits: contrast_heavy_low_demand\n",
    needle="`.<field>")
# verificación: las 6 reglas F3 reales están emitidas con sus closures
_f3_ids = {"component_without_exercise", "component_work_undefined",
           "contrast_explosive_reps_high", "slc_component_reps_atypical",
           "contrast_heavy_low_demand", "contrast_explosive_low_demand"}
_compiled_ids = {r["id"] for r in _doc.get("rules", [])}
ok("las 6 reglas F3 están en compiled_rules.yaml", _f3_ids <= _compiled_ids)
ok("JS contiene .some(c=> de agregación F3", ".some(c=>" in js)
ok("JS contiene catalog(c) compilado (DATA.exercises[c.exercise])",
   "DATA.exercises||{})[c.exercise]" in js)
# las 6 F3 ya NO están en engine_rules (migradas)
_engine_ids = {e["id"] for e in _doc.get("engine_rules", [])}
ok("las 6 reglas F3 salieron de engine_rules", not (_f3_ids & _engine_ids))

# ============================================================================
# P4.2 — FI de las familias F1 (COUNT), F2 (COUNT-WHERE), F5 (DISTINCT) +
# variant_not_in. Contrato P4.0 §6.
# ============================================================================
# positivo: count(<array>) y count(<array> where <pred>) en T4
expect_ok("ok F1 count(components) bare (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['count(components) < 2']\n    emits: complex_exercise_count_invalid\n")
expect_ok("ok F2 count(components where ...) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: contrast}\n    when: [\"count(components where role == 'heavy') > 0\"]\n    emits: contrast_pairs_unbalanced\n")
# positivo: distinct_count(<array>.<field-de-item>) y .<cat_*> (catálogo)
expect_ok("ok F5 distinct_count(components.exercise) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['distinct_count(components.exercise) < count(components where exercise != null)']\n    emits: component_exercise_duplicated\n")
expect_ok("ok F5 distinct_count(components.cat_implement) catálogo (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['distinct_count(components.cat_implement) > 1']\n    emits: slc_load_metric_inappropriate_for_component\n")
# positivo: scope variant_not_in
expect_ok("ok variant_not_in en scope (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method_in: [contrast, complex], variant_not_in: [chipper, time_capped_circuit]}\n    when: ['count(components) > 0']\n    emits: component_exercise_duplicated\n")
# frontera: count(...) fuera de T4 → BUILD ERROR
expect_builderror("count(...) en T3 rechazado (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: complex}\n    when: ['count(components) < 2']\n    emits: complex_exercise_count_invalid\n",
    needle="tier T4")
# distinct_count sin .field → BUILD ERROR
expect_builderror("distinct_count(...) sin .field → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['distinct_count(components) > 1']\n    emits: component_exercise_duplicated\n",
    needle="requiere `<array>.<field>")
# count con .field → BUILD ERROR
expect_builderror("count(<array>.<field>) → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['count(components.exercise) > 1']\n    emits: component_exercise_duplicated\n",
    needle="no acepta")
# distinct_count campo bogus → BUILD ERROR
expect_builderror("distinct_count(...).<campo desconocido> → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex}\n    when: ['distinct_count(components.zzz) > 1']\n    emits: component_exercise_duplicated\n",
    needle="no permitido")
# verificación: las 7 reglas P4.2 están emitidas con sus closures
_p42_ids = {"contrast_components_insufficient", "complex_components_insufficient",
            "variant_structure_incomplete", "contrast_pairing_invalid",
            "contrast_pairs_unbalanced", "component_exercise_duplicated",
            "slc_implement_heterogeneous"}
ok("las 7 reglas P4.2 están en compiled_rules.yaml", _p42_ids <= _compiled_ids)
ok("JS contiene .filter(c=> de COUNT-WHERE", ".filter(c=>" in js)
ok("JS contiene new Set( de DISTINCT", "new Set(" in js)
ok("JS contiene variant_not_in compilado (!...includes)", "![" in js or "!  [" in js)
# las 6 migradas en P4.2 ya NO están en engine_rules
_p42_engine_gone = {"components_insufficient", "contrast_pairing_invalid",
                    "contrast_pairs_unbalanced", "component_exercise_duplicated",
                    "slc_implement_heterogeneous", "variant_structure_incomplete"}
ok("las reglas P4.2 salieron de engine_rules", not (_p42_engine_gone & _engine_ids))

# ============================================================================
# P4.3 — FI de la familia F6 (helper-sobre-array estimate_work_duration).
# ============================================================================
# positivo: estimate_work_duration(work_per_interval) en T4
expect_ok("ok F6 estimate_work_duration(work_per_interval) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: emom}\n    when: ['estimate_work_duration(work_per_interval) >= interval_sec']\n    emits: emom_work_exceeds_interval\n")
# frontera: helper-sobre-array fuera de T4 → BUILD ERROR
expect_builderror("estimate_work_duration(...) en T2 rechazado (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T2\n    scope: {method: emom}\n    when: ['estimate_work_duration(work_per_interval) >= interval_sec']\n    emits: emom_work_exceeds_interval\n",
    needle="tier T4")
# helper-sobre-array con where → BUILD ERROR (recibe el array completo)
expect_builderror("estimate_work_duration(... where ...) → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: emom}\n    when: [\"estimate_work_duration(work_per_interval where work_value > 0) >= interval_sec\"]\n    emits: emom_work_exceeds_interval\n",
    needle="sin `where")
# las 3 reglas EMOM F6 están emitidas
_p43_ids = {"emom_work_undefined", "emom_density_impossible", "emom_density_high"}
ok("las 3 reglas EMOM F6 están en compiled_rules.yaml", _p43_ids <= _compiled_ids)
ok("helpers_js define estimate_work_duration", "estimate_work_duration" in res["helpers_js"])
ok("JS de reglas referencia __H.estimate_work_duration", "__H.estimate_work_duration" in js)
# las 3 EMOM ya NO están en engine_rules
ok("las 3 EMOM F6 salieron de engine_rules", not (_p43_ids & _engine_ids))

# ============================================================================
# P4.4 — FI de los block-helpers de duración (estimate_total_duration/_rounds).
# ============================================================================
# positivo: block-helper sin argumentos en T4
expect_ok("ok F6 estimate_total_duration() block-helper (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: chipper}\n    when: ['estimate_total_duration() > 1800']\n    emits: chipper_estimated_duration_exhaustive\n")
expect_ok("ok F6 estimate_rounds() block-helper (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: time_capped_circuit}\n    when: ['estimate_rounds() != null', 'estimate_rounds() < 3']\n    emits: tcc_rounds_too_few\n")
# frontera: block-helper fuera de T4 → BUILD ERROR
expect_builderror("estimate_total_duration() en T2 rechazado (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T2\n    scope: {method: complex, variant: chipper}\n    when: ['estimate_total_duration() > 1800']\n    emits: chipper_estimated_duration_exhaustive\n",
    needle="tier T4")
# block-helper CON argumentos → BUILD ERROR (opera sobre el bloque, sin args)
expect_builderror("estimate_total_duration(components) → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: chipper}\n    when: ['estimate_total_duration(components) > 1800']\n    emits: chipper_estimated_duration_exhaustive\n",
    needle="no recibe argumentos")
# las 8 reglas P4.4 están emitidas
_p44_ids = {"emom_work_too_light_for_interval", "complex_estimated_duration_excessive",
            "complex_estimated_duration_too_short", "chipper_estimated_duration_exhaustive",
            "chipper_estimated_exceeds_cap", "tcc_rounds_too_few",
            "tcc_target_rounds_mismatch_estimate", "circuit_duration_mismatch_target"}
ok("las 8 reglas P4.4 están en compiled_rules.yaml", _p44_ids <= _compiled_ids)
ok("helpers_js define estimate_total_duration", "estimate_total_duration" in res["helpers_js"])
ok("helpers_js define estimate_rounds", "estimate_rounds" in res["helpers_js"])
ok("JS de reglas referencia __H.estimate_total_duration", "__H.estimate_total_duration" in js)
ok("JS de reglas referencia __H.estimate_rounds", "__H.estimate_rounds" in js)

# ============================================================================
# P5.1 — FI del operador F6 monotonía (monotonic_increasing/decreasing).
# ============================================================================
# positivo: monotonic sobre components.reps (campo canónico virtual)
expect_ok("ok F6 monotonic_decreasing(components.reps) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: chipper}\n    when: ['NOT monotonic_decreasing(components.reps)']\n    emits: chipper_reps_progression_unusual\n")
# positivo: monotonic sobre set_ramp.load_pct_1rm (campo plano directo)
expect_ok("ok F6 monotonic_increasing(set_ramp.load_pct_1rm) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: pyramid, variant: ascending}\n    when: ['NOT monotonic_increasing(set_ramp.load_pct_1rm)']\n    emits: pyramid_load_not_monotonic\n")
# frontera: monotonic fuera de T4 → BUILD ERROR
expect_builderror("monotonic_increasing(...) en T3 rechazado (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: pyramid, variant: ascending}\n    when: ['monotonic_increasing(set_ramp.load_pct_1rm)']\n    emits: pyramid_load_not_monotonic\n",
    needle="tier T4")
# monotonic con where → BUILD ERROR (requiere .field, no where)
expect_builderror("monotonic_increasing(... where ...) → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: pyramid, variant: ascending}\n    when: ['monotonic_increasing(set_ramp where load_pct_1rm > 50)']\n    emits: pyramid_load_not_monotonic\n",
    needle="requiere `<array>.<field>")
# monotonic campo bogus → BUILD ERROR
expect_builderror("monotonic_decreasing(...).<campo desconocido> → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: chipper}\n    when: ['monotonic_decreasing(components.zzz)']\n    emits: chipper_reps_progression_unusual\n",
    needle="no permitido")
# monotonic array no whitelisteado → BUILD ERROR
expect_builderror("monotonic_increasing(<array no whitelisteado>) → BUILD ERROR",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: pyramid, variant: ascending}\n    when: ['monotonic_increasing(bogus_arr.load_pct_1rm)']\n    emits: pyramid_load_not_monotonic\n",
    needle="no whitelisteado")
ok("chipper_reps_progression_unusual en compiled_rules.yaml",
   "chipper_reps_progression_unusual" in _compiled_ids)
ok("helpers_js define is_monotonic", "is_monotonic" in res["helpers_js"])
ok("JS de reglas referencia __H.is_monotonic", "__H.is_monotonic" in js)
ok("JS contiene resolución canónica de reps en monotonic (work_metric==='reps')",
   "work_metric==='reps'" in js)
# break-index operators (component_index binding)
expect_ok("ok F6 monotonic_break_increasing(set_ramp.load_pct_1rm) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: pyramid, variant: ascending}\n    bindings: {component_index: 'monotonic_break_increasing(set_ramp.load_pct_1rm)'}\n    when: ['NOT monotonic_increasing(set_ramp.load_pct_1rm)']\n    emits: pyramid_load_not_monotonic\n")
expect_ok("ok F6 monotonic_break_decreasing(round_plan.load_pct_1rm) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: pyramid, variant: multi_exercise_pyramid}\n    bindings: {component_index: 'monotonic_break_increasing(round_plan.load_pct_1rm)'}\n    when: ['NOT monotonic_increasing(round_plan.load_pct_1rm)']\n    emits: mep_load_not_monotonic_across_rounds\n")
ok("helpers_js define monotonic_break", "monotonic_break" in res["helpers_js"])
ok("JS de reglas referencia __H.monotonic_break", "__H.monotonic_break" in js)
ok("las 6 reglas P5.1 están en compiled_rules.yaml",
   {"chipper_reps_progression_unusual","pyramid_load_not_monotonic_asc",
    "pyramid_load_not_monotonic_desc","pyramid_top_set_outside_zone_asc",
    "pyramid_top_set_outside_zone_desc","mep_load_not_monotonic_across_rounds"} <= _compiled_ids)

# ============================================================================
# P5.2 — FI de mechanical_drop (mechanical_progression).
# ============================================================================
expect_ok("ok monotonic_decreasing(mechanical_progression.effective_demand) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: drop, variant: mechanical_drop}\n    when: ['count(mechanical_progression) > 0', 'NOT monotonic_decreasing(mechanical_progression.effective_demand)']\n    emits: mechanical_drop_demand_not_decreasing\n")
expect_ok("ok distinct_count(mechanical_progression.exercise) + any catalog(c) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: drop, variant: mechanical_drop}\n    when: [\"mechanism == 'range_of_motion'\", 'distinct_count(mechanical_progression.exercise) > 1']\n    emits: mechanical_drop_rom_changes_exercise\n")
expect_ok("ok any(mechanical_progression where catalog(c).name == null) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: drop, variant: mechanical_drop}\n    bindings: {component_index: 'first_index(mechanical_progression where exercise != null AND catalog(c).name == null) + 1'}\n    when: ['any(mechanical_progression where exercise != null AND catalog(c).name == null)']\n    emits: mechanical_drop_step_not_in_catalog\n")
ok("JS contiene coerción null del accesor catalog(c) (?? null)", "?? null" in js)
ok("JS contiene effective_demand de mechanical_progression (difficulty_index_override)",
   "difficulty_index_override" in js)
ok("las 5 reglas P5.2 están en compiled_rules.yaml",
   {"mechanical_drop_no_progression_declared","mechanical_drop_progression_length_mismatch",
    "mechanical_drop_demand_not_decreasing","mechanical_drop_rom_changes_exercise",
    "mechanical_drop_step_not_in_catalog"} <= _compiled_ids)

# ============================================================================
# P5.4 — FI de la rotación EMOM (exercises_rotation como array whitelisteado).
# ============================================================================
expect_ok("ok F1 count(exercises_rotation) < 2 (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: emom, variant: alternating}\n    when: ['count(exercises_rotation) < 2']\n    emits: emom_alternating_rotation_empty\n")
ok("emom_alternating_rotation_empty en compiled_rules.yaml", "emom_alternating_rotation_empty" in _compiled_ids)

# ============================================================================
# P5.3 — FI de AGS (antagonist_giant_set): block-helpers de pareo + campos de item.
# ============================================================================
expect_ok("ok F1 count(components) != pairs_count*2 (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: antagonist_giant_set}\n    when: ['pairs_count != null', 'count(components) != pairs_count * 2']\n    emits: ags_components_count_invalid\n")
expect_ok("ok any(components where role_in_pair == null) (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: antagonist_giant_set}\n    when: [\"any(components where role_in_pair == null OR role_in_pair == '')\"]\n    emits: ags_role_in_pair_undeclared\n")
expect_ok("ok ags block-helpers de pareo (T4)",
    "version: '1'\nrules:\n  - id: r\n    tier: T4\n    scope: {method: complex, variant: antagonist_giant_set}\n    bindings: {component_index: 'ags_first_bad_pair_index()'}\n    when: ['ags_first_bad_pair_index() > 0', 'ags_pairs_unbalanced()', 'ags_first_shared_pattern_pair() > 0']\n    emits: ags_pair_index_invalid\n")
expect_builderror("ags_pairs_unbalanced() en T3 rechazado (frontera de tier)",
    "version: '1'\nrules:\n  - id: r\n    tier: T3\n    scope: {method: complex, variant: antagonist_giant_set}\n    when: ['ags_pairs_unbalanced()']\n    emits: ags_pair_count_mismatch\n",
    needle="tier T4")
_p53_ids = {"ags_components_count_invalid", "ags_role_in_pair_undeclared",
            "ags_pair_index_invalid", "ags_pair_count_mismatch", "ags_pair_not_antagonistic"}
ok("las 5 reglas P5.3 (AGS) están en compiled_rules.yaml", _p53_ids <= _compiled_ids)
ok("helpers_js define ags_pairs_unbalanced", "ags_pairs_unbalanced" in res["helpers_js"])
ok("JS de reglas referencia __H.ags_first_bad_pair_index", "__H.ags_first_bad_pair_index" in js)
ok("las 5 AGS ausentes de engine_rules", not (_p53_ids & _engine_ids))

# limpieza del compiled/ temporal que compile_rules(ROOT) reescribe lo deja consistente
print(f"\nCOMPILADOR: {PASS} pass, {FAIL} fail")
sys.exit(1 if FAIL else 0)
