# V4.0 — CONTRATO del modo de progresión ROTATIVO (conjugado/Westside)

> Análogo a `V3_0_CONTRACT.md`. **Diseño puro: este documento NO toca código.** Cierra las
> decisiones de las que dependen las sub-fases de construcción de V4.
> **MARCA-ARQ** = load-bearing (si Martín discrepa, redirige antes de que la fase lo consuma).
> **MARCA-FIS** = número fisiológico proxy, recalibrable por Martín sin tocar arquitectura.
> **MARCA-CATÁLOGO** = dependencia de datos del seed (grafo de equivalencias), aditiva.

Post-V3. La campaña V3 (bloque→sesión→micro→meso→macro→progresión temporal→drift difuso) quedó
COMPLETA en la sesión 24. V4 añade un SEGUNDO modo de progresión que **convive** con el lineal de
V3.5 (`GEN.progress` / `_progressBlock`), no lo reemplaza.

---

## 1. Tesis (qué problema resuelve y por qué ahora es posible)

V3.5 implementó progresión **acumulativa** sobre ejercicio **CONGELADO**: el mismo slot resuelve el
mismo ejercicio todas las semanas (corrección de la semilla por-meso, sesión 23), y la carga sube
week-over-week ("doble progresión": reps→techo→carga+reset). Esto **descartó por incoherente** un
caso real: *"no puedes subir 5% sobre la semana pasada si era otro ejercicio"*.

El modo **rotativo** rescata ese caso volviéndolo coherente bajo OTRO eje. En conjugado/Westside no
progresas sobre el ejercicio — progresas sobre el **patrón**, rotando la variante (cada 1–3 sem) PARA
evitar acomodación, y mides el avance como PR de la variante de esa semana. La pieza que lo hace
posible: el **motor de fuerza relativa P7** (`__H._rel1rm`/grafo `strength_ratio_vs`+`inter_hub_ratios`,
ya embebido en `DATA`) permite **comparar lo incomparable** — predecir el e1RM de la variante nueva
desde la conocida y medir el avance contra esa predicción. El grafo de fuerza se construyó
literalmente para esto.

**Corolario (igual que V3):** el motor rotativo NO reimplementa coherencia. Hereda la fitness function
del validador (`validateBlock`/`validateMicrocycleBlocks`); además la spec de capa C
(`adjustment_rules`, `progression_engine`) y el grafo de fuerza P7 son leídos, no reinventados.

---

## 2. Arquitectura: modo general invocable + conjugate estricto (MARCA-ARQ #1)

**Decisión (Martín):** el modo rotativo es un **modo de progresión GENERAL**, seleccionable por slot,
invocable también FUERA de `conjugate`; y `conjugate` lo usa por defecto (modo estricto).

- Nuevo campo de slot/bloque **`progression_mode ∈ {accumulative, rotational}`** (default `accumulative`
  = el de V3.5, retrocompatible: ausencia ⇒ accumulative, ningún test de V3.5 cambia).
- `conjugate` (capa D) **fija `progression_mode: rotational` por defecto** en los slots de fuerza de
  sus mesos. Pero cualquier modelo (`linear`, `block`, `concurrent_hybrid`) puede invocarlo declarándolo
  en el slot. Esto cumple "modo general + conjugate estricto" sin dos motores: **un** motor rotativo,
  invocado por defecto por conjugate y opt-in por el resto.
- Punto de inserción (ground truth verificado): `_progressBlock(block, ctx)` hace **dispatch** por
  `block.progression_mode`. El cuerpo actual de V3.5 pasa íntegro a la rama `accumulative`; se añade la
  rama `rotational` (`_progressBlockRotational`). `GEN.progress` (el bucle de semanas + acumulación de
  delta reactivo + compuerta de microciclo) se reutiliza tal cual — el modo solo cambia QUÉ hace cada
  bloque al progresar, no el andamiaje temporal.

Rechazado: un `GEN.progressRotational` separado paralelo a `GEN.progress` — duplicaría el bucle de
semanas, la acumulación de delta y la compuerta de microciclo. El dispatch por modo dentro de
`_progressBlock` es el mínimo cambio que reusa todo V3.5.

---

## 3. Los 4 parámetros de coherencia (alcance V4 = núcleo rotativo genérico)

Alcance acordado (Martín): **parámetros 1–4** (modo rotativo genérico). El **parámetro 5**
(separación ME/DE/repetition, Westside fiel) queda **DIFERIDO** a capa opcional posterior.

### Parámetro 1 — Eje de rotación (MARCA-ARQ #2)
El **patrón + intent** son el INVARIANTE; la **variante (ejercicio)** es lo ROTATIVO. Nuevo campo de
slot **`rotation_axis: variant_within_pattern`** (único valor en V4; reservado para futuros ejes).
El patrón primario del bloque se obtiene de `_blockPrimaryPattern` (ya existe, reusa
`_sessionBlockExercises`). El intent se hereda del método/zona como en V3.

### Parámetro 2 — Cadencia de rotación (MARCA-ARQ #3 + regla de coherencia con dientes)
Nuevo campo **`rotation_period_weeks`** (entero ≥1). Distingue Westside clásico (~1 sem) de conjugado
conservador (2–3 sem). La variante se mantiene fija durante `rotation_period_weeks` y rota al siguiente
bloque del pool al cumplirse.

**REGLA DE COHERENCIA (análoga a "undulating con 1 slot no ondula", V3.4):**
`rotation_period_weeks >= meso_duration_weeks` ⇒ **no hay rotación real** dentro del meso ⇒
autochequeo de construcción dispara falla ruidosa (`gen_rotational_no_rotation:<slot>`). El motor se
NIEGA a producir un "rotativo" que en la práctica congela el ejercicio (eso ya es el modo accumulative;
declarar rotational y no rotar es una mentira del constructor, no un plan inválido del usuario). Mismo
principio de autochequeo que V3.4 (`gen_meso_self_drift`).

### Parámetro 3 — Pool de rotación (MARCA-ARQ #4 + MARCA-CATÁLOGO)
El pool = variantes EQUIVALENTES en estímulo primario pero DISTINTAS (evitan acomodación).
**Fuente de pool en cascada (patrón `_resolveExercise` de V3.2):**
1. **`slot.rotation_pool` explícito** (lista de exercise_ids) si el llamador lo da → se usa tal cual.
2. **Grafo de equivalencias declarado** (`equivalence_edge` del catálogo): pool = el ejercicio base +
   sus `equivalences` de `similarity ∈ {high, medium}`. **FUENTE PREFERENTE.**
3. **Fallback de derivación implícita** (A): `_candidates` por `pattern` + `segment` compatibles con el
   intent, MENOS los bloqueados por `availability`/`injuries` del perfil. **Mecanismo BASE** (funciona
   ya, sin tocar catálogo).

**HALLAZGO del ground truth (sesión 25):** el seed tiene **0 `equivalence_edges` y 0 `variations`
declaradas** hoy. Por eso el fallback implícito (3) es lo que opera de entrada. **MARCA-CATÁLOGO:**
poblar `equivalence_edge` (con `load_translation`) es un **frente paralelo ADITIVO** — cada arista
declarada afina el pool de "ancho implícito por patrón+segmento" a "rotación verdadera de estímulo",
y alimenta directamente la precisión del Parámetro 4 (vía `load_translation`). NO es prerequisito
bloqueante: el lector de grafo se cablea desde V4.1 para que B sea aditivo, no un refactor.

**REGLA DE TAMAÑO DE POOL:** el pool necesita ≥ `N_min` variantes para sostener la cadencia sin
repetir antes de tiempo. **`N_min = ceil(meso_weeks / rotation_period_weeks) + 1`** (suficientes para
no repetir dentro del meso, +1 de margen). MARCA-FIS (proxy, recalibrable). Si el pool tiene < `N_min`,
flag `rotational_pool_insufficient` (informational — el atleta puede aceptar repetición; no es falla
dura) y el motor rota con repetición cíclica sobre lo disponible.

### Parámetro 4 — Métrica de progresión sin comparar barra-vs-barra (LA PIEZA NOVEDOSA)
El avance NO se mide como PR absoluto (incomparable entre variantes), sino como **desviación respecto
al e1RM PREDICHO** de la variante de esta semana desde la conocida de la anterior:

```
e1RM_predicho(V_b) = e1RM_observado(V_a) × ratio(V_a → V_b)
avance              = (e1RM_observado(V_b) − e1RM_predicho(V_b)) / e1RM_predicho(V_b)
```

`avance > 0` ⇒ progresó por encima de lo esperado; `≈ 0` ⇒ mantuvo (rotación neutra, esperada);
`< 0` ⇒ retroceso (señal de fatiga/regresión, no de "ejercicio más difícil").

**Fuente del `ratio(V_a → V_b)` en cascada:**
1. **`load_translation`** del `equivalence_edge` V_a→V_b si existe (dato directo, preciso).
2. **`__H._rel1rm`** de P7: `ratio = _rel1rm(V_b) / _rel1rm(V_a)` (composición por hub, confianza
   degradada). Fallback robusto cuando no hay arista directa. Ya operativo en DATA.

`e1RM_observado` se deriva del feedback (carga + reps logradas → Epley, reusando `__H.epley_inverse`
ya existente). El **avance** alimenta la decisión de progresión del SIGUIENTE bloque de ese patrón
(la asimetría §4.7 de capa C sigue vigente: frena con 1 señal, acelera con 2). La fitness function de
viability de carga (P3.3) sigue siendo la red de seguridad si la progresión saca la carga de zona
(igual que V3.5 — sin clamp duro, el validador marca).

### Parámetro 5 — ME/DE/repetition (DIFERIDO)
Separación de métodos con `progression_logic` propia (el DE progresa por velocidad/onda de carga, no
por kilos). Capa opcional posterior, solo si Martín quiere Westside fiel tras el núcleo 1–4. NO se
construye en V4.

---

## 4. Heredado de V3 sin cambios (no se reabre)

- **Contrato de semilla en cascada** (V3.2): la rotación NO resiembra al azar — el pool se ordena
  estable (alfabético, como `_candidates`) y la variante de cada periodo se elige determinísticamente
  por índice de rotación derivado de la semilla del meso. Reproducible a regeneraciones.
- **Compuerta de microciclo** (V3.3b): tras rotar+progresar, cada semana pasa por
  `validateMicrocycleBlocks`; el veto de volumen MRV sigue activo.
- **Validador = fitness function**: la rotación introduce variantes NUEVAS al bloque cada periodo →
  cada una pasa por `validateBlock`. La variedad de rotación ESTRESA la fitness function igual que la
  variedad de selección de V3.2 (invariante 84/84). Se prueba con un invariante análogo.
- **MARCA-FIS recalibrable, MARCA-ARQ load-bearing**: arquitectura = decisión de Claude; números
  (N_min, periodos, umbrales de avance) = proxy defendible recalibrable por Martín.

---

## 5. Descomposición en sub-fases (cadencia P3/P4/V3, build-gate verde entre cada una)

- **V4.0 — CONTRATO** (este documento). Diseño puro.
- **V4.1 — Cadencia + pool (params 1–3).** Dispatch `progression_mode` en `_progressBlock`;
  `_progressBlockRotational`; lector de pool en cascada (explícito→grafo→implícito); rotación
  determinista por semilla; regla de coherencia `rotation_period >= meso_duration` (autochequeo) +
  flag `rotational_pool_insufficient`. Sin métrica de avance todavía (rota y mantiene calibración base).
- **V4.2 — Métrica P7 (param 4).** Predicción de e1RM por `load_translation`→`_rel1rm`; desviación;
  decisión de progresión del siguiente periodo modulada por el avance + asimetría C. Invariante de
  rotación (la variedad pasa el validador).
- **V4.3 — Integración conjugate.** `conjugate` fija `progression_mode: rotational` por defecto en
  genMeso; el ramp genérico `_MESO_RAMP.conjugate` deja paso a la lógica rotativa real. Cierre.

Parámetro 5 (ME/DE/repetition) NO entra en V4.

---

## 6. Preguntas abiertas para V4.1 (3, estilo P-contract §8)

1. **Orden de rotación dentro del pool:** ¿secuencial estable (alfabético, índice = periodo mod |pool|)
   o ponderado por debilidad (`weak_stations`, como `_weightByWeakness` de V3.2)? Propuesta: secuencial
   estable en V4.1; ponderación como MARCA aditiva V4.x.
2. **Granularidad de `progression_mode`:** ¿por slot (todos los bloques del slot heredan el modo) o por
   bloque individual? Propuesta: por slot (un slot de fuerza ME es conceptualmente una unidad rotativa);
   el bloque lo hereda.
3. **Bloques no-escalares en modo rotativo:** EMOM/circuit (conditioning) no tienen e1RM ni rotan por
   variante de fuerza. Propuesta: el modo rotativo solo aplica a bloques con prescripción escalar
   (load+reps), igual que V3.5; los demás caen a `hold` (sin cambio). MARCA.

---

## 7. MARCA-CATÁLOGO (frente paralelo, no bloqueante)

Poblar `equivalence_edge` en el seed (con `similarity` + `load_translation`) convierte el pool de
"derivación implícita por patrón+segmento" (proxy ancho) en "rotación verdadera de estímulo" (preciso),
y da `ratio` directo al Parámetro 4. Es **calibración fisiológica de Martín** (qué variantes son
intercambiables como estímulo primario para HYROX), no arquitectura. Candidatos obvios para empezar:
pool de squat ME (back_squat ↔ front_squat ↔ overhead_squat ↔ goblet_squat con load_translation),
pool de hinge (deadlift ↔ rdl ↔ good_morning ↔ hip_thrust). Hacerlo en cualquier momento mejora V4 sin
reescribir el motor.
