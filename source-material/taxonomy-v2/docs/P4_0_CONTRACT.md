# P4.0 — Contrato del compilador T4 (selectores de array)

> Documento de DISEÑO. Análogo a `P3_0_CONTRACT.md` para T1–T3. Cierra la gramática
> de iteración sobre `components[]` / `work_per_interval` que permite compilar las
> reglas T4 desde `rules/prescriptor_rules.yaml`, eliminando el hardcode del motor.
> **No toca el compilador todavía** — sólo fija sintaxis, semántica, frontera e
> invariantes. La implementación es P4.1+ (por familia, con golden de equivalencia).

**Prerequisito CUMPLIDO (v0.2.0):** el editor estructurado de work_units captura
`components[]` y `work_per_interval` en forma canónica (3 métricas de trabajo +
`load_metric` de 6 valores). Sin esa captura las reglas T4 no tenían input; ahora
sí. Ver PROJECT_STATE §5i.

---

## 1. Alcance: las 15 reglas T4 migrables

Las "16 reglas T4" del roadmap incluían el motor de rangos genérico (residual
permanente, no declarativo). Las **15 reglas migrables** (engine_rules no-motor) y
el flag que emite cada una:

| # | regla (id motor) | flag emitido | familia de operador |
|---|---|---|---|
| 1 | components_insufficient | complex/contrast_*_count_invalid (×3) | COUNT |
| 2 | variant_structure_incomplete | french_contrast_components_count_wrong | COUNT |
| 3 | component_without_exercise | complex_component_exercise_undeclared | EXISTS |
| 4 | component_work_undefined | circuit_component_work_metric_missing | EXISTS |
| 5 | contrast_explosive_reps_high | contrast_explosive_reps_high | EXISTS (+role) |
| 6 | slc_component_reps_atypical | slc_component_reps_atypical | EXISTS |
| 7 | contrast_heavy_low_demand | contrast_heavy_low_demand | EXISTS (+catálogo) |
| 8 | contrast_explosive_low_demand | contrast_explosive_low_demand | EXISTS (+catálogo) |
| 9 | contrast_pairing_invalid | contrast_roles_inconsistent_with_variant | ROLE-PRESENCE |
| 10 | contrast_pairs_unbalanced | contrast_pairs_unbalanced | COUNT-WHERE (×2) |
| 11 | component_exercise_duplicated | component_exercise_duplicated | DISTINCT |
| 12 | slc_implement_heterogeneous | slc_load_metric_inappropriate_for_component | DISTINCT (+catálogo) |
| 13 | emom_work_undefined | emom_work_undefined | EXISTS (work_per_interval) |
| 14 | emom_density_impossible | emom_work_exceeds_interval | REDUCE/AGG (work_per_interval) |
| 15 | emom_density_high | emom_work_exceeds_interval | REDUCE/AGG (work_per_interval) |

**MARCA — monotonía difiere a P4.5:** `pyramid_load_not_monotonic` y
`mep_load_not_monotonic_across_rounds` (familia MONOTONIC) están en `deferred` con
razón distinta: hoy el modelo de bloque captura una rampa pyramid por params
escalares (first/last), no un array `components[*].load`. Migrarlas requiere primero
un **editor multi-ejercicio de pyramid** (backlog v0.2). Quedan FUERA de P4.1–P4.4;
la gramática RESERVA el operador MONOTONIC pero no se ejercita hasta P4.5. Igual para
`emom_alternating_rotation_empty` (familia ALTERNATION, requiere exercises_rotation).

---

## 2. Las 6 familias de operadores de array

El análisis de la lógica JS hardcoded reduce las 15 reglas a **6 familias**. Cada una
es un constructo de gramática a implementar (una sub-fase P4.x):

### F1 — COUNT (cardinalidad del array)
`count(components)` → entero. `count(work_per_interval)` ídem.
Cubre: components_insufficient, variant_structure_incomplete.
Ej: `count(components) < 2`

### F2 — COUNT-WHERE (conteo condicional)
`count(components where <pred>)` → entero. El predicado opera sobre el item `c`.
Cubre: contrast_pairs_unbalanced (heavy vs explosive).
Ej: `count(components where role == 'heavy') != count(components where role == 'explosive')`

### F3 — EXISTS / ALL (cuantificadores)
`any(components where <pred>)` → bool. `all(...)` → bool (NOT any NOT, derivable).
Cubre: component_without_exercise, component_work_undefined, contrast_explosive_reps_high,
slc_component_reps_atypical, contrast_heavy_low_demand, contrast_explosive_low_demand,
emom_work_undefined.
Ej: `any(components where role == 'explosive' AND reps > 6)`

### F4 — ROLE-PRESENCE (pertenencia)
Caso especial de COUNT-WHERE > 0, pero legible. `has(components where role == 'heavy')`.
Cubre: contrast_pairing_invalid (heavy presente AND explosive presente).
Ej: `has(components where role=='heavy') AND has(components where role=='explosive')`
Decisión: NO se añade operador nuevo; `has(X) ≡ count(X) > 0`. Azúcar opcional P4.x.

### F5 — DISTINCT (cardinalidad de conjunto)
`distinct_count(components.field)` → entero (valores únicos no-nulos).
Cubre: component_exercise_duplicated (distinct_count(exercise) < count), 
slc_implement_heterogeneous (distinct_count de implemento de catálogo == 1).
Ej: `distinct_count(components.exercise) < count(components where exercise != null)`

### F6 — REDUCE/AGG (agregación con helper)
`sum(components.field)`, o helper sobre el array: `estimate_work(work_per_interval)`.
Cubre: emom_density (trabajo estimado vs intervalo). Reusa el mecanismo `_HELPER_FN`
de P3.2/P3.3 pero el helper ahora RECIBE EL ARRAY (los helpers escalar-puros de P3
recibían escalares). **MARCA:** este es el salto conceptual de P4 — helpers que
iteran. Los `estimate_*_duration` del Grupo 7 (7 reglas chipper/complex/tcc/circuit)
viven aquí pero difieren a P4.4 (la familia más pesada).

---

## 3. Sintaxis propuesta (forma canónica `when`)

Dos estilos posibles; se elige **A (funcional)** por alinearse con el preprocesado
`⟦⟧` existente y evitar parsear `[*]` con precedencia:

**A (funcional, ELEGIDO):**
```
count(components)
count(components where role == 'heavy')
any(components where role == 'explosive' AND reps > 6)
distinct_count(components.exercise)
sum(work_per_interval.duration_sec)
```
- `<agg>(<array> [where <pred>])` y `<agg>(<array>.<field>)`.
- `<array>` ∈ {components, work_per_interval} (whitelist; otro → BUILD ERROR).
- `<pred>` es una sub-cláusula `when` evaluada con el item como contexto `c`:
  reusa TODO el tokenizador escalar (operadores, AND/OR/NOT, aritmética, literales).
- Campos del item legibles en `<pred>` y en `.field`: `exercise`, `role`,
  `work_metric`, `work_value`, `reps` (espejo de compat), `load_metric`,
  `load_pct_1rm`, `load_value`. **Accesor de catálogo por item:**
  `catalog(c).mdi` / `catalog(c).implement` / `catalog(c).tpr` (análogo a
  `exercise_*` de P3.4 pero sobre el item, no sobre b.exercise).

**B (selector `[*]`, RECHAZADO para autoría):** `components[*].load` queda como
sintaxis reservada en el contrato P3.0 pero NO se usa en reglas; es ambigua para
predicados compuestos y obliga a un mini-parser de path. Se mantiene rechazada por
`_FORBIDDEN_RE` salvo dentro de las funciones de agregación de arriba.

---

## 4. Traducción a JS (patrón `⟦⟧`, sin tocar el tokenizador escalar)

Igual que `component_role(...)` y `exercise_*` se preprocesan a un JS path raw
encerrado en `⟦⟧`, los agregados se preprocesan ANTES del tokenizador:

```
count(components)
  → ⟦(b.components||[]).length⟧

count(components where role == 'heavy')
  → ⟦(b.components||[]).filter(c=>(c.role==='heavy')).length⟧

any(components where role=='explosive' AND reps>6)
  → ⟦(b.components||[]).some(c=>(c.role==='explosive')&&(Number(c.reps)>6))⟧

distinct_count(components.exercise)
  → ⟦new Set((b.components||[]).map(c=>c.exercise).filter(x=>x!=null)).size⟧

sum(work_per_interval.duration_sec)
  → ⟦(b.work_per_interval||[]).reduce((a,c)=>a+(Number(c.work_value)||0),0)⟧
```

- El `<pred>` interno se traduce con el MISMO `_when_clause_to_js`, pero con un
  contexto de item: las refs de campo (`role`, `reps`, …) mapean a `c.<campo>` en
  vez de `b.params.<campo>`. Se implementa con un flag `item_ctx` en el traductor.
- `catalog(c).mdi` → `((DATA.exercises||{})[c.exercise]||{}).mdi`.
- La agregación produce un JS path `⟦…⟧` (raw), que entra al tokenizador como un
  átomo numérico/booleano más. **El tokenizador escalar NO cambia** — sólo se añade
  un preprocesador `_preprocess_array_aggs` que corre antes y un modo `item_ctx`.

---

## 5. Frontera de tier (relajación de `_FORBIDDEN_RE`)

Hoy: `_FORBIDDEN_RE = re.compile(r"\[|fn:")`. P4 NO usa `[` (estilo A funcional),
así que `[` SIGUE prohibido (sintaxis B reservada e inerte). La frontera nueva:

- Los nombres de agregación (`count`/`any`/`all`/`has`/`distinct_count`/`sum`/
  helpers-de-array) sólo se permiten en reglas `tier: T4`. En T1–T3 → BUILD ERROR
  (igual que hoy con cualquier token no whitelisteado).
- `fn:` permanece prohibido en TODOS los tiers (los hooks de código son v3).
- `catalog(c)` sólo dentro de un `where`/`.field` de agregación T4.
- COMPILABLE_TIERS pasa de {T1,T2,T3} a {T1,T2,T3,T4}; T5 sigue reservado
  (strength data / loaded_regions no embebidos).

---

## 6. Invariantes y verificación (heredados de P3, ampliados)

- **Equivalencia obligatoria:** cada regla migrada lleva un golden de EQUIVALENCIA
  (mismo bloque → mismo flag que el hardcode) ANTES de borrar el hardcode. Patrón
  probado en P3.4 (8 goldens de equivalencia).
- **FI del compilador para cada operador nuevo:** array selector fuera de T4 →
  BUILD ERROR; `where` malformado → BUILD ERROR; array no whitelisteado
  (`count(foo)`) → BUILD ERROR; `catalog(c)` fuera de agregación → BUILD ERROR;
  predicado con token escalar inválido → BUILD ERROR (reusa la maquinaria escalar).
- **Invariante A intacto:** los 37 variants+defaults siguen limpios tras cada
  migración (las reglas T4 no deben ensuciar bloques bien formados por defecto).
- `source_digest` anti-deriva: igual que P3.
- **MARCA — sincronizador c.reps se retira por familia:** v0.2.0 mantiene `c.reps`
  espejado para que el hardcode siga vivo. A medida que P4 migra cada regla que leía
  `c.reps`, el motor pasa a leer `work_value`; cuando la ÚLTIMA regla que dependía de
  `c.reps` se migra, el sincronizador se elimina. Registrar en cada sub-fase qué
  reglas dejan de depender de él.

---

## 7. Cadencia P4.1+ (por familia, NO en una sesión)

1. **P4.1 — F1+F3+F4 (COUNT/EXISTS/ROLE-PRESENCE):** las 7-8 reglas más directas
   (component_without_exercise, contrast_pairing_invalid, contrast_explosive_reps_high,
   etc.). El núcleo del traductor de agregación + `item_ctx`.
2. **P4.2 — F2+F5 (COUNT-WHERE/DISTINCT):** contrast_pairs_unbalanced,
   component_exercise_duplicated, slc_implement_heterogeneous (+ catalog(c)).
3. **P4.3 — F6 EMOM density:** helper que itera work_per_interval (emom_density_*).
   Primer helper-sobre-array; reescribe las reglas que hoy leen el dead `reps_per_interval`.
4. **P4.4 — F6 estimación de duración:** los 7 `estimate_*_duration` (chipper/complex/
   tcc/circuit). La familia más pesada; cada uno es un reduce con el modelo de tiempo.
5. **P4.5 — MONOTONIC/ALTERNATION (reservado):** requiere editor multi-ejercicio
   pyramid + exercises_rotation. Prerequisito de UI, no de compilador.

Cada sub-fase: dimensionar (compilable-ya vs re-tier) → autorar en `rules/` →
golden de equivalencia → migrar → borrar hardcode → suite+FI+cobertura verde → cierre.

---

## 8. Decisiones que requieren confirmación de Martin (al arrancar P4.1)

- **Q1 — estilo de sintaxis:** ¿se confirma A (funcional `count(...where...)`) sobre
  B (`components[*]`)? (recomendado A).
- **Q2 — `catalog(c)` vs reusar nombre:** ¿el accesor de catálogo por item se llama
  `catalog(c).mdi` o se unifica con el `exercise_*` de P3.4? (recomendado `catalog(c)`
  explícito: el de P3.4 lee `b.exercise`, este lee el item — nombres distintos evitan
  ambigüedad).
- **Q3 — alcance P4.1:** ¿F1+F3+F4 juntas (7-8 reglas) o sólo F3 EXISTS primero
  (la más numerosa, 7 reglas) para validar el mecanismo `item_ctx` con el menor
  blast radius? (recomendado: F3 EXISTS sola como piloto, igual que T1 fue el piloto
  de P3).
