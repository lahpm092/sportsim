# P3.0 — Contrato del compilador `compiled_rules.yaml` → motor JS

> Documento de **diseño de contrato**. No implementa nada. Fija la forma del
> artefacto intermedio, el subconjunto compilable (T1–T3), los hooks reservados
> (T4/T5) y los invariantes de integridad. Decisiones confirmadas por Martin:
> **alcance T1–T3 (37 flags)**, **archivo intermedio (opción 2A)**,
> **mapping embebido por regla (opción 3A)**.

---

## 0. Qué resuelve P3

Hoy el motor del Prescriptor reimplementa a mano, en JS, reglas que ya existen
declarativamente en los YAMLs (`drift_rules.yaml`, `adjustment_rules.yaml`,
`params_schema` de los métodos). Dos fuentes de verdad → deriva inevitable.

P3 introduce **una sola fuente**: las reglas declarativas se compilan a un
artefacto normalizado (`compiled_rules.yaml`) que `build_prescriptor.py` inyecta
al motor. El `COVERAGE_MAP` deja de ser un objeto co-mantenido y pasa a ser un
**campo de cada regla** (`emits`), de modo que la matriz de cobertura se *deriva*
en vez de mantenerse.

**Alcance P3 (esta fase):** los 37 flags de tier T1–T3.
**Fuera de alcance (sub-fases con prerequisito):** T4 (27, editores de
componentes) y T5 (7, catálogo embebido / `loaded_regions`). El contrato les
reserva forma pero el compilador **no los emite**.

---

## 1. Topología del pipeline (objetivo)

```
FUENTES DECLARATIVAS                COMPILADOR              ARTEFACTO              MOTOR
─────────────────────               ──────────              ─────────              ─────
drift_rules.yaml          ┐
adjustment_rules.yaml     │  build_prescriptor.py
methods/*params_schema    ├──►  (compile_rules)   ──►  compiled_rules.yaml  ──►  prescriptor.html
flag_catalog.yaml (refs)  │         normaliza      compiled/compiled_rules.yaml   (RULES[] inyectado;
                          ┘         + valida E*    (inspeccionable, diff)           NO se edita a mano)
```

**Ubicación (Q3 resuelta):** carpeta propia `compiled/`, no junto a las fuentes en
`methods/`. Hace visualmente obvio que es artefacto derivado — mismo criterio que
`prescriptor.html` separado de su template.

Regla de operación heredada (intacta): `prescriptor.html` y ahora también
`compiled_rules.yaml` son **artefactos derivados** — se regeneran, nunca se editan
a mano. Igual que `COVERAGE.md` y `MANIFEST.txt`.

**Cambio de orden en el build:** hoy `build_prescriptor.py` extrae datos de los
schemas → template → html, y encadena suite + cobertura. P3 inserta un paso previo:
`compile_rules()` produce `compiled_rules.yaml`; el template lo consume como dato
(igual que ya consume `params_schema`). Sin verde en suite + integridad de
mapping no hay entrega (invariante preexistente, se conserva).

---

## 2. Esquema del artefacto intermedio `compiled_rules.yaml`

Un solo archivo en `compiled/compiled_rules.yaml`, top-level estable, una entrada
por regla. Forma normalizada (da igual de qué YAML fuente provino):

```yaml
version: "1.0"
generated_by: "tools/build_prescriptor.py::compile_rules"
source_digest: "<sha256 de las fuentes, para detectar edición manual>"

rules:
  - id: contrast_heavy_load_too_high          # snake_case, único, == flag_id cuando 1:1
    tier: T1                                   # T1|T2|T3  (T4/T5 reservados, no emitidos)
    origin: drift_rules.yaml#contrast          # trazabilidad a la fuente
    applies_at: block                          # heredado del flag (block|session)
    severity: viability                        # informational|structural_hard|viability
    level: warning_strong                      # solo si severity==viability; si no, null
    scope:                                     # a qué bloque aplica (precondición barata)
      method: contrast
      variant: null                            # null = cualquier variante del método
    when:                                      # CONDICIÓN — gramática declarativa (§3)
      - "component_role('heavy').load_pct_1rm > 95"
    detail_schema: viability_pattern           # heredado del flag
    message_template: "Heavy component load {load_pct}% exceeds 95%. ..."
    suggestion_template: "Reduce heavy component load to 85-90%."
    emits: contrast_heavy_load_too_high        # ← MAPPING EMBEBIDO (reemplaza COVERAGE_MAP)
    fidelity: implemented                      # implemented|partial (deriva el grade de cobertura)
```

### 2.1 Campos y su origen

| Campo | Origen | Nota |
|---|---|---|
| `id` | regla fuente o `flag_id` | único en el archivo |
| `tier` | clasificación P3 (dimensionamiento) | gobierna qué helpers puede invocar `when` |
| `origin` | fuente + ancla | trazabilidad; `coverage_report` puede auditar |
| `applies_at`, `severity`, `level`, `detail_schema`, `*_template` | **copiados de `flag_catalog.yaml`** | el flag sigue siendo la autoridad de su propia ficha |
| `scope` | regla fuente (`origin_method`/`applies_to`) | precondición barata (== `applies(b)` del motor) |
| `when` | `conditions` de la regla fuente | gramática §3 |
| `emits` | **nuevo** — reemplaza la entrada de COVERAGE_MAP | string \| lista \| null |
| `fidelity` | **nuevo** — reemplaza el prefijo `partial:` | `implemented`\|`partial` |

### 2.2 `emits` + `fidelity`: el COVERAGE_MAP disuelto

El mapping motor→spec deja de existir como objeto aparte. Equivalencias:

| COVERAGE_MAP (hoy) | compiled_rules (P3) |
|---|---|
| `"rule": "flag"` | `emits: flag` · `fidelity: implemented` |
| `"rule": "partial:flag"` | `emits: flag` · `fidelity: partial` |
| `"rule": ["a","partial:b"]` | `emits: [a, b]` + `fidelity` por-flag (§2.3) |
| `"rule": null` | `emits: null` (engine-only → candidata Sección V) |

### 2.3 Caso lista con fidelidades mixtas

Cuando una regla emite varios flags con grados distintos, `fidelity` se vuelve
un mapa para no perder granularidad:

```yaml
emits: [emom_interval_too_short, cluster_intra_rest_too_long]
fidelity:
  emom_interval_too_short: implemented
  cluster_intra_rest_too_long: partial
```

`coverage_report.py` ya distingue implemented/partial por flag (función
`normalize`); esto preserva exactamente esa semántica.

---

## 3. Gramática de `when` (qué es compilable en T1–T3)

Reutiliza la gramática que `drift_rules.yaml` ya documenta (A.9.9.4), restringida
a lo evaluable sin datos externos. El compilador traduce cada string `when` a una
clausura JS `test(b)` y el `scope` a `applies(b)` — la forma que el motor ya corre.

**Permitido (T1–T3):**
- Operadores: `< <= > >= == != IN NOT_IN`
- Lógicos: `AND OR NOT` con paréntesis
- Paths dotted sobre `b.params.*`, `b.intent_declared`, `b.exercise`, `b.variant`
- Agregados puros: `len() sum() mean() mode() count() unique() min() max()`
- **Selectores de componente de solo-lectura escalar** (T1):
  `component_role('heavy').load_pct_1rm` → primer componente con ese rol, campo escalar
- **Helpers de estimación whitelisteados (T2)** — funciones puras, sin catálogo
  más allá de `tpr` (ya embebido en `DATA.exercises`):
  `estimate_work_duration(...)`, `estimate_chipper_duration(...)`,
  `compute_work_to_rest_ratio(...)`, `aggregate_volume(...)`
- **Helpers de zona/viabilidad whitelisteados (T3)** — Grupos 1–3 del spec,
  lógica pura: `classify_zone(...)`, `compute_viability(...)`, `epley_inverse(...)`

**Prohibido en P3 (marca de tier, el compilador rechaza con error de build):**
- Iteración estructural sobre arrays de componentes/pasos para **patrones**
  (monotonía, alternancia, orden de roles, consistencia por-ronda) → **T4**
- Cualquier `fn:check_*` de Grupo 10 (hooks de código) → **T4**
- Acceso a strength ratios, weakest-link, patrones antagonistas, refs de
  catálogo más allá de `tpr`/`mdi`/`implement` ya embebidos → **T5**

> **MARCA (v3 / sub-fases):** `when` reserva la *sintaxis* de selectores de array
> (`components[*].load`) y de hooks (`fn:*`), pero el compilador en P3 emite
> `BUILD ERROR: tier T4/T5 no compilable en P3` si los encuentra fuera de una
> regla marcada `tier: T4|T5`. Las reglas T4/T5 pueden existir en el archivo
> (declaradas) con `emits` y `fidelity`, pero el compilador las **salta** (no
> genera `test`), y `coverage_report` las cuenta como `missing` hasta su sub-fase.

---

## 4. Invariantes de integridad (qué garantiza el contrato)

### 4.1 E1/E2 colapsan por construcción (la ganancia estructural)

Hoy `coverage_report.py` valida tres errores que **bloquean** el build:
- **E1** regla del motor sin entrada en el map
- **E2** el map referencia un flag inexistente
- **E3** el map referencia un flag fuera de scope (no block|session)

Con `emits` embebido:
- **E1 imposible:** una regla *es* su propio mapping; no puede existir sin `emits`
  (campo obligatorio del schema de `compiled_rules.yaml`). El compilador rechaza
  una regla sin `emits`.
- **E2 se mueve a compile-time:** el compilador valida cada `emits` contra
  `flag_catalog.yaml` al generar; si referencia un id inexistente → BUILD ERROR,
  antes de tocar el motor.
- **E3 se conserva** como validación: el compilador (no un reporte posterior)
  verifica `flag_catalog[emit].applies_at ∈ {block, session}`.

Resultado: las tres comprobaciones se adelantan a la compilación. `coverage_report.py`
deja de extraer un objeto por regex y pasa a **leer `compiled_rules.yaml`**
(estructurado), reportando el % (informativo, nunca bloquea — decisión preservada).

> **Impacto registrado:** `tools/coverage_report.py::extract_coverage_map` (regex
> sobre el template) queda obsoleto; se reescribe para consumir
> `compiled_rules.yaml`. `extract_engine_rule_ids` ídem. Esto es trabajo de P3,
> no de P3.0.

### 4.2 Anti-deriva del intermedio

`source_digest` (sha256 de las fuentes que alimentaron la compilación) se escribe
en `compiled_rules.yaml`. El build recomputa y compara: si alguien editó el
intermedio a mano o las fuentes cambiaron sin recompilar → advertencia. Mismo
espíritu que MANIFEST.txt a escala de este artefacto.

### 4.3 Fault-injection obligatorio (disciplina del proyecto)

Antes de declarar P3 cerrado, cada categoría del compilador se rompe a propósito:
regla sin `emits` (espera E1-equivalente), `emits` a flag fantasma (espera E2),
`emits` a flag microcycle_plus (espera E3), `when` con selector de array en una
regla `tier: T1` (espera "tier no compilable"). Un compilador que nunca falla
está sin verificar.

---

## 5. Equivalencia funcional con el motor actual (no regresión)

El motor hoy corre `[...STRUCT_RULES, ...DRIFT_RULES, ...COMPAT_RULES]` con la
forma `{id, sev, applies, test, msg, sugg}` y emite vía
`F(id, sev, scope, msg, sugg)`. El compilador produce exactamente esa forma:

| compiled_rules | → genera en el motor |
|---|---|
| `scope` | `applies: b => ...` |
| `when` | `test: b => ...` |
| `severity` (`structural_hard`→`hard`, resto→`informational`)* | `sev` |
| `message_template` resuelto | `msg: b => ...` |
| `suggestion_template` resuelto | `sugg: b => ...` |
| `emits`/`fidelity` | ya NO va al motor — va a la matriz de cobertura |

\* **Decisión confirmada (Q1, ejecutar en T1):** el motor v0.1 colapsa severidad a
`hard`/`informational` y pierde `viability` + `level`. 16 de los 37 flags T1–T3 son
`viability`. **P3 enriquece `F()` y el sello `overall_coherent` en T1** para
distinguir `viability` con su `level` (incl. `hard_fail`), de modo que
`overall_coherent=false ⟺ hard OR viability.hard_fail` (decisión arquitectónica §3)
quede reflejado fielmente. Se hace en T1 — no después — para no entregar flags con
severidad degradada y reabrir el motor en T2/T3.

---

## 6. Plan de migración T1→T2→T3 (orden de ataque)

1. **T1 (20 flags) primero** — valida el pipeline compilador completo con el caso
   más simple (relaciones escalares + el selector escalar de componente
   `component_role('heavy').load_pct_1rm`, única concesión a `components[]` en P3,
   confirmada Q2: solo-lectura de un escalar, mantiene los ~3 flags contrast en T1).
   **Incluye el enriquecimiento de `F()`/`overall_coherent` (Q1)** — viability+level.
   Si el round-trip `compiled/compiled_rules.yaml → motor → suite verde` funciona
   aquí, la arquitectura está probada.
2. **T2 (12)** — añade el whitelist de helpers de estimación (portar ~4 funciones
   puras de Grupo 7 del spec al motor; el compilador solo las referencia).
3. **T3 (5)** — añade zona/viabilidad (Grupos 1–3). Denso pero acotado y reusable.

Cada tier: compilar → suite 559+ → fault-injection → actualizar COVERAGE.md
(derivado) → cierre de sub-paso con recap.

---

## 7. Lo que P3.0 deja decidido vs. pendiente

**Decidido (este contrato, P3.0 CERRADO):** topología del pipeline; ubicación
`compiled/compiled_rules.yaml` (Q3); schema del intermedio; `emits`+`fidelity`
como sustituto del COVERAGE_MAP; gramática `when` y su frontera T1–T3 vs T4/T5;
selector escalar de componente como única concesión a `components[]` en P3 (Q2);
enriquecimiento de `F()`/`overall_coherent` con viability+level en T1 (Q1);
colapso de E1/E2/E3 a compile-time; anti-deriva por digest; orden T1→T2→T3;
equivalencia con la forma del motor.

**Siguiente substep:** P3.1 = implementación de T1 (esqueleto del compilador
`compile_rules()` en `build_prescriptor.py` + 20 reglas T1 + `F()`/sello
enriquecidos + suite + fault-injection).
