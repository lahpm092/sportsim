# V3.0 — CONTRATO del generador automático de rutinas

> Análogo a `P3_0_CONTRACT.md` / `P4_0_CONTRACT.md`. **Diseño puro: este documento NO toca
> código.** Cierra las decisiones de las que dependen las 6 sub-fases de construcción de v3.
> Lo que aquí se marca **MARCA-ARQ** es load-bearing: si Martin discrepa, redirige antes de que
> la fase correspondiente lo consuma. Lo que se marca **MARCA-FIS** es un número fisiológico
> proxy, recalibrable por Martin sin tocar arquitectura.

---

## 1. Tesis (el insight que ancla todo)

v2 es un **validador**: acotado, cada regla pass/fail, fault-injectable. v3 es un **generador**:
abierto, "output correcto" = un espacio de respuestas aceptables, no una respuesta. Lo que cierra
esa apertura: **las 91 reglas del Prescriptor SON la fitness function del generador.** Todo lo que
v3 produzca pasa por `validateBlock`/`validateSession`/`validateMacro`. La función objetivo ya
existe, está probada (849 checks) y tiene dientes (`v3_constraint:true` convierte interferencia
de warning-humano en restricción-dura-generador). Generar = construir/buscar dentro del espacio
que el validador acepta.

**Corolario:** v3 no reimplementa coherencia. La hereda. El generador propone; el validador dispone.

## 2. Paradigma de generación (MARCA-ARQ #1)

**Híbrido constructivo + gated-por-validador:**

- **Constructivo** para lo estructural-determinista: no se "busca" cuántos componentes tiene un
  contrast ni la family de una variante — la variante lo declara. El generador lee el schema y
  construye la forma correcta por construcción.
- **Guiado-por-restricción** para la calibración dura: selección de carga/reps/zona con
  `viability_level`/`zone_id` como objetivo, no como filtro a posteriori. El generador apunta al
  centro del rango canónico de la zona objetivo y ajusta.
- **El validador es SIEMPRE la compuerta final.** Sea cual sea el camino, el output se valida
  antes de emitirse. `assertCoherent(b)` envuelve cada emisión.

Rechazados: *pure-constraint* (generar candidatos al azar + filtrar) — lento, se siente a búsqueda,
mala explicabilidad. *Pure-constructive* (reglas que construyen sin validar) — duplica la lógica
del validador y arriesga deriva generar↔validar.

## 3. Arquitectura (MARCA-ARQ #2)

- **v3 EXTIENDE el Prescriptor** (decisión vigente de Martin: un solo codebase, sin repos
  externos). Nuevo "modo generar": el generador produce bloques/sesiones/macros en **forma
  canónica** (la de `newBlock()`/`applyDefaults()`) que fluyen al pipeline existente de
  validación + display. El editor v0.2.x se vuelve el editor de lo generado.
- **Lógica de generación en `generator/*.js`** (fuente autorada), concatenada al template por
  `build_prescriptor.py` vía marcador `/*__GENERATOR__*/` (igual patrón que `__COMPILED_RULES__`
  / `__ESTIMATION_HELPERS__`). NO se escribe inline en el template.
- **Tests en `tools/test_generator.js`**, encadenado al build (sin verde no hay entrega), junto
  a la suite + FI compilador + FI editor.
- **El generador consume `DATA` y `__H.*`** (mismo namespace que el motor): catálogo, zonas,
  intent_affinity, grafo de fuerza, viabilidad, clasificador de zona. NO duplica ninguno.

## 4. Interfaz generador→validador (contrato de acople)

```
genBlock(spec, profile) -> block            // canónico, pasa validateBlock con 0 breaksCoherence
genSession(slot, profile) -> {blocks:[...]}  // pasa validateSession
genMicro / genMeso / genMacro(profile) -> estructura D, pasa validateMacro
```

**Invariante de emisión (duro):** ninguna función `gen*` retorna sin antes correr el validador del
nivel correspondiente y exigir 0 flags que rompan coherencia. Si no logra coherencia en N intentos
de ajuste, retorna `{block:null, reason:[flags]}` — **falla ruidosa, nunca output incoherente.**
Esto es el equivalente generador del build-gate.

`spec` (entrada de bloque) = `{method, variant, exercise|exercises, intent, target_zone}`.
`slot` (entrada de sesión) = `{purpose, segment_focus, n_blocks, methods_allowed}`.

## 5. Schema de perfil de atleta (input primario — MARCA-ARQ #3)

El generador necesita un perfil. Hoy ausente (§7 PROJECT_STATE lo lista como PENDIENTE). Schema
mínimo v3.0 (`athlete/athlete_profile_schema.yaml`):

```yaml
athlete_profile:
  event:
    date: <ISO>                 # la única fecha inmóvil (decisión D #13)
    discipline: hyrox           # extensible
  strength:                     # e1RM de hubs (el grafo de fuerza calcula el resto)
    back_squat_e1rm: <kg>       # global_hub — ancla del motor de fuerza relativa
    <hub>_e1rm: <kg>            # opcionales; el resto se deriva por inter_hub_ratios
  conditioning:                 # HYROX-específico, opcional en v3.0
    run_1k_sec: <int>
    row_500m_sec: <int>
    ski_500m_sec: <int>
    # ... estaciones
  weak_stations: [<station_id>] # sesgo de selección hacia debilidades
  availability:
    days_per_week: <int>
    session_minutes: <int>
  landmarks:                    # MEV/MAV/MRV por grupo — MARCA-FIS, default poblado del spec C.3
    <muscle_group>: { mev:<int>, mav:<int>, mrv:<int> }
  calibration:                  # opcionales; defaults del spec
    signal_confidence: high|medium|low   # fiabilidad del reportero (C, autoreg)
    deload_style: default|volume|intensity|full   # C.5
```

**Decisión:** v3.0 NO personaliza el macro con datos reales de Martin (eso es producto, no
ingeniería). Se construye contra un **perfil de muestra** (como el macro usa fechas hipotéticas).
Personalizar es un paso de producto posterior, sin tocar el motor.

## 6. Alcance v3.0 vs diferido

- **v3.0 = generación RULE-BASED.** Los hooks plantados son lógica declarativa/procedural por
  variante (`progression_logic`) y por modelo (`week_structure_logic`). NO hay ML.
- **Diferido a v3.x: calibración data-driven por corpus.** La biblioteca de templates + instancias
  completadas como corpus de entrenamiento (MARCA §5 PROJECT_STATE) es fuente de *afinamiento
  futuro*, no dependencia de v3.0. MARCA-ARQ: el generador se diseña para que el corpus pueda
  alimentar las afinidades de selección y las magnitudes de progresión más tarde, sin rediseño.

## 7. Descomposición (orden de construcción: BOTTOM-UP)

Bottom-up porque da un artefacto válido y testeable en cada paso (disciplina "build verde antes de
avanzar"). Top-down (macro primero) se descartó: no hay nada testeable end-to-end hasta tener todo.

| Fase | Entrega | Reusa | Resuelve missing |
|---|---|---|---|
| **V3.1** | Generador de BLOQUE (piloto: `straight/default`, luego familias) | catálogo, fuerza, zona, viabilidad | — (establece el motor) |
| **V3.2** | Selección de ejercicio + sustitución (consultas catálogo + equivalencias + sesgo a débil) | grafo catálogo, equivalencias, ratios | — |
| **V3.3** | Ensamblado sesión/microciclo (flags session + microcycle_plus; interferencia con dientes) | drift, interferencia (`v3_constraint`) | — |
| **V3.4** | Andamiaje de periodización (`week_structure_logic`) | Capa D (5 modelos), landmarks, taper | — |
| **V3.5** | Motor de progresión (`progression_logic` + feedback autoreg; asimetría, deload) | Capa C | — |
| **V3.6** | Auto-clasificador de drift (los 4 flags difusos como auto-chequeo) | drift_rules | **4 drift difuso** + cierra el resto como subproducto |

Cadencia: cada fase su sub-corrida con build-gate verde antes de avanzar (modo P4/P5). Familias
dentro de V3.1 igual que P4/P5 (piloto mínimo → expandir por método).

## 8. Shift metodológico de testing (MARCA-ARQ: cambia la disciplina)

El testing deja de ser fault-injection sobre un validador. Tres modos nuevos, todos encadenados
al build:

1. **El validador ES el test.** Todo output de `gen*` debe pasar su validador de nivel con 0
   `breaksCoherence`. Es el reemplazo directo del FI: si el generador emite incoherente, falla.
2. **Goldens de caracterización.** Inputs específicos → outputs razonables específicos (p.ej.
   `genBlock({straight, back_squat, intent:max_strength, zone:Z2})` → load∈[82,90], reps∈[3,6]).
   Capturan el comportamiento esperado, no solo la coherencia.
3. **Chequeos de distribución.** Sobre N generaciones (barrido de specs): 0 flags duros, cobertura
   razonable del espacio (diversidad de ejercicios/cargas, no colapso a un punto), y **Invariante A
   del generador**: todo método×variante×zona-típica genera limpio.

## 9. Preguntas cerradas en este contrato (registro)

- **Q-paradigma:** híbrido (§2). Confirmado por delegación ("construir TODO V3 siguiendo tu orden").
- **Q-arquitectura:** extiende Prescriptor, `generator/*.js` + marcador (§3). Confirmado (un codebase).
- **Q-perfil:** schema §5, contra perfil de muestra; personalización = producto posterior.
- **Q-dirección:** bottom-up (§7). Confirmado ("seguir tu orden").
- **Q-scope:** rule-based; corpus diferido (§6).

## 10. MARCAS de arranque para V3.1

- (a) Piloto = `straight/default` 1 ejercicio: aísla el **motor de prescripción** (e1RM→load vía
  fuerza, zona objetivo→reps/load/rir/rest desde `DATA.zones`, `viability_level` como guard) sin
  la complejidad multi-componente. Luego expande familia por familia.
- (b) **Apuntar al centro del rango canónico de la zona objetivo** como política de prescripción
  default (MARCA-FIS: recalibrable — Martin puede preferir sesgo a un extremo por intent).
- (c) Carga absoluta desde e1RM: `load_kg = round(e1rm * pct/100, redondeo_a_incremento)`
  (incremento de barra MARCA-FIS, default 2.5 kg). El work_unit ya soporta `absolute_load`.
- (d) Si el atleta no declara e1RM del ejercicio, derivar vía grafo de fuerza
  (`__H.slc_weakest_*`/`_rel1rm`) desde back_squat; confianza baja → prescribir en %1RM, no en kg.

---

## 11. V3.2 — SELECCIÓN DE EJERCICIO + SUSTITUCIÓN + VARIEDAD SEMBRADA (sesión 19)

Cierra la promesa de V3.2 del §8 de PROJECT_STATE: el generador deja de reusar el ejercicio
base y SELECCIONA del catálogo embebido, con variedad gobernada y sustitución por perfil.

**Decisiones load-bearing (cerradas con Martin, sesión 19):**

1. **Variedad vía SEEDED RNG (determinismo sembrado), no `Math.random`.** El generador lleva un
   PRNG determinista (`_mulberry32`) sembrado por entero. Misma semilla → misma selección,
   siempre. Variedad real entre semillas. Resuelve la tensión "plantilla vs. generador": la
   variedad es producto, pero gobernada y reproducible.
2. **Semilla efectiva = `spec.seed ?? hash(spec)`** (default DERIVADO del spec, FNV-1a sobre el
   spec sin `seed`). Un pedido idéntico es reproducible sin pensar en semillas; pides variedad
   pasando `seed` explícito distinto. Se SELLA en el bloque (`_seed`) → regenerar reproduce.
3. **CONTRATO DE SEMILLA EN CASCADA (la respuesta a "¿cómo afecta el RNG a la progresión?").**
   La semilla se fija a nivel **mesociclo/instancia**, NO de sesión. Selección CONGELADA en el
   bloque. La progresión inter-sesión (V3.5) itera sobre selección congelada; NUNCA resiembra a
   media marcha (no recasteas a mitad de obra). Derivación `seed_bloque = hash(seed_meso, idx)`
   (`GEN.deriveSeed`), estable a través de regeneraciones. Variedad legítima SOLO en: entre
   mesociclos (resembrar — deseable fisiológicamente, varía estímulo), entre atletas, y bajo
   sustitución DIRIGIDA (no es reroll). **Eje ortogonal:** RNG gobierna la SELECCIÓN (el qué);
   la CALIBRACIÓN (zona→carga/reps/rir, política "centro del rango" de V3.1) sigue determinista.
4. **Sustitución contra `athlete_profile` (materializado en V3.2: `athlete/`).**
   - `availability.equipment` = **LISTA BLANCA** de implementos. Presente ⇒ todo implemento fuera
     queda bloqueado. El selector relaja el implemento exigido (manteniendo patrón/segmento = la
     coherencia mecánica) y reintenta → sustitución por disponibilidad.
   - `injuries` = lista de patrones/segmentos a EVITAR; ningún ejercicio de esos se selecciona.
   - `weak_stations` = SESGO: duplica en la urna los candidatos que matchean (mayor probabilidad
     sin excluir al resto). Estadístico, no determinista por bloque.

**Mecanismo (sin tocar el validador — el generador hereda coherencia):**
`_makePicker(spec, profile)` envuelve {rng sembrado, conjunto bloqueado, perfil}. `_candidates`
filtra el catálogo por {pattern/segment/implement} menos bloqueados, orden ESTABLE (alfabético,
no por inserción). `_pickOne`/`_pickN` muestrean sembrado (con/sin reemplazo). `_resolveExercise`
resuelve un rol con fallback en cascada (spec explícito → selección → relajación de implemento).
Cableado en: french_contrast (4 roles distintos), giant_set/accessory/superset/pha/ags (selección
por patrón/segmento), multi_exercise_pyramid (n distintos), mechanical_drop/pyramid (base),
heavy_light/contrast_pair (explosive del MISMO `cat_segment` que el heavy → respeta
`contrast_components_same_pattern_violated`, P5.6; balístico jump/throw/olympic_pull).

**Verificación (shift V3 — el validador ES el test):** +35 checks del generador (185→220).
INVARIANTE CRÍTICO probado: barrido 7 familias × 12 semillas = 84/84 pasan `validateBlock` con 0
breaksCoherence → **la variedad estresa la fitness function, no la debilita**. Más:
reproducibilidad (contenido idéntico, excluyendo `id` de instancia), variedad (≥3 combos/12
semillas, mep da 12/12), no-duplicación, sustitución de equipo, evasión de lesión, sesgo a
debilidad, derivación en cascada.

**MARCAS V3.2:**
- (a) **Gap de catálogo — explosivos por segmento:** solo hay 1 `jump` (box_jump, lower) y 1
  `throw` (wall_ball, full) en el seed. La variedad del explosive en contrast queda limitada por
  el catálogo, no por el generador (heavy_light de segmento lower → box_jump casi siempre). Se
  amplía cuando el seed gane más balísticos. NO es deuda del generador.
- (b) `weak_stations`/`injuries` referencian patrones/segmentos del catálogo (proxy v3.0); cuando
  exista un mapeo estación-HYROX→patrón más fino, se enriquece sin cambiar el mecanismo.
- (c) Sesgo de debilidad por duplicación-en-urna es un proxy simple; un peso explícito (k copias)
  es recalibrable (MARCA-FIS).
- (d) `athlete_profile` materializado contra perfil de MUESTRA (HYROX). Personalizar con datos
  reales de Martin sigue siendo producto, no ingeniería (decisión V3.0 intacta).
