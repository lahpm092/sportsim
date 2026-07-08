#!/usr/bin/env python3
"""
P2/P3 — Matriz de cobertura spec↔implementado del Prescriptor.

Cruza:
  - flag_catalog.yaml          → flags con applies_at == block (denominador)
  - compiled/compiled_rules.yaml → ÚNICA fuente del mapping motor→spec (P3.4):
       · `rules`        — reglas compiladas (closures); cada una acredita su
                          `emits` con grado = `fidelity`.
       · `engine_rules` — motor de rangos genérico (param_*), mapping-only: NO se
                          compila a closure (itera params_schema en código) pero
                          declara sus `emits`. Reemplaza al COVERAGE_MAP.
  SIN regex sobre el template (P3.4: COVERAGE_MAP disuelto).

Emite COVERAGE.md + resumen por consola.

Errores de integridad (bloquean, exit 1):
  E2_unknown_flag_ref       una referencia (compiled o engine_rule) a id inexistente
  E3_nonblock_flag_ref      referencia a un flag cuyo applies_at ∉ {block, session}
  E4_stale_compiled         compiled_rules.yaml desactualizado vs su fuente (digest)

(E1 eliminado en P3.4: con el mapping embebido en cada regla, "regla del motor sin
mapear" es imposible por construcción — ya no hay COVERAGE_MAP que sincronizar.)

El porcentaje de cobertura es INFORMATIVO: nunca bloquea (decisión P2, sesión 3).
"""
import sys, datetime, hashlib
from pathlib import Path
from collections import Counter

try:
    import yaml
except ImportError:
    sys.exit("PyYAML requerido")

ROOT = Path(__file__).resolve().parent.parent
FLAGS = ROOT / "flag_catalog.yaml"
SOURCE_RULES = ROOT / "rules" / "prescriptor_rules.yaml"
COMPILED = ROOT / "compiled" / "compiled_rules.yaml"
OUT = ROOT / "COVERAGE.md"

_COMPILABLE_TIERS = {"T1", "T2", "T3", "T4"}  # P4.1: T4 compila (familia F3 EXISTS)


def _engine_grade(fidelity, flag_id):
    """engine_rules.fidelity puede ser str ('implemented'|'partial') o dict
    por-flag con clave '_default'. Devuelve el grado para un flag dado."""
    if isinstance(fidelity, dict):
        return fidelity.get(flag_id, fidelity.get("_default", "implemented"))
    return fidelity or "implemented"


def load_compiled(errors: list):
    """Lee compiled/compiled_rules.yaml: verifica frescura (E4) y devuelve
    (reglas activas tier-compilable, engine_rules) o ([], []) si no existe."""
    if not COMPILED.exists():
        return [], []
    doc = yaml.safe_load(COMPILED.read_text()) or {}
    if SOURCE_RULES.exists() and FLAGS.exists():
        fresh = hashlib.sha256(SOURCE_RULES.read_bytes() + FLAGS.read_bytes()).hexdigest()
        if doc.get("source_digest") != fresh:
            errors.append(
                "E4_stale_compiled: compiled_rules.yaml no corresponde a su fuente "
                "(rules/prescriptor_rules.yaml + flag_catalog.yaml). Reconstruye con el build.")
    rules = [r for r in doc.get("rules", []) if r.get("tier") in _COMPILABLE_TIERS]
    return rules, doc.get("engine_rules", [])


def main():
    fc = yaml.safe_load(FLAGS.read_text())
    flags = fc["flags"]

    errors = []
    PRESCRIPTOR_SCOPES = {"block", "session"}
    spec_status = {}      # spec_id (block) -> implemented|partial (implemented gana)
    session_covered = {}  # spec_id (session) -> idem
    engine_only = []      # reglas con emits=null (sin flag de spec)

    def credit(rid, sid, grade, kind):
        """Acredita un flag a su universo (block/session); registra E2/E3."""
        if sid not in flags:
            errors.append(f"E2_unknown_flag_ref: {kind} '{rid}' → '{sid}' no existe en flag_catalog")
            return
        scope = flags[sid].get("applies_at")
        if scope not in PRESCRIPTOR_SCOPES:
            errors.append(f"E3_nonblock_flag_ref: {kind} '{rid}' → '{sid}' "
                          f"(applies_at={scope}, fuera de scope del Prescriptor)")
            return
        target = spec_status if scope == "block" else session_covered
        prev = target.get(sid)
        if prev != "implemented":
            target[sid] = grade if prev is None else (
                "implemented" if grade == "implemented" else prev)

    # --- P3.4: ÚNICA fuente del mapping = compiled_rules.yaml (rules + engine_rules) ---
    compiled, engine_rules = load_compiled(errors)

    # reglas compiladas (closures): grado = fidelity de la regla
    compiled_ids = []
    for r in compiled:
        rid = r.get("id")
        compiled_ids.append(rid)
        grade = "partial" if r.get("fidelity") == "partial" else "implemented"
        emits = r.get("emits")
        for sid in (emits if isinstance(emits, list) else [emits] if emits else []):
            credit(rid, sid, grade, "regla compilada")

    # engine_rules (motor de rangos, mapping-only): grado por-flag (_engine_grade)
    engine_ids = []
    for er in engine_rules:
        rid = er.get("id")
        engine_ids.append(rid)
        emits = er.get("emits")
        if emits is None:
            engine_only.append(rid)
            continue
        for sid in (emits if isinstance(emits, list) else [emits]):
            credit(rid, sid, _engine_grade(er.get("fidelity"), sid), "engine_rule")

    if errors:
        print("✗ INTEGRIDAD DEL MAPPING — errores:")
        for e in errors:
            print("  ", e)
        sys.exit(1)


    block_flags = sorted(k for k, v in flags.items() if v.get("applies_at") == "block")
    implemented = sorted(k for k in block_flags if spec_status.get(k) == "implemented")
    partial = sorted(k for k in block_flags if spec_status.get(k) == "partial")
    missing = sorted(k for k in block_flags if k not in spec_status)
    n = len(block_flags)
    pct = lambda x: f"{100*len(x)/n:.1f}%"

    by_at = Counter(v.get("applies_at") for v in flags.values())

    lines = []
    a = lines.append
    a("# COVERAGE — Matriz de cobertura spec↔Prescriptor")
    a("")
    a(f"_Generado por `tools/coverage_report.py` — {datetime.date.today().isoformat()}. "
      "NO editar a mano. Informativo: el % no bloquea el build; la integridad del mapping sí._")
    a("")
    a("## Resumen")
    a("")
    a(f"| Universo | n |")
    a(f"|---|---|")
    for k in ("block", "session", "microcycle_plus", "execution", "catalog_load"):
        a(f"| `{k}` | {by_at.get(k, 0)} |")
    a(f"| **total flags** | **{sum(by_at.values())}** |")
    a("")
    a(f"**Denominador del Prescriptor: {n} flags `block`.**")
    a("")
    a(f"| Estado | n | % |")
    a(f"|---|---|---|")
    a(f"| Implemented | {len(implemented)} | {pct(implemented)} |")
    a(f"| Partial | {len(partial)} | {pct(partial)} |")
    a(f"| Missing | {len(missing)} | {pct(missing)} |")
    a(f"| **Cubierto (impl+partial)** | **{len(implemented)+len(partial)}** | "
      f"**{100*(len(implemented)+len(partial))/n:.1f}%** |")
    a("")
    a(f"Mapping (única fuente: `compiled_rules.yaml`): {len(compiled_ids)} reglas compiladas "
      f"(closures) + {len(engine_ids)} engine_rules (motor de rangos, mapping-only) · "
      f"engine-only sin flag de spec: {len(engine_only)} · "
      f"flags session cubiertos: {len(session_covered)}")
    a("")
    for title, items in (("Implemented", implemented), ("Partial", partial), ("Missing", missing)):
        a(f"## {title} ({len(items)})")
        a("")
        for k in items:
            a(f"- `{k}` _{flags[k]['severity']}_")
        a("")
    a(f"## Engine-only — sin flag de spec ({len(engine_only)})")
    a("")
    for k in sorted(engine_only):
        a(f"- `{k}`")
    a("")
    OUT.write_text("\n".join(lines))

    print(f"✓ MAPPING ÍNTEGRO — {len(compiled_ids)} reglas compiladas + "
          f"{len(engine_ids)} engine_rules (mapping-only), 0 errores")
    print(f"Cobertura block ({n}): implemented {len(implemented)} ({pct(implemented)}) · "
          f"partial {len(partial)} ({pct(partial)}) · missing {len(missing)} ({pct(missing)})")
    print(f"Engine-only (sin flag): {len(engine_only)}")
    print(f"Reporte: {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
