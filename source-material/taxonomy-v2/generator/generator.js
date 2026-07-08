/* ===================================================================
   V3.1 — GENERADOR DE BLOQUE (motor de prescripción)
   Fuente autorada; el build la inyecta al template vía /*__GENERATOR__*​/.
   Consume DATA + __H.* + el validador (validateBlock/breaksCoherence) —
   NO duplica catálogo, zonas, fuerza ni viabilidad (contrato V3.0 §3).

   Paradigma (V3.0 §2): híbrido. Constructivo para lo estructural-determinista
   (forma del bloque desde el schema vía applyDefaults); guiado-por-restricción
   para la calibración (zona objetivo → centro del rango; viability_level guard).
   Compuerta dura (V3.0 §4): toda emisión pasa el validador y exige 0
   breaksCoherence, o falla ruidosa (block:null + reason).

   PILOTO: straight/default (params escalares load/reps/rir). Aísla el motor de
   prescripción sin complejidad multi-componente; las familias se expanden después
   (cadencia P4/P5).
   =================================================================== */

const GEN = {};
const GEN_MAX_TRIES = 8;
const GEN_LOAD_STEP = 2.5;   // MARCA-FIS: paso de relajación de carga (recalibrable)

/* zona → intent default (MARCA-FIS, recalibrable). Solo aplica si spec.intent
   no se declara. straight no tiene afinidad declarada → cualquier intent es válido. */
const ZONE_INTENT = { Z1:'max_strength', Z2:'strength', Z3:'strength',
                      Z4:'hypertrophy', Z5:'hypertrophy', Z6:'strength_endurance' };

function _mid(r){ return (r.min + r.max) / 2; }
function _zoneCenters(zid){
  const z = DATA.zones[zid]; if (!z) return null;
  // DATA.zones embebe solo reps/load/rir (decisión P3.3, para classify_zone).
  // El rest no es crítico de zona en el piloto → sale del default del schema si la
  // zona no lo trae (rest_min ausente en DATA.zones por diseño).
  return { reps: Math.round(_mid(z.reps)),
           load: Math.round(_mid(z.load_pct_1rm)),
           rir:  Math.round(_mid(z.rir)),
           rest_sec: z.rest_min ? Math.round(_mid(z.rest_min) * 60) : null };
}
/* Clamp al rango del param: prefiere canónico; si el objetivo de zona cae fuera del
   canónico pero dentro de extended, respeta el objetivo (queda informacional, no rompe). */
function _clampToParam(val, spec){
  if (!spec) return val;
  const c = spec.range_canonical, e = spec.range_extended;
  let lo = c ? c.min : (e ? e.min : val);
  let hi = c ? c.max : (e ? e.max : val);
  if (e){
    if (val < lo) lo = Math.max(e.min, val);
    if (val > hi) hi = Math.min(e.max, val);
  }
  return Math.min(Math.max(val, lo), hi);
}

/* Carga absoluta desde e1RM declarado del ejercicio (MARCA-FIS: incremento de barra).
   Si el perfil no trae e1RM, se queda en %1RM (no se inventa kg). */
function _absoluteLoad(profile, exercise, pct){
  if (!profile || !profile.strength || !exercise) return null;
  const key = exercise + '_e1rm';
  const e1rm = profile.strength[key];
  if (typeof e1rm !== 'number' || e1rm <= 0) return null;
  const step = (profile.calibration && profile.calibration.bar_increment_kg) || GEN_LOAD_STEP;
  return Math.round((e1rm * pct / 100) / step) * step;
}

/* ===================================================================
   V3.2 — SELECCIÓN DE EJERCICIO + SUSTITUCIÓN DESDE EL CATÁLOGO
   -------------------------------------------------------------------
   El generador deja de reusar el ejercicio base: selecciona ejercicios
   reales del catálogo embebido (DATA.exercises) por rol/patrón/segmento/
   implemento, con VARIEDAD gobernada por un PRNG SEMBRADO (determinismo
   reproducible) y SUSTITUCIÓN por disponibilidad/lesión contra el
   athlete_profile. La selección es el ÚNICO eje con variedad; la
   calibración (zona→carga/reps/rir) sigue determinista (V3.1).

   CONTRATO DE SEMILLA EN CASCADA (decisión Martin, sesión 19):
   - La semilla se fija a nivel mesociclo/instancia, NO de sesión.
   - seed efectiva del bloque = spec.seed ?? hash(spec)  (default derivado
     del spec → un pedido idéntico es reproducible sin pensar en semillas).
   - La selección se CONGELA en el bloque (campo _seed) → regenerar con esa
     semilla reproduce el bloque byte a byte. La progresión inter-sesión
     (V3.5) itera sobre selección congelada; NUNCA resiembra a media marcha.
   - Variedad legítima: entre mesociclos (resembrar), entre atletas, y bajo
     sustitución dirigida (no es reroll: busca el equivalente más cercano).
   =================================================================== */

const GEN_SEED_DEFAULT = 1;   // semilla canónica para goldens (spec.seed omitido en spec mínimo)

/* PRNG determinista (mulberry32). Sin dependencias. Mismo seed → misma secuencia. */
function _mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* hash determinista de string → uint32 (FNV-1a). Para derivar semilla del spec. */
function _hashStr(s){
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/* Semilla efectiva del bloque: explícita o derivada del spec (default reproducible).
   Excluye `seed` del hash para que omitirlo == derivarlo. */
function _effectiveSeed(spec){
  if (typeof spec.seed === 'number') return spec.seed >>> 0;
  const keyObj = {}; for (const k of Object.keys(spec).sort()){ if (k !== 'seed') keyObj[k] = spec[k]; }
  return _hashStr(JSON.stringify(keyObj)) || GEN_SEED_DEFAULT;
}
/* Derivación en cascada: seed de mesociclo + índice → seed de bloque estable. */
function _deriveSeed(parentSeed, index){
  return (_hashStr(String(parentSeed) + ':' + String(index))) >>> 0;
}

/* Un "Picker" envuelve el PRNG sembrado y la disponibilidad del perfil.
   Toda selección de ejercicio del bloque pasa por una única instancia →
   las elecciones quedan correlacionadas y reproducibles por la misma semilla. */
function _makePicker(spec, profile){
  const rng = _mulberry32(_effectiveSeed(spec));
  const blocked = _blockedSet(profile);   // ids no disponibles (equipo/lesión)
  return { rng, blocked, profile };
}
/* Conjunto de ejercicios NO disponibles para este atleta.
   - availability.equipment: lista BLANCA de implementos; si está, todo implemento
     fuera de ella queda bloqueado. Ausente → sin restricción de equipo.
   - injuries: lista de patrones/segmentos a evitar (p.ej. 'hinge', 'lower'). */
function _blockedSet(profile){
  const out = new Set();
  if (!profile) return out;
  const av = profile.availability || {};
  const equip = Array.isArray(av.equipment) ? new Set(av.equipment) : null;
  const inj = Array.isArray(profile.injuries) ? profile.injuries : [];
  for (const eid of Object.keys(DATA.exercises || {})){
    const e = DATA.exercises[eid] || {};
    if (equip && !equip.has(e.implement)){ out.add(eid); continue; }
    if (inj.length && (inj.indexOf(e.pattern) >= 0 || inj.indexOf(e.segment) >= 0)){ out.add(eid); }
  }
  return out;
}

/* Candidatos del catálogo que cumplen un filtro {pattern?, segment?, implement?, implementIn?}
   y NO están bloqueados. Orden ESTABLE (alfabético por id) antes de muestrear →
   reproducible independientemente del orden de inserción del objeto. */
function _candidates(picker, filter){
  filter = filter || {};
  const ids = Object.keys(DATA.exercises || {}).filter(eid => {
    if (picker.blocked.has(eid)) return false;
    const e = DATA.exercises[eid] || {};
    if (filter.pattern && e.pattern !== filter.pattern) return false;
    if (filter.segment && e.segment !== filter.segment) return false;
    if (filter.implement && e.implement !== filter.implement) return false;
    if (filter.implementIn && filter.implementIn.indexOf(e.implement) < 0) return false;
    if (filter.exclude && filter.exclude.indexOf(eid) >= 0) return false;
    return true;
  });
  ids.sort();
  return ids;
}
/* Sesgo hacia estaciones débiles (weak_stations): si un candidato matchea una
   debilidad declarada, se duplica en la urna → mayor probabilidad sin excluir al resto.
   weak_stations referencia patrones/segmentos del catálogo (proxy v3.0). */
function _weightByWeakness(picker, ids){
  const weak = (picker.profile && Array.isArray(picker.profile.weak_stations))
    ? picker.profile.weak_stations : [];
  if (!weak.length) return ids;
  const urn = [];
  for (const eid of ids){
    const e = DATA.exercises[eid] || {};
    urn.push(eid);
    if (weak.indexOf(e.pattern) >= 0 || weak.indexOf(e.segment) >= 0) urn.push(eid);
  }
  return urn;
}
/* Elige UN id de una lista de candidatos, sembrado. Devuelve null si vacía. */
function _pickOne(picker, ids){
  const urn = _weightByWeakness(picker, ids);
  if (!urn.length) return null;
  const i = Math.floor(picker.rng() * urn.length);
  return urn[Math.min(i, urn.length - 1)];
}
/* Elige N ids DISTINTOS, sembrado (muestreo sin reemplazo sobre candidatos únicos). */
function _pickN(picker, ids, n){
  const pool = ids.slice();
  const out = [];
  while (out.length < n && pool.length){
    const choice = _pickOne(picker, pool);
    if (choice == null) break;
    out.push(choice);
    const idx = pool.indexOf(choice);
    if (idx >= 0) pool.splice(idx, 1);
  }
  return out;
}

/* Resolución de UN ejercicio para un rol/filtro, con fallback en cascada:
   1) si el spec lo fijó explícitamente Y no está bloqueado → respétalo
   2) selección sembrada entre candidatos del filtro
   3) si el filtro no deja candidatos (p.ej. implemento exigido + equipo bloqueado),
      relaja el implemento y reintenta (sustitución por disponibilidad)
   Devuelve {id, substituted} o {id:null} si genuinamente no hay candidato. */
function _resolveExercise(picker, filter, explicit){
  if (explicit && !picker.blocked.has(explicit)) return { id: explicit, substituted: false };
  let ids = _candidates(picker, filter);
  if (ids.length) return { id: _pickOne(picker, ids), substituted: !!explicit };
  // Sustitución: relaja implemento manteniendo patrón/segmento (la coherencia mecánica).
  if (filter.implement || filter.implementIn){
    const relaxed = Object.assign({}, filter); delete relaxed.implement; delete relaxed.implementIn;
    ids = _candidates(picker, relaxed);
    if (ids.length) return { id: _pickOne(picker, ids), substituted: true };
  }
  return { id: null, substituted: false };
}
/* Sella la semilla efectiva en el bloque para reproducibilidad (congelación). */
function _stampSeed(b, spec){ b._seed = _effectiveSeed(spec); return b; }

/* ---- compuerta dura: validar + relajación mínima + falla ruidosa ---- */
function _relax(b, breakIds){
  // Heurística mínima del piloto (MARCA-FIS): mover carga hacia la coherencia.
  // Escalar (straight): toca b.params.load_pct_1rm.
  if (typeof b.params.load_pct_1rm === 'number'){
    if (breakIds.some(id => /load_too_high|overprescribed/.test(id))){
      b.params.load_pct_1rm -= GEN_LOAD_STEP; return true;
    }
    if (breakIds.some(id => /underloaded/.test(id))){
      b.params.load_pct_1rm += GEN_LOAD_STEP; return true;
    }
  }
  // Multi-componente (contrast): la carga vive en cada work_unit por rol.
  // V3.1.1 — relajación dirigida por rol hacia las ventanas PAP del flag viability:
  //   heavy load_too_low → +step ; heavy load_too_high → −step ; explosive load_too_high → −step.
  const comps = Array.isArray(b.components) ? b.components : null;
  if (comps){
    let moved = false;
    for (const c of comps){
      if (c.load_metric !== 'percent_1rm' || typeof c.load_pct_1rm !== 'number') continue;
      if (c.role === 'heavy'){
        if (breakIds.some(id => /contrast_heavy_load_too_low/.test(id))){ c.load_pct_1rm += GEN_LOAD_STEP; moved = true; }
        else if (breakIds.some(id => /contrast_heavy_load_too_high/.test(id))){ c.load_pct_1rm -= GEN_LOAD_STEP; moved = true; }
      } else if (c.role === 'explosive'){
        if (breakIds.some(id => /contrast_explosive_load_too_high/.test(id))){ c.load_pct_1rm -= GEN_LOAD_STEP; moved = true; }
      }
    }
    if (moved) return true;
  }
  // V3.1.5 — circuitos/emom: la carga vive en work_per_interval / exercises_rotation /
  // components de tabata. Si una densidad/carga rompe, bajar la carga de esos work_units.
  const wuArrays = [b.work_per_interval, b.exercises_rotation];
  if (b.variant === 'tabata') wuArrays.push(b.components);
  if (breakIds.some(id => /load_too_high|exceeds_interval|exceeds_1rm|terminal_load_too_high|tabata_load_too_high/.test(id))){
    let moved = false;
    for (const arr of wuArrays){
      if (!Array.isArray(arr)) continue;
      for (const c of arr){
        if (c.load_metric === 'percent_1rm' && typeof c.load_pct_1rm === 'number'){
          c.load_pct_1rm -= GEN_LOAD_STEP; moved = true;
        }
      }
    }
    // ascending_load: bajar también el param de bloque starting_load
    if (typeof b.params.starting_load_pct_1rm === 'number'){
      b.params.starting_load_pct_1rm -= GEN_LOAD_STEP; moved = true;
    }
    if (moved) return true;
  }
  return false;
}
function _emit(b){
  for (let t = 0; t < GEN_MAX_TRIES; t++){
    const flags  = validateBlock(b, 0);
    const breaks = flags.filter(breaksCoherence);
    if (breaks.length === 0){
      const viab = flags.filter(isViabWarn);
      return { block: b, flags, ok: true, clean: viab.length === 0 };
    }
    if (!_relax(b, breaks.map(f => f.id))) break;
  }
  const flags = validateBlock(b, 0);
  return { block: null, flags, ok: false,
           reason: flags.filter(breaksCoherence).map(f => f.id) };
}

/* ---- generador ESCALAR (arquetipo monolítico: straight + cluster + drop + rest_pause + amrap) ----
   V3.1.3 — generaliza el piloto straight/default. Estos métodos NO tienen components[]:
   su prescripción es escalar. Solo `load_pct_1rm` se calibra desde la zona objetivo; los
   params de IDENTIDAD del método (reps_per_cluster, drop_pct_per_drop, activation_reps_target,
   time_cap_sec, etc.) se dejan en el DEFAULT del schema, ya validado limpio por Invariante A.
   El cuerpo es idéntico al piloto: setea los cores escalares que existan en el schema y deja
   que la compuerta valide. La afinidad zona↔método NO se reimplementa aquí: si el centro de
   zona clampa en rango y el bloque pasa, se emite; el drift de afinidad (informacional) anota
   cualquier desajuste sin bloquear — mismo criterio que straight. */
function _genScalar(spec, profile){
  const b = newBlock();
  b.method  = spec.method;
  b.variant = spec.variant;
  applyDefaults(b);                                  // forma canónica + family + defaults del schema
  b.exercise = spec.exercise || null;
  b.intent_declared = spec.intent || ZONE_INTENT[spec.target_zone] || '';

  // Prescripción escalar desde la zona objetivo.
  const zc = _zoneCenters(spec.target_zone);
  const ps = (variantOf(b).params_schema) || {};
  if (zc){
    if ('load_pct_1rm' in ps) b.params.load_pct_1rm = _clampToParam(zc.load, ps.load_pct_1rm);
    if ('reps_target'  in ps) b.params.reps_target  = _clampToParam(zc.reps, ps.reps_target);
    if ('rir_target'   in ps) b.params.rir_target   = _clampToParam(zc.rir,  ps.rir_target);
    if ('rest_inter_set_sec' in ps && zc.rest_sec)
      b.params.rest_inter_set_sec = _clampToParam(zc.rest_sec, ps.rest_inter_set_sec);
    b.zone = spec.target_zone;
  }

  // Carga absoluta si el perfil la habilita (no rompe nada si no; %1RM es la prescripción base).
  const abs = _absoluteLoad(profile, b.exercise, b.params.load_pct_1rm);
  if (abs != null) b._prescribed_load_kg = abs;     // anotación; el work_unit absoluto llega con multi-componente

  return _emit(b);
}

/* ---- generador multi-componente: contrast/heavy_light (V3.1.1) ----
   Primera familia multi-componente. La forma del bloque (2 componentes heavy+explosive)
   es determinista por la variante (work_unit_extension role enum [heavy, explosive],
   exercise_count_rule_override 2/2). La calibración es guiada-por-restricción hacia las
   VENTANAS PAP que declaran los flags viability:
     · heavy   load_pct_1rm ∈ [80,95]  (contrast_heavy_load_too_low/_high)
     · explosive load_pct_1rm ≤ 60      (contrast_explosive_load_too_high)
     · transición ≥ 15s (structural_hard) — el default del schema (45s) ya cae en rango.
   El explosive usa reps de potencia (≤6, evita contrast_explosive_reps_high informacional).

   MARCA-FIS (recalibrable): centros de ventana heavy=87 / explosive=40; reps heavy desde
   zona, explosive=3. El piloto NO selecciona el ejercicio explosive automáticamente
   (eso es V3.2, selección+catálogo): lo toma del spec (explosive_exercise) o, si falta,
   reusa el heavy (válido estructuralmente; MDI bajo es informacional, no rompe). */
const CONTRAST_HEAVY_CENTER = 87;     // MARCA-FIS: centro de la ventana PAP heavy [80,95]
const CONTRAST_EXPLOSIVE_LOAD = 40;   // MARCA-FIS: carga explosive (≤60, velocidad)
const CONTRAST_EXPLOSIVE_REPS = 3;    // MARCA-FIS: reps de potencia (≤6)

function _newComp(role, exercise, load_pct, reps){
  const c = newWorkUnit();
  c.role = role;
  c.exercise = exercise || null;
  c.work_metric = 'reps';
  c.work_value = reps;
  c.load_metric = 'percent_1rm';
  c.load_pct_1rm = load_pct;
  return c;
}
function _genContrastHeavyLight(spec, profile){
  const b = newBlock();
  b.method  = spec.method;       // 'contrast'
  b.variant = spec.variant;      // 'heavy_light'
  applyDefaults(b);              // params escalares (total_pairs, transition_rest_sec, rest_inter_pair_sec) + family
  b.intent_declared = spec.intent || 'potentiation';   // intent canónico del método (intent_resolution.default)

  const zc = _zoneCenters(spec.target_zone);
  // heavy: reps desde la zona objetivo (clampado a ≤6 — es trabajo de fuerza, no metabólico),
  // carga centrada en la ventana PAP. El heavy respeta spec.exercise (su carga es la prescrita);
  // si falta, selección sembrada de un patrón pesado (squat default).
  const picker = _makePicker(spec, profile);
  const heavyReps = zc ? Math.min(Math.max(zc.reps, 1), 6) : 3;
  const heavyEx = _resolveExercise(picker, {pattern: (spec.pattern || 'squat')}, spec.exercise).id;
  // V3.2: el explosive debe estar en el MISMO cat_segment que el heavy
  // (contrast_components_same_pattern_violated, P5.6) y ser balístico (jump/throw/olympic_pull).
  // Si no hay balístico de ese segmento en el catálogo, reusa el heavy (seguro, informacional).
  const heavySeg = (DATA.exercises[heavyEx] || {}).segment;
  const explCands = _candidates(picker, {segment: heavySeg, exclude: [heavyEx]})
                      .filter(eid => ['jump','throw','olympic_pull'].indexOf((DATA.exercises[eid]||{}).pattern) >= 0);
  const explEx = spec.explosive_exercise
                 || (explCands.length ? _pickOne(picker, explCands) : heavyEx);
  const heavy = _newComp('heavy', heavyEx, CONTRAST_HEAVY_CENTER, heavyReps);
  const explosive = _newComp('explosive', explEx, CONTRAST_EXPLOSIVE_LOAD, CONTRAST_EXPLOSIVE_REPS);
  b.components = [heavy, explosive];
  if (spec.target_zone) b.zone = spec.target_zone;

  // Carga absoluta del heavy si el perfil la habilita (anotación; el work_unit ya lleva %1RM).
  const abs = _absoluteLoad(profile, heavy.exercise, heavy.load_pct_1rm);
  if (abs != null) b._prescribed_load_kg = abs;

  _stampSeed(b, spec);
  return _emit(b);
}

/* ---- generador: contrast/french_contrast (V3.1.2) ----
   4 componentes en ORDEN CANÓNICO estricto (french_contrast_roles_order_wrong, hard):
     [heavy_strength, heavy_plyo, loaded_explosive, unloaded_plyo].
   Las flags de carga heavy/explosive son INERTES aquí (bind a component_role('heavy'/'explosive'),
   roles que french_contrast no usa → component_role devuelve {} → load_pct undefined → guard != null falso).
   La disciplina de carga la lleva la SEMÁNTICA de cada rol, no un flag:
     · heavy_strength: cargado, ventana de fuerza (MARCA-FIS 85%)
     · heavy_plyo / unloaded_plyo: pliométrico → load_metric bodyweight (sin %1RM)
     · loaded_explosive: carga moderada-baja (MARCA-FIS 40%)
   reps de potencia en todos (≤6 evita informacionales de power range). */
const FC_CANON_ROLES = ['heavy_strength','heavy_plyo','loaded_explosive','unloaded_plyo'];
const FC_PLAN = {  // MARCA-FIS: cargas/reps por rol (recalibrables)
  heavy_strength:  { load_metric:'percent_1rm', load_pct:85, reps:3 },
  heavy_plyo:      { load_metric:'bodyweight',  load_pct:null, reps:3 },
  loaded_explosive:{ load_metric:'percent_1rm', load_pct:40, reps:3 },
  unloaded_plyo:   { load_metric:'bodyweight',  load_pct:null, reps:5 }
};
function _fcComp(role, exercise){
  const p = FC_PLAN[role];
  const c = newWorkUnit();
  c.role = role;
  c.exercise = exercise || null;
  c.work_metric = 'reps';
  c.work_value = p.reps;
  c.load_metric = p.load_metric;
  c.load_pct_1rm = p.load_pct;     // null para bodyweight (el editor no muestra input de carga ahí)
  return c;
}
function _genFrenchContrast(spec, profile){
  const b = newBlock();
  b.method  = 'contrast';
  b.variant = 'french_contrast';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'potentiation';
  // V3.2: selección sembrada por rol. heavy_strength = patrón pesado (squat default),
  // heavy_plyo/unloaded_plyo = jump, loaded_explosive = olympic_pull. spec.exercises (si
  // viene, alineado a FC_CANON_ROLES) tiene prioridad. Distintos por rol → no más duplicado.
  const picker = _makePicker(spec, profile);
  const exs = Array.isArray(spec.exercises) ? spec.exercises : null;
  const FC_FILTER = { heavy_strength:{pattern:(spec.pattern||'squat')}, heavy_plyo:{pattern:'jump'},
                      loaded_explosive:{pattern:'olympic_pull'}, unloaded_plyo:{pattern:'jump'} };
  b.components = FC_CANON_ROLES.map((role, i) => {
    const explicit = (exs && exs[i]) || (i === 0 ? spec.exercise : null);
    const r = _resolveExercise(picker, FC_FILTER[role] || {}, explicit);
    return _fcComp(role, r.id);
  });
  if (spec.target_zone) b.zone = spec.target_zone;

  const heavy = b.components[0];
  const abs = _absoluteLoad(profile, heavy.exercise, heavy.load_pct_1rm);
  if (abs != null) b._prescribed_load_kg = abs;

  _stampSeed(b, spec);
  return _emit(b);
}


/* ---- API pública del nivel bloque (router por método/variante) ----
   spec: {method, variant, exercise, intent, target_zone, explosive_exercise, exercises}
   profile: athlete_profile (opcional; habilita carga absoluta) */
/* ---- generador SINGLE-LOAD-CHAIN: complex/olympic_complex (V3.1.4) ----
   Arquetipo de cadena de carga compartida. Restricciones duras de la fitness function:
     · 3-6 componentes, mismo IMPLEMENTO (slc_implement_heterogeneous) → todos barbell.
     · carga NO divergente entre componentes (slc_components_have_independent_loads):
       la carga vive en el param de bloque shared_load_pct_1rm_of_weakest, NO por componente
       → cada work_unit con load_metric 'none' / load_pct_1rm null (distinct_count de nulls = 0).
     · rest_between_components_sec ≤ 10 (default 2, ok).
   Viability (calidad, no rompe pero se evita):
     · orden técnico seguro (slc_component_order_technically_unsafe): el primer componente con
       TCI ≥ avg del resto → se ORDENAN por TCI de catálogo descendente (lo más técnico primero).
     · shared_load ≤ 85 (slc_load_exceeds_weakest_link): el centro de zona se clampa a [55,80].
   reps de potencia olímpica (≤6 evita slc_component_reps_atypical informacional). */
const OLY_CHAIN_DEFAULT = ['power_clean','front_squat','push_press']; // barbell, TCI desc (7.0/5.5/5.0)
const OLY_CHAIN_REPS = 3;   // MARCA-FIS: reps de potencia olímpica (recalibrable)

function _slcComp(exercise, reps){
  const c = newWorkUnit();
  c.exercise = exercise || null;
  c.work_metric = 'reps';
  c.work_value = reps;
  c.load_metric = 'none';      // la carga es compartida a nivel de bloque (shared_load_pct_1rm_of_weakest)
  c.load_pct_1rm = null;
  return c;
}
function _genSingleLoadChain(spec, profile){
  const b = newBlock();
  b.method  = 'complex';
  b.variant = 'olympic_complex';
  applyDefaults(b);            // family=single_load_chain + total_rounds/rest defaults + shared_load default
  b.intent_declared = spec.intent || 'power';

  // ejercicios: del spec o la cadena olímpica default; ORDENAR por TCI de catálogo descendente.
  let chain = (Array.isArray(spec.exercises) && spec.exercises.length >= 3)
              ? spec.exercises.slice() : OLY_CHAIN_DEFAULT.slice();
  chain.sort((a,bb) => {
    const ta = ((DATA.exercises||{})[a]||{}).tci || 0;
    const tb = ((DATA.exercises||{})[bb]||{}).tci || 0;
    return tb - ta;   // descendente: más técnico primero
  });
  b.components = chain.map(ex => _slcComp(ex, OLY_CHAIN_REPS));

  // carga compartida desde la zona objetivo, clampada al rango del param (≤85 ⇒ no excede weakest link).
  const zc = _zoneCenters(spec.target_zone);
  const ps = (variantOf(b).params_schema) || {};
  if (zc && 'shared_load_pct_1rm_of_weakest' in ps)
    b.params.shared_load_pct_1rm_of_weakest = _clampToParam(zc.load, ps.shared_load_pct_1rm_of_weakest);
  if (spec.target_zone) b.zone = spec.target_zone;

  return _emit(b);
}


/* ============================================================
   V3.1.6 — PARES RESTANTES (contrast/wave_contrast, contrast/complex_pairs)
   Extensión del arquetipo de pares: 2 componentes heavy+explosive. Fitness function
   compartida (contrast_roles_inconsistent_with_variant) exige ≥1 heavy Y ≥1 explosive;
   contrast_components_same_pattern exige mismo cat_segment → reusar el mismo ejercicio. */
function _genContrastPair(spec, profile){
  const b = newBlock();
  b.method  = 'contrast';
  b.variant = spec.variant;          // wave_contrast | complex_pairs
  applyDefaults(b);
  b.intent_declared = spec.intent || 'potentiation';

  const zc = _zoneCenters(spec.target_zone);
  const heavyReps = zc ? Math.min(Math.max(zc.reps, 1), 6) : 3;
  // V3.2: misma lógica de selección que heavy_light — explosive balístico del mismo cat_segment.
  const picker = _makePicker(spec, profile);
  const heavyEx = _resolveExercise(picker, {pattern: (spec.pattern || 'squat')}, spec.exercise).id;
  const heavySeg = (DATA.exercises[heavyEx] || {}).segment;
  const explCands = _candidates(picker, {segment: heavySeg, exclude: [heavyEx]})
                      .filter(eid => ['jump','throw','olympic_pull'].indexOf((DATA.exercises[eid]||{}).pattern) >= 0);
  const explEx = spec.explosive_exercise
                 || (explCands.length ? _pickOne(picker, explCands) : heavyEx);
  const heavy = _newComp('heavy', heavyEx, CONTRAST_HEAVY_CENTER, heavyReps);
  const explosive = _newComp('explosive', explEx, CONTRAST_EXPLOSIVE_LOAD, CONTRAST_EXPLOSIVE_REPS);
  b.components = [heavy, explosive];
  if (spec.target_zone) b.zone = spec.target_zone;

  const abs = _absoluteLoad(profile, heavy.exercise, heavy.load_pct_1rm);
  if (abs != null) b._prescribed_load_kg = abs;
  _stampSeed(b, spec);
  return _emit(b);
}


/* ============================================================
   V3.1.7 — SINGLE-LOAD-CHAIN RESTANTES (strongman/kb_flow/mace_flow)
   Mismo arquetipo que olympic_complex: implemento homogéneo, carga compartida a nivel
   bloque, cada work_unit load_metric 'none'/null, orden por TCI descendente. Gaps de
   catálogo (mace sin ejercicios, strongman sin tríada homogénea en el seed) → falla ruidosa. */
const SLC_CHAINS = {   // MARCA-FIS: cadenas default por variante (implemento homogéneo)
  strongman_complex: ['farmers_carry','sled_push','sled_pull'],
  kb_flow:           ['kb_clean','kb_front_squat_double','kb_press_single_arm'],
  mace_flow:         []   // gap de catálogo: sin ejercicios de mace
};
function _chainImplementsHomogeneous(chain){
  const imps = chain.map(ex => ((DATA.exercises||{})[ex]||{}).implement).filter(Boolean);
  return imps.length === chain.length && new Set(imps).size === 1;
}
function _genSlcVariant(spec, profile){
  const variant = spec.variant;
  let chain = (Array.isArray(spec.exercises) && spec.exercises.length >= 3)
              ? spec.exercises.slice() : (SLC_CHAINS[variant] || []).slice();
  if (chain.length < 3)
    return { block: null, flags: [], ok: false,
             reason: ['gen_catalog_gap:complex/' + variant + ':no_homogeneous_chain'] };
  if (!_chainImplementsHomogeneous(chain))
    return { block: null, flags: [], ok: false,
             reason: ['gen_catalog_gap:complex/' + variant + ':heterogeneous_implement'] };

  const b = newBlock();
  b.method = 'complex'; b.variant = variant;
  applyDefaults(b);
  b.intent_declared = spec.intent || 'power';
  chain.sort((a,bb) => (((DATA.exercises||{})[bb]||{}).tci||0) - (((DATA.exercises||{})[a]||{}).tci||0));
  b.components = chain.map(ex => _slcComp(ex, OLY_CHAIN_REPS));

  const ps = (variantOf(b).params_schema) || {};
  const zc = _zoneCenters(spec.target_zone);
  if ('shared_load_pct_1rm_of_weakest' in ps && zc)
    b.params.shared_load_pct_1rm_of_weakest = _clampToParam(zc.load, ps.shared_load_pct_1rm_of_weakest);
  // kb_flow/mace_flow: shared_load_kg absoluto se deja en el default del schema.
  if (spec.target_zone) b.zone = spec.target_zone;
  return _emit(b);
}


/* ============================================================
   V3.1.8 — MULTI-COMPONENTE POR SEGMENTO (giant_set, accessory_complex, superset,
   peripheral_heart_action, antagonist_giant_set). components[] con campos de catálogo. */
function _exsByPattern(pat){
  return Object.keys(DATA.exercises||{}).filter(e => (DATA.exercises[e]||{}).pattern === pat);
}
function _exsBySegment(seg){
  return Object.keys(DATA.exercises||{}).filter(e => (DATA.exercises[e]||{}).segment === seg);
}
function _bwComp(exercise, reps, role){
  const c = newWorkUnit();
  c.exercise = exercise || null;
  c.role = role || '';
  c.work_metric = 'reps';
  c.work_value = reps;
  c.load_metric = 'bodyweight';   // carga corporal: evita las flags de progresión de %1RM
  c.load_pct_1rm = null;
  return c;
}
const GIANT_REPS = 12;   // MARCA-FIS

function _genGiantSet(spec, profile){
  const b = newBlock();
  b.method = 'complex'; b.variant = 'giant_set';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  // mismo movement_pattern → distinct_count(cat_pattern)==1. V3.2: selección sembrada de 3
  // ejercicios distintos del patrón (no slice por orden de inserción), respetando bloqueos.
  const picker = _makePicker(spec, profile);
  const pat = spec.pattern || 'squat';
  let exs = (Array.isArray(spec.exercises) && spec.exercises.length >= 2) ? spec.exercises.slice() : null;
  if (!exs){
    exs = _pickN(picker, _candidates(picker, {pattern: pat}), 3);
    if (exs.length < 2) exs = _pickN(picker, _candidates(picker, {pattern: 'squat'}), 3);
  }
  // target_muscle_group es REQUIRED (sin default en schema). Derivar del patrón/segmento.
  // MARCA-FIS: mapeo patrón→músculo target (recalibrable).
  const PAT_MUSCLE = { squat:'quadriceps', hinge:'glutes', push_h:'pectorals', push_v:'lateral_deltoid',
                       pull_h:'upper_back', pull_v:'lats', lunge:'quadriceps', elbow_flexion:'biceps',
                       elbow_extension:'triceps', calf_raise:'calves' };
  b.params.target_muscle_group = spec.target_muscle_group || PAT_MUSCLE[pat] || 'full_body';
  b.components = exs.map(ex => _bwComp(ex, GIANT_REPS));
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}
function _genAccessoryOrSuperset(spec, profile){
  const b = newBlock();
  b.method = 'complex'; b.variant = spec.variant;   // accessory_complex | superset
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  const picker = _makePicker(spec, profile);
  let exs = (Array.isArray(spec.exercises) && spec.exercises.length >= 2) ? spec.exercises.slice()
            : _pickN(picker, _candidates(picker, {segment: 'upper'}), 2);
  b.components = exs.map(ex => _bwComp(ex, GIANT_REPS));
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}
function _genPHA(spec, profile){
  const b = newBlock();
  b.method = 'complex'; b.variant = 'peripheral_heart_action';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'strength_endurance';
  // alternancia strict_upper_lower: upper, lower, upper, lower. V3.2: selección sembrada
  // distinta por slot, manteniendo la alternancia de segmento (pha_alternation_pattern_violated).
  const picker = _makePicker(spec, profile);
  let exs;
  if (Array.isArray(spec.exercises) && spec.exercises.length >= 2){
    exs = spec.exercises.slice();
  } else {
    const up = _pickN(picker, _candidates(picker, {segment: 'upper'}), 2);
    const lo = _pickN(picker, _candidates(picker, {segment: 'lower'}), 2);
    exs = [up[0], lo[0], up[1], lo[1]].filter(Boolean);
  }
  b.components = exs.map(ex => _bwComp(ex, GIANT_REPS));
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}
function _genAGS(spec, profile){
  const b = newBlock();
  b.method = 'complex'; b.variant = 'antagonist_giant_set';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  const pairsCount = Number(b.params.pairs_count) || 2;
  const ANTAG = [['push_h','pull_h'], ['push_v','pull_v'], ['squat','hinge']];  // MARCA-FIS: oposiciones articulares
  const picker = _makePicker(spec, profile);
  const comps = [];
  for (let p = 0; p < pairsCount; p++){
    const [pa, pb] = ANTAG[p % ANTAG.length];
    const exA = (spec.exercises && spec.exercises[p*2])   || _resolveExercise(picker, {pattern: pa}, null).id;
    const exB = (spec.exercises && spec.exercises[p*2+1]) || _resolveExercise(picker, {pattern: pb}, null).id;
    const cA = _bwComp(exA, GIANT_REPS); cA.pair_index = p; cA.role_in_pair = 'agonist';
    const cB = _bwComp(exB, GIANT_REPS); cB.pair_index = p; cB.role_in_pair = 'antagonist';
    comps.push(cA, cB);
  }
  b.components = comps;
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}

/* Router del grupo multi-componente complex (V3.1.6–V3.1.8). */
const SLC_VARIANT_SET = ['strongman_complex','kb_flow','mace_flow'];
function _genComplexMultiComp(spec, profile){
  if (spec.method === 'complex'){
    if (SLC_VARIANT_SET.indexOf(spec.variant) >= 0) return _genSlcVariant(spec, profile);
    if (spec.variant === 'giant_set') return _genGiantSet(spec, profile);
    if (spec.variant === 'accessory_complex' || spec.variant === 'superset') return _genAccessoryOrSuperset(spec, profile);
    if (spec.variant === 'peripheral_heart_action') return _genPHA(spec, profile);
    if (spec.variant === 'antagonist_giant_set') return _genAGS(spec, profile);
  }
  if (spec.method === 'contrast' && (spec.variant === 'wave_contrast' || spec.variant === 'complex_pairs'))
    return _genContrastPair(spec, profile);
  return null;
}


/* ---- ARQUETIPO CIRCUITOS / EMOM (V3.1.5) ----
   Cuarto arquetipo de generación: bloques cuyo trabajo vive en un array de work_units
   recorrido en intervalos/rondas (work_per_interval, exercises_rotation, components de
   circuito). NO es prescripción escalar (la carga no centra una zona): la fitness function
   son las flags de DENSIDAD/DURACIÓN, no de zona. La calibración es guiada-por-restricción
   hacia los rangos que esas flags declaran.

   Modelo de tiempo heredado del validador (NO se reimplementa): __H.estimate_work_duration
   suma tpr×reps (tpr default 3) para units de reps, o duration_sec directo. Las constantes
   de abajo se eligen para caer dentro de las ventanas de densidad/duración del validador;
   son MARCA-FIS recalibrables.

   Sub-familias:
     · EMOM single-exercise (every_minute / every_n_seconds): 1 work_unit en work_per_interval.
       Densidad de trabajo ∈ (20%, 85%) del interval (emom_work_too_light / _exceeds_interval).
     · EMOM alternating: ≥2 work_units en exercises_rotation (emom_alternating_rotation_empty).
     · EMOM ascending_load: starting + increment tal que el terminal ≤ 95% (emom_ascending_*).
     · Circuitos (fixed_round / time_capped / chipper / tabata): components con work_value;
       duración estimada coherente con el target/cap; tabata load ≤ 50%; chipper bajo el cap. */

const EMOM_REPS = 5;          // MARCA-FIS: tpr(3)×5 = 15s ≈ 25% de interval 60s (∈ ventana 20–85%)
const EMOM_LOAD_PCT = 65;     // MARCA-FIS: carga moderada típica de EMOM (calidad sostenible)
const CIRCUIT_REPS = 12;      // MARCA-FIS: reps metabólicas de circuito
const TABATA_LOAD_PCT = 40;   // MARCA-FIS: ≤50% (tabata_load_too_high_for_duration)
const CHIPPER_REPS_RAMP = [30, 25, 20, 15];  // MARCA-FIS: no-creciente (chipper_reps_progression_unusual)

/* work_unit de intervalo/circuito por reps + carga %1RM. role vacío (no aplica en circuitos). */
function _intervalComp(exercise, reps, loadPct){
  const c = newWorkUnit();
  c.exercise = exercise || null;
  c.work_metric = 'reps';
  c.work_value = reps;
  if (typeof loadPct === 'number'){ c.load_metric = 'percent_1rm'; c.load_pct_1rm = loadPct; }
  else { c.load_metric = 'bodyweight'; c.load_pct_1rm = null; }
  return c;
}

/* EMOM single-exercise: every_minute / every_n_seconds. Un work_unit en work_per_interval. */
function _genEmomSingle(spec, profile){
  const b = newBlock();
  b.method = 'emom'; b.variant = spec.variant;
  applyDefaults(b);
  b.intent_declared = spec.intent || 'strength_endurance';
  // densidad calibrada al interval: reps tales que tpr×reps ∈ (0.2,0.85)*interval.
  // El default del schema ya es coherente; reescribimos con la constante MARCA-FIS y
  // ajustamos si el interval del schema no es 60s (every_n_seconds default 90).
  const interval = Number(b.params.interval_sec) || 60;
  const tpr = ((DATA.exercises || {})[spec.exercise] || {}).tpr || 3;
  // objetivo ~40% de densidad → reps = round(0.4*interval / tpr), clamp a ≥1
  let reps = Math.max(1, Math.round(0.4 * interval / tpr));
  b.work_per_interval = [ _intervalComp(spec.exercise || null, reps, EMOM_LOAD_PCT) ];
  if (spec.target_zone) b.zone = spec.target_zone;
  const abs = _absoluteLoad(profile, spec.exercise, EMOM_LOAD_PCT);
  if (abs != null) b._prescribed_load_kg = abs;
  return _emit(b);
}

/* EMOM alternating: ≥2 work_units en exercises_rotation (rota ejercicios por intervalo). */
function _genEmomAlternating(spec, profile){
  const b = newBlock();
  b.method = 'emom'; b.variant = 'alternating';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'strength_endurance';
  const interval = Number(b.params.interval_sec) || 60;
  const exs = (Array.isArray(spec.exercises) && spec.exercises.length >= 2)
              ? spec.exercises.slice(0, Math.max(2, Number(b.params.exercise_count) || 2))
              : [spec.exercise || null, spec.exercise || null];
  b.exercises_rotation = exs.map(ex => {
    const tpr = ((DATA.exercises || {})[ex] || {}).tpr || 3;
    const reps = Math.max(1, Math.round(0.4 * interval / tpr));
    return _intervalComp(ex, reps, EMOM_LOAD_PCT);
  });
  if (spec.target_zone) b.zone = spec.target_zone;
  return _emit(b);
}

/* EMOM ascending_load: starting + increment tal que el terminal ≤ 95%.
   terminal = starting + increment*floor((n_intervals-1)/increment_every_n).
   Elegimos starting desde zona (clamp ≤80) e increment 2.5 (default) — el validador
   chequea exceeds_1rm (>100) y terminal_too_high (>95). */
function _genEmomAscending(spec, profile){
  const b = newBlock();
  b.method = 'emom'; b.variant = 'ascending_load';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'strength';
  const interval = Number(b.params.interval_sec) || 90;
  const dur = Number(b.params.total_duration_min) || 12;
  const nIntervals = Math.floor(dur * 60 / interval);
  const incEvery = Number(b.params.increment_every_n_intervals) || 1;
  const inc = Number(b.params.load_increment_pct) || 2.5;
  const incrementsApplied = Math.floor(Math.max(nIntervals - 1, 0) / Math.max(incEvery, 1));
  // starting tal que terminal ≤ 90 (margen bajo el umbral 95): starting ≤ 90 - inc*incApplied
  const zc = _zoneCenters(spec.target_zone);
  let starting = zc ? Math.min(zc.load, 75) : 70;
  const maxStarting = 90 - inc * incrementsApplied;
  if (starting > maxStarting) starting = Math.max(40, Math.floor(maxStarting));
  const ps = (variantOf(b).params_schema) || {};
  if ('starting_load_pct_1rm' in ps)
    b.params.starting_load_pct_1rm = _clampToParam(starting, ps.starting_load_pct_1rm);
  // work_per_interval con carga ascendente; reps tales que la densidad ∈ (20%,85%)
  // del interval (emom_work_too_light_for_interval / _exceeds_interval). interval 90s,
  // tpr default 3 → reps ~ 0.4*90/3 = 12 cae alto para carga ascendente; usamos 0.3 densidad.
  const tprA = ((DATA.exercises || {})[spec.exercise] || {}).tpr || 3;
  const ascReps = Math.max(1, Math.round(0.3 * interval / tprA));
  b.work_per_interval = [ _intervalComp(spec.exercise || null, ascReps, null) ];
  if (b.work_per_interval[0]){ b.work_per_interval[0].load_metric = 'percent_1rm';
                               b.work_per_interval[0].load_pct_1rm = b.params.starting_load_pct_1rm; }
  if (spec.target_zone) b.zone = spec.target_zone;
  return _emit(b);
}

/* Circuitos (components[] recorrido en rondas / time cap). reps metabólicas + carga ligera/bw. */
function _genCircuit(spec, profile){
  const b = newBlock();
  b.method = 'complex'; b.variant = spec.variant;
  applyDefaults(b);
  b.intent_declared = spec.intent || 'strength_endurance';

  // ejercicios del spec o repetición del exercise base; ≥2 componentes (circuito real).
  let exs = (Array.isArray(spec.exercises) && spec.exercises.length >= 2)
            ? spec.exercises.slice()
            : [spec.exercise || null, spec.exercise || null, spec.exercise || null];

  if (spec.variant === 'tabata'){
    // tabata: carga ≤50% (o bodyweight). reps por work_sec (20s ≈ 8-10 reps); 1+ componente.
    b.components = exs.slice(0, 2).map(ex => _intervalComp(ex, 10, TABATA_LOAD_PCT));
  } else if (spec.variant === 'chipper'){
    // chipper: reps NO crecientes (front-loaded). Usa la rampa MARCA-FIS, truncada a #ejercicios.
    const ramp = CHIPPER_REPS_RAMP.slice(0, Math.max(2, exs.length));
    b.components = ramp.map((r, i) => _intervalComp(exs[i] || exs[exs.length - 1], r, null));
  } else {
    // fixed_round_circuit / time_capped_circuit: reps homogéneas metabólicas, carga ligera/bw.
    b.components = exs.slice(0, 3).map(ex => _intervalComp(ex, CIRCUIT_REPS, null));
  }

  // fixed_round_circuit: ajustar total_rounds para que la duración estimada ~ target
  // (circuit_duration_mismatch_target: |estimada - target| ≤ 30% del target).
  if (spec.variant === 'fixed_round_circuit'){
    const ps = (variantOf(b).params_schema) || {};
    const target = Number(b.params.target_total_duration_min) || 15;
    // duración de una ronda (sin rest inter-ronda) en min
    const tmpRounds = b.params.total_rounds; b.params.total_rounds = 1;
    const oneRoundSec = (typeof __H !== 'undefined' && __H.estimate_total_duration)
                        ? __H.estimate_total_duration(b) : 0;
    b.params.total_rounds = tmpRounds;
    if (oneRoundSec > 0){
      const restRound = Number(b.params.rest_inter_round_sec) || 0;
      // target_sec ≈ rounds*oneRoundSec + restRound*(rounds-1) → resolver rounds
      const targetSec = target * 60;
      let rounds = Math.max(1, Math.round((targetSec + restRound) / (oneRoundSec + restRound)));
      if ('total_rounds' in ps) b.params.total_rounds = _clampToParam(rounds, ps.total_rounds);
    }
  }

  if (spec.target_zone) b.zone = spec.target_zone;
  return _emit(b);
}

/* Routers del arquetipo circuitos/emom. */
const EMOM_SINGLE_VARIANTS = ['every_minute', 'every_n_seconds'];
const CIRCUIT_VARIANTS = ['fixed_round_circuit', 'time_capped_circuit', 'chipper', 'tabata'];
function _genCircuitEmom(spec, profile){
  if (spec.method === 'emom'){
    if (EMOM_SINGLE_VARIANTS.indexOf(spec.variant) >= 0) return _genEmomSingle(spec, profile);
    if (spec.variant === 'alternating') return _genEmomAlternating(spec, profile);
    if (spec.variant === 'ascending_load') return _genEmomAscending(spec, profile);
  }
  if (spec.method === 'complex' && CIRCUIT_VARIANTS.indexOf(spec.variant) >= 0)
    return _genCircuit(spec, profile);
  return null;   // no es de este arquetipo
}

/* ============================================================
   V3.1.9 — ARQUETIPO PROGRESIÓN (pyramid + drop/mechanical_drop + multi_exercise_pyramid)
   Tres sub-familias con rampa de carga/reps o progresión mecánica.
     · pyramid ascending/descending: ESCALAR (first/last load+reps como params). La fitness
       function es la RELACIÓN INVERSA (pyramid_inverse_relation_violated): carga sube ⇒ reps
       bajan (y viceversa). Los defaults del schema ya la respetan → aplicar defaults + zona
       opcional + ejercicio. double/wave: escalares con su propia estructura (peak/wave_pattern),
       defaults Invariante-A-limpios → aplicar defaults + ejercicio.
     · multi_exercise_pyramid: requiere el array `exercises` (REQUIRED) + relación inversa
       por-ronda (first_round vs last_round). round_plan (custom) opcional.
     · drop/mechanical_drop: requiere `mechanical_progression` (array<mechanical_step>, REQUIRED)
       de longitud drops_count+1, con effective_demand NO CRECIENTE
       (mechanical_drop_demand_not_decreasing). Usamos difficulty_index_override explícito
       decreciente (no depende de tener regresiones embebidas en el catálogo). */

/* pyramid escalar: ascending/descending/double/wave. Solo fija ejercicio + zona;
   los params de rampa quedan en el default (ya respetan la relación inversa). */
function _genPyramidScalar(spec, profile){
  const b = newBlock();
  b.method = 'pyramid'; b.variant = spec.variant;
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  // V3.2: si el spec no fija ejercicio, selección sembrada de un patrón cargable (squat default).
  const picker = _makePicker(spec, profile);
  b.exercise = _resolveExercise(picker, {pattern: (spec.pattern || 'squat')}, spec.exercise).id;
  if (spec.target_zone) b.zone = spec.target_zone;
  const abs = _absoluteLoad(profile, b.exercise, b.params.first_set_load_pct_1rm || b.params.peak_load_pct_1rm);
  if (abs != null) b._prescribed_load_kg = abs;
  _stampSeed(b, spec);
  return _emit(b);
}

/* multi_exercise_pyramid: necesita el array exercises (required). Defaults respetan la
   relación inversa por-ronda. exercises = exercises_per_round ejercicios del catálogo. */
function _genMultiExercisePyramid(spec, profile){
  const b = newBlock();
  b.method = 'pyramid'; b.variant = 'multi_exercise_pyramid';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  const n = Number(b.params.exercises_per_round) || 3;
  // V3.2: selección sembrada de n ejercicios DISTINTOS del catálogo (no slice por inserción).
  const picker = _makePicker(spec, profile);
  let exs = (Array.isArray(spec.exercises) && spec.exercises.length >= n)
            ? spec.exercises.slice(0, n)
            : _pickN(picker, _candidates(picker, {}), n);
  b.params.exercises = exs;        // array<exercise_ref> (required)
  b.exercise = exs[0] || null;     // ejercicio representativo (block_without_exercise espera escalar)
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}

/* mechanical_drop: progresión mecánica con demanda NO creciente. Longitud = drops_count+1.
   difficulty_index_override decreciente explícito (robusto sin depender de regresiones de catálogo).
   exercise del spec o el base; cada step lo referencia (el flag de catálogo exige exercise válido). */
const MECH_DEMAND_START = 8;   // MARCA-FIS: demanda mecánica inicial (escala MDI 0-10)
const MECH_DEMAND_STEP = 2;    // MARCA-FIS: decremento por drop
function _genMechanicalDrop(spec, profile){
  const b = newBlock();
  b.method = 'drop'; b.variant = 'mechanical_drop';
  applyDefaults(b);
  b.intent_declared = spec.intent || 'hypertrophy';
  const drops = Number(b.params.drops_count) || 2;
  // V3.2: si el spec no trae ejercicio, selección sembrada (push_h default, escala bien a regresiones).
  const picker = _makePicker(spec, profile);
  const ex = _resolveExercise(picker, {pattern: (spec.pattern || 'push_h')}, spec.exercise).id;
  b.exercise = ex;   // mechanical_drop es escalar (un ejercicio base + progresión de mecanismo)
  // drops+1 segmentos con demanda estrictamente decreciente.
  const steps = [];
  for (let i = 0; i <= drops; i++){
    const s = newMechStep();
    s.exercise = ex;
    s.difficulty_index_override = Math.max(0, MECH_DEMAND_START - i * MECH_DEMAND_STEP);
    steps.push(s);
  }
  b.mechanical_progression = steps;
  if (spec.target_zone) b.zone = spec.target_zone;
  _stampSeed(b, spec);
  return _emit(b);
}

const PYRAMID_SCALAR_VARIANTS = ['ascending','descending','double','wave'];
function _genProgression(spec, profile){
  if (spec.method === 'pyramid'){
    if (PYRAMID_SCALAR_VARIANTS.indexOf(spec.variant) >= 0) return _genPyramidScalar(spec, profile);
    if (spec.variant === 'multi_exercise_pyramid') return _genMultiExercisePyramid(spec, profile);
  }
  if (spec.method === 'drop' && spec.variant === 'mechanical_drop') return _genMechanicalDrop(spec, profile);
  return null;
}


/* Variantes del arquetipo escalar monolítico (sin components[]/work_per_interval).
   Excluidas: drop/mechanical_drop (mechanical_progression), pyramid/* (rampa), todo complex/emom. */
const SCALAR_VARIANTS = {
  straight:  ['default'],
  cluster:   ['singles','doubles_triples','rest_pause_style'],
  drop:      ['single_drop','double_drop','descending'],
  rest_pause:['myo_reps','dc_style','mentzer_style'],
  amrap:     ['to_failure','time_capped','rep_capped']
};
function _isScalarVariant(method, variant){
  return (SCALAR_VARIANTS[method] || []).indexOf(variant) >= 0;
}

GEN.block = function(spec, profile){
  const res = _dispatchBlock(spec, profile);
  // Sello de semilla centralizado (contrato de reproducibilidad V3.2): todo bloque
  // generado lleva su _seed efectiva, aunque su generador no la sellara individualmente.
  if (res && res.block && res.block._seed == null) res.block._seed = _effectiveSeed(spec);
  // V4.3: sella el modo de progresión y los campos de rotación del spec al bloque,
  // para que GEN.progress los lea (el modo viaja spec→bloque; conjugate lo fija en genMeso).
  if (res && res.block && spec){
    if (spec.progression_mode) res.block.progression_mode = spec.progression_mode;
    if (spec.rotation_period_weeks != null) res.block.rotation_period_weeks = spec.rotation_period_weeks;
    if (Array.isArray(spec.rotation_pool)) res.block.rotation_pool = spec.rotation_pool.slice();
  }
  return res;
};
function _dispatchBlock(spec, profile){
  if (spec.method === 'contrast' && spec.variant === 'heavy_light')
    return _genContrastHeavyLight(spec, profile);
  if (spec.method === 'contrast' && spec.variant === 'french_contrast')
    return _genFrenchContrast(spec, profile);
  if (spec.method === 'complex' && spec.variant === 'olympic_complex')
    return _genSingleLoadChain(spec, profile);
  const mc = _genComplexMultiComp(spec, profile);
  if (mc) return mc;
  const ce = _genCircuitEmom(spec, profile);
  if (ce) return ce;
  const pg = _genProgression(spec, profile);
  if (pg) return pg;
  if (_isScalarVariant(spec.method, spec.variant))
    return _genScalar(spec, profile);
  // Familias aún no implementadas (V3.1.x en curso): falla ruidosa, no stub silencioso.
  return { block: null, flags: [], ok: false,
           reason: ['gen_unsupported_variant:' + spec.method + '/' + spec.variant] };
}
/* ===================================================================
   V3.3 — ENSAMBLADO DE SESIÓN (week_structure_logic, nivel sesión)
   genSession(slot, profile) -> {blocks:[...], flags, ok, reason}
   Contrato V3.0 §4: pasa validateSessionBlocks con 0 breaksCoherence o
   falla ruidosa. La fitness function de sesión (orden neural descendente +
   interferencia adyacente, flags session del catálogo) es la compuerta.

   slot = { purpose, segment_focus, n_blocks, methods_allowed,
            block_specs?, target_zones?, seed? }
     · block_specs: lista explícita de specs de bloque (toma precedencia).
     · Si no, se derivan n_blocks specs desde methods_allowed + target_zones.
   La semilla de sesión deriva en cascada las semillas de bloque por índice
   (_deriveSeed) → variedad estable a regeneraciones (contrato de semilla V3.2).
   =================================================================== */

/* Specs de bloque por defecto si el slot no los da explícitos. Empareja cada
   método permitido con una zona objetivo; rellena hasta n_blocks ciclando. */
function _slotBlockSpecs(slot){
  // V4.3: el modo de progresión del slot se hereda también por block_specs explícitos.
  const _withMode = (sp) => {
    const o = Object.assign({}, sp);
    if (slot.progression_mode && !o.progression_mode) o.progression_mode = slot.progression_mode;
    if (slot.rotation_period_weeks != null && o.rotation_period_weeks == null) o.rotation_period_weeks = slot.rotation_period_weeks;
    if (Array.isArray(slot.rotation_pool) && !Array.isArray(o.rotation_pool)) o.rotation_pool = slot.rotation_pool.slice();
    return o;
  };
  if (Array.isArray(slot.block_specs) && slot.block_specs.length) return slot.block_specs.map(_withMode);
  const methods = Array.isArray(slot.methods_allowed) && slot.methods_allowed.length
    ? slot.methods_allowed : [['straight','default']];
  const zones = Array.isArray(slot.target_zones) && slot.target_zones.length
    ? slot.target_zones : ['Z2'];
  const n = slot.n_blocks || methods.length;
  const specs = [];
  for (let i=0;i<n;i++){
    const mv = methods[i % methods.length];
    const method  = Array.isArray(mv) ? mv[0] : mv.method;
    const variant = Array.isArray(mv) ? mv[1] : mv.variant;
    const spec = { method, variant, target_zone: zones[i % zones.length] };
    // V4.3: propaga el modo de progresión del slot al spec del bloque (el modo viaja
    // con el slot; conjugate lo fija por defecto en genMeso). Solo si el slot lo declara.
    if (slot.progression_mode) spec.progression_mode = slot.progression_mode;
    if (slot.rotation_period_weeks != null) spec.rotation_period_weeks = slot.rotation_period_weeks;
    if (Array.isArray(slot.rotation_pool)) spec.rotation_pool = slot.rotation_pool.slice();
    specs.push(spec);
  }
  return specs;
}

/* Orden neural descendente (satisface session_block_order_suboptimal): ordena
   los bloques por _neuralDemand desc. Estable: empates conservan orden previo. */
function _orderByNeuralDemand(blocks){
  return blocks
    .map((b,i)=>({b,i,d:_neuralDemand(b)}))
    .sort((x,y)=> (y.d - x.d) || (x.i - y.i))
    .map(o=>o.b);
}

function genSession(slot, profile){
  slot = slot || {};
  const sessionSeed = (slot.seed != null) ? slot.seed : _hashStr(JSON.stringify(slot.block_specs || slot.methods_allowed || slot.purpose || 'session'));
  const specs = _slotBlockSpecs(slot);

  // 1) Generar cada bloque con semilla derivada en cascada del seed de sesión.
  const built = [];
  for (let i=0;i<specs.length;i++){
    const spec = Object.assign({}, specs[i]);
    if (spec.seed == null) spec.seed = _deriveSeed(sessionSeed, i);
    // Las variantes ESCALARES no autoseleccionan ejercicio (V3.2 lo dejó al spec).
    // A nivel sesión sí debemos darles uno: lo resolvemos del catálogo con el picker,
    // sesgado por segment_focus del slot si está declarado. Reproducible por la semilla.
    if (!spec.exercise && _isScalarVariant(spec.method, spec.variant)){
      const picker = _makePicker(spec, profile);
      const filter = slot.segment_focus ? { segment: slot.segment_focus } : {};
      let cands = _candidates(picker, filter);
      if (!cands.length) cands = _candidates(picker, {});   // foco sin candidatos → cualquiera disponible
      const picked = cands.length ? _pickOne(picker, cands) : null;
      if (picked) spec.exercise = picked;
    }
    const res = GEN.block(spec, profile);
    if (!res || !res.ok || !res.block){
      return { blocks: null, flags: [], ok: false,
               reason: (res && res.reason) ? res.reason : ['gen_session_block_failed:'+i] };
    }
    built.push(res.block);
  }

  // 2) Ordenar por demanda neural descendente (orden intra-sesión).
  let ordered = _orderByNeuralDemand(built);

  // 3) Compuerta de sesión. Si hay interferencia adyacente, intentar una
  //    permutación que la disuelva (greedy: separar contiguos que comparten
  //    patrón/segmento manteniendo el orden neural lo más posible).
  let res = validateSessionBlocks(ordered);
  if (!res.coherent){
    return { blocks: null, flags: res.flags, ok: false,
             reason: res.flags.filter(breaksCoherence).map(f=>f.id) };
  }
  if (res.flags.some(f=>f.id==='session_interference_adjacent')){
    const relaxed = _separateInterference(ordered);
    const res2 = validateSessionBlocks(relaxed);
    // Adoptar el reordenamiento solo si sigue coherente Y reduce interferencia.
    if (res2.coherent &&
        res2.flags.filter(f=>f.id==='session_interference_adjacent').length <
        res.flags.filter(f=>f.id==='session_interference_adjacent').length){
      ordered = relaxed; res = res2;
    }
  }

  return { blocks: ordered, flags: res.flags, ok: true,
           reason: [], _seed: sessionSeed };
}

/* Reordenamiento greedy para separar bloques contiguos que comparten un
   patrón/segmento fatigante, sin romper groseramente el orden neural: recorre
   en orden neural y, si el siguiente choca con el ya colocado, busca el primer
   candidato restante que no choque; si ninguno sirve, coloca el que tocaba
   (acepta el solape). Determinista. */
function _separateInterference(blocks){
  const pool = blocks.slice();
  const out = [];
  while (pool.length){
    if (!out.length){ out.push(pool.shift()); continue; }
    const last = out[out.length-1];
    let idx = pool.findIndex(b => _sharedFatiguingDim(last, b).length === 0);
    if (idx < 0) idx = 0;   // todos chocan: respeta el orden neural
    out.push(pool.splice(idx,1)[0]);
  }
  return out;
}

GEN.session = genSession;

/* ===================================================================
   V3.3b — ENSAMBLADO DE MICROCICLO (week_structure_logic, nivel microciclo)
   genMicro(plan, profile) -> {micro:{sessions,slots,frequency_targets,...},
                               flags, ok, reason, volume, frequency}

   plan = { slots: [session_slot,...],          // cada slot → una sesión
            frequency_targets?: map<pattern,{min,max}>,
            days_span?: int (default 7),
            seed? }
   Cada slot se materializa con GEN.session, derivando su semilla en cascada del
   seed de microciclo por índice de slot (_deriveSeed — contrato de semilla V3.2:
   la selección se congela aquí; la progresión inter-sesión de V3.4/V3.5 itera
   sobre lo congelado, nunca resiembra). Slots con session_template_ref===null se
   dejan VACÍOS a propósito (microcycle_slot_unfilled lo reporta, no es error).
   Compuerta: validateMicrocycleBlocks con 0 breaksCoherence o falla ruidosa.
   =================================================================== */
function genMicro(plan, profile){
  plan = plan || {};
  const slots = Array.isArray(plan.slots) && plan.slots.length ? plan.slots : [{slot_id:'s1'}];
  const microSeed = (plan.seed != null) ? plan.seed
    : _hashStr(JSON.stringify(slots.map(s=>s.slot_id||s.intent||'')) + ':' + (plan.days_span||7));

  const sessions = [];
  const slotMeta = [];
  for (let i=0;i<slots.length;i++){
    const slot = slots[i];
    const ref = (slot.session_template_ref!==undefined) ? slot.session_template_ref : slot.session_template;
    // Slot declarado vacío (draft): no se genera sesión; el flag lo reportará.
    slotMeta.push({ slot_id: slot.slot_id || ('s'+(i+1)),
                    session_template_ref: (ref===undefined ? null : ref),
                    name: slot.name });
    if (ref===null){ continue; }   // unfilled deliberado

    // Mapear el slot de microciclo a un slot de sesión para GEN.session.
    const sessionSlot = {
      purpose: slot.intent || slot.purpose,
      segment_focus: slot.segment_focus || (Array.isArray(slot.primary_patterns) ? null : null),
      n_blocks: slot.n_blocks,
      methods_allowed: slot.methods_allowed,
      block_specs: slot.block_specs,
      target_zones: slot.target_zones,
      // V4.3: arrastra el modo de progresión + campos de rotación del slot (conjugate
      // los fija; cualquier modelo puede declararlos) hasta el spec del bloque.
      progression_mode: slot.progression_mode,
      rotation_period_weeks: slot.rotation_period_weeks,
      rotation_pool: slot.rotation_pool,
      seed: _deriveSeed(microSeed, i)
    };
    const res = GEN.session(sessionSlot, profile);
    if (!res || !res.ok || !res.blocks){
      return { micro:null, flags:(res&&res.flags)||[], ok:false,
               reason:(res&&res.reason)?res.reason:['gen_micro_session_failed:'+i] };
    }
    sessions.push(res.blocks);
  }

  const micro = {
    sessions,
    slots: slotMeta,
    frequency_targets: plan.frequency_targets || {},
    days_span: plan.days_span || 7,
    _seed: microSeed
  };

  // Compuerta de microciclo: coherencia de cada sesión + reglas de volumen/frecuencia.
  const res = validateMicrocycleBlocks(micro);
  if (!res.coherent){
    return { micro:null, flags:res.flags, ok:false,
             reason: res.flags.filter(breaksCoherence).map(f=>f.id) };
  }
  return { micro, flags:res.flags, ok:true, reason:[],
           volume:res.volume, frequency:res.frequency, _seed:microSeed };
}
GEN.micro = genMicro;

/* ===================================================================
   V3.4.2 — ENSAMBLADO DE MESOCICLO (week_structure_logic, nivel meso)
   genMeso(mesoSpec, profile) -> {meso:{periodization_model,...,weeks:[...]},
                                  flags, ok, reason, driftFired}

   mesoSpec = { periodization_model, model_variant?, duration_weeks,
                level?, microcycle_plan,        // plan base de slots para GEN.micro
                base_load_pct?,                 // carga de fuerza de la semana 1 (proxy del ramp)
                seed? }

   Sube del MICROCICLO (V3.3b) al MESO. Construye las `weeks` aplicando el RAMP
   propio del modelo declarado (week_structure_logic), inserta planned_deload
   según el umbral effective=min(nivel,modelo), y materializa cada semana con
   GEN.micro derivando la semilla EN CASCADA (_deriveSeed(mesoSeed, w) — contrato
   de semilla V3.2: la selección se CONGELA por semana; V3.5 itera sobre lo
   congelado, nunca resiembra). Los week_modifiers del ramp se aplican sobre los
   bloques YA generados (deltas de carga/sets), no resiembran la selección.

   v3_constraint (decisión sesión 22): las 4 model_drift_rules NO se hacen hard
   sobre el plan humano (eso reescribiría severidad). El generador las usa como
   AUTOCHEQUEO DE CONSTRUCCIÓN: si su propio ramp dispara el drift del modelo que
   declaró, es falla ruidosa (bug del constructor) → meso:null + gen_meso_self_drift.
   Es la lectura correcta de v3_constraint: invariante de construcción.
   =================================================================== */

/* Ramp de carga de fuerza por semana estándar según el modelo (MARCA-FIS,
   recalibrable). Devuelve el load_pct objetivo de la semana estándar `sw`
   (0-based sobre las estándar) dado el modelo, la base y el nº de estándar. */
const _MESO_RAMP = {
  // intensidad sube ~3%/semana estándar; volumen inverso (lo maneja el modifier de sets).
  linear:            (base, sw) => base + 3*sw,
  // bloque: acumulación plana-baja, luego sube hacia realización (proxy lineal suave).
  block:             (base, sw) => base + 2*sw,
  // conjugate: intensidad ME alta y ~estable (la variedad la da la rotación, no el ramp).
  conjugate:         (base, sw) => base + 1*sw,
  // undulating: la ondulación vive en las ZONAS por sesión, no en una rampa semanal → plano.
  undulating:        (base, sw) => base,
  // concurrent: fuerza ~estable (el delta sostenido >2.5% dispararía drift) → +1%/sem máx.
  concurrent_hybrid: (base, sw) => base + 1*sw,
};

/* Zonas de fuerza por sesión para undulating (DUP): alterna entre 2 zonas
   distintas dentro de la semana para no disparar dup_with_identical_slots. */
function _undulatingZones(weekIdx){
  // alterna el par (Z1,Z4) ↔ (Z2,Z3) por semana para variar el estímulo.
  return (weekIdx % 2 === 0) ? ['Z1','Z4'] : ['Z2','Z3'];
}

/* Aplica un delta de carga (puntos %1RM) a los bloques escalares de fuerza de una
   sesión generada. No toca conditioning (sin load_pct). Clampa a [0,100]. */
function _applyLoadDelta(blocks, deltaPct){
  for (const b of (blocks||[])){
    if (b && b.params && typeof b.params.load_pct_1rm==='number'){
      b.params.load_pct_1rm = Math.max(0, Math.min(100, b.params.load_pct_1rm + deltaPct));
    }
  }
}

function genMeso(mesoSpec, profile){
  mesoSpec = mesoSpec || {};
  const model = mesoSpec.periodization_model || 'linear';
  const variant = mesoSpec.model_variant || null;
  const level = mesoSpec.level || 'intermediate';
  const dw = mesoSpec.duration_weeks || 4;
  let basePlan = mesoSpec.microcycle_plan || { slots:[{slot_id:'s1', intent:'strength',
                     n_blocks:1, methods_allowed:[['straight','default']], target_zones:['Z2'],
                     segment_focus:'lower'}] };
  const base = (typeof mesoSpec.base_load_pct==='number') ? mesoSpec.base_load_pct : 75;

  // V4.3: conjugate fija el modo ROTATIVO por defecto en sus slots de fuerza (la variedad
  // del conjugado es la rotación de variante, no el ramp). Cualquier slot que ya declare
  // progression_mode gana (override del llamador). rotation_period default 2 sem (MARCA-FIS:
  // conjugado conservador; Westside clásico ~1, recalibrable por slot). Slots de
  // conditioning (sin intent de fuerza) no rotan. Esto materializa el week_structure_logic
  // de conjugate ("rotation via placeholders + equivalence graph; v3 hook") de la capa D.
  if (model === 'conjugate' && basePlan && Array.isArray(basePlan.slots)){
    const STRENGTH_INTENTS = { strength:1, max_strength:1, power:1, potentiation:1 };
    basePlan = Object.assign({}, basePlan, {
      slots: basePlan.slots.map(s => {
        if (s && STRENGTH_INTENTS[s.intent] && !s.progression_mode){
          return Object.assign({}, s, {
            progression_mode: 'rotational',
            rotation_period_weeks: (s.rotation_period_weeks != null ? s.rotation_period_weeks : 2)
          });
        }
        return s;
      })
    });
  }
  const mesoSeed = (mesoSpec.seed != null) ? mesoSpec.seed
    : _hashStr(model+':'+(variant||'')+':'+dw+':'+JSON.stringify(basePlan.slots||[]));

  // --- Posicionamiento de deload: umbral effective = min(nivel, modelo).
  const lvlThr = (DATA.deload_overdue_threshold||{})[level] ?? 5;
  const pm = (DATA.periodization_models||{})[model] || {};
  const dp = pm.deload_positioning || {};
  const modelThr = Array.isArray(dp.expected_every_weeks) ? dp.expected_every_weeks[1] : null;
  const thr = modelThr!=null ? Math.min(lvlThr, modelThr) : lvlThr;

  const rampFn = _MESO_RAMP[model] || _MESO_RAMP.linear;
  const weeks = [];
  let stdIdx = 0;       // índice de semana estándar (0-based) para el ramp
  let sinceDeload = 0;  // semanas estándar desde el último deload

  for (let w=1; w<=dw; w++){
    const lastWeek = (w===dw);
    // ¿toca planned_deload? Solo si superaríamos el umbral y no es la última semana
    // (la última suele ser realización/test; el taper lo pone GEN.macro).
    const isDeload = (sinceDeload >= thr) && !lastWeek;

    // Plan de la semana: para undulating reescribimos las zonas de los slots (DUP).
    let weekPlan = basePlan;
    if (model==='undulating' && !isDeload){
      const zs = _undulatingZones(stdIdx);
      weekPlan = Object.assign({}, basePlan, {
        slots: (basePlan.slots||[]).map((s,si)=>Object.assign({}, s,
          { target_zones: [ zs[si % zs.length] ] })) });
    }

    // CONTRATO DE SEMILLA V3.2 (corrección V3.5, lectura A): la selección se congela
    // a nivel MESOCICLO, no semana. El mismo slot resuelve el MISMO ejercicio todas las
    // semanas del meso → la progresión inter-sesión (V3.5) avanza carga/reps sobre un
    // ejercicio persistente (lo que un atleta de fuerza espera). La variación entre
    // microciclos vive SOLO en la calibración (el ramp de carga aplicado abajo), nunca
    // en la selección. Variedad de selección legítima solo ENTRE mesociclos (resembrar).
    // Por eso la semilla de microciclo es mesoSeed CONSTANTE, no _deriveSeed(mesoSeed, w).
    const micro = GEN.micro(Object.assign({}, weekPlan, { seed: mesoSeed }), profile);
    if (!micro || !micro.ok || !micro.micro){
      return { meso:null, flags:(micro&&micro.flags)||[], ok:false,
               reason:(micro&&micro.reason)?micro.reason:['gen_meso_micro_failed:week'+w] };
    }

    if (isDeload){
      // Deload: −40% carga relativa al estándar previo (receta default C↔D),
      // intensidad mantenida en spirit → aquí proxy de carga reducida sobre lo generado.
      for (const blocks of micro.micro.sessions) _applyLoadDelta(blocks, -0.40*base);
      weeks.push({ week:w, type:'planned_deload', microcycle: micro.micro,
                   note:'deload planificado (umbral '+thr+')' });
      sinceDeload = 0;
    } else {
      // Aplica el ramp de carga de la semana estándar sobre los bloques de fuerza.
      const targetLoad = rampFn(base, stdIdx);
      const delta = targetLoad - base;     // delta vs base; la calibración de zona ya puso ~base
      for (const blocks of micro.micro.sessions) _applyLoadDelta(blocks, delta);
      weeks.push({ week:w, type:'standard', microcycle: micro.micro });
      stdIdx++; sinceDeload++;
    }
  }

  const meso = {
    periodization_model: model,
    model_variant: variant,
    duration_weeks: dw,
    level,
    progression_scheme: { axis: (pm.primary_axis==='intensity'?'intensity':
                                 pm.primary_axis==='volume'?'volume':'mixed'), ramp:[] },
    weeks,
    _seed: mesoSeed
  };

  // Compuerta de meso: coherencia de cada microciclo + reglas de meso.
  const res = validateMesocycleBlocks(meso);
  if (!res.coherent){
    return { meso:null, flags:res.flags, ok:false,
             reason: res.flags.filter(breaksCoherence).map(f=>f.id) };
  }
  // AUTOCHEQUEO DE CONSTRUCCIÓN (v3_constraint): el generador NO debe producir el
  // drift del modelo que declaró. Si lo hace, es bug del ramp → falla ruidosa.
  // V4.3 EXCEPCIÓN: `conjugate_without_rotation` (mismos ejercicios ≥6 sem) es ESPERADO
  // en un meso conjugate ROTATIVO antes de GEN.progress — la selección se congela por
  // meso (V3.5) y la rotación de variante es la dimensión TEMPORAL que aplica GEN.progress,
  // no genMeso. Si los slots de fuerza son rotativos, ese drift NO es bug de construcción:
  // la rotación está delegada, no ausente. Cualquier OTRO drift sí es falla ruidosa.
  const slotsRotational = Array.isArray(basePlan.slots) &&
    basePlan.slots.some(s => s && s.progression_mode === 'rotational');
  const realDrift = (res.driftFired || []).filter(id =>
    !(slotsRotational && id === 'conjugate_without_rotation'));
  if (realDrift.length){
    return { meso:null, flags:res.flags, ok:false,
             reason: realDrift.map(id=>'gen_meso_self_drift:'+id) };
  }
  return { meso, flags:res.flags, ok:true, reason:[], driftFired:res.driftFired||[], _seed:mesoSeed };
}
GEN.meso = genMeso;

/* ===================================================================
   V3.4.3 — ENSAMBLADO DE MACROCICLO (reverse planning desde el evento)
   genMacro(macroSpec, profile) -> {macro:{start_date,end_date,events,phases,taper},
                                    flags, ok, reason}

   macroSpec = { event:{id,date,priority,type?},   // date = epoch-day int; el evento
                                                    //   es la ÚNICA fecha inmóvil (D.5.3)
                 phases:[{order, purpose, meso_spec}],   // meso_spec → GEN.meso
                 taper_days?,                       // default 11 (centro de [8,14] para A)
                 seed? }

   REVERSE PLANNING (D.5.3): el macro se razona HACIA ATRÁS desde event.date:
   taper ← peak ← specific ← general. La última fase termina adyacente al evento;
   el taper ocupa los últimos taper_days. Cada fase materializa su meso vía
   GEN.meso con semilla en cascada (_deriveSeed(macroSeed, order)).

   Compuerta: validateMacrocycleBlocks. macrocycle_phase_overlap es structural_hard
   → si el reverse planning produce solapamiento (bug del planificador), falla
   ruidosa (macro:null + reason). Mismo principio que el autochequeo de GEN.meso.
   =================================================================== */
function genMacro(macroSpec, profile){
  macroSpec = macroSpec || {};
  const event = macroSpec.event || { id:'event_a', date:84, priority:'A', type:'competition' };
  const phaseSpecs = (macroSpec.phases || []).slice().sort((a,b)=>(a.order||0)-(b.order||0));
  const taperDays = (typeof macroSpec.taper_days==='number') ? macroSpec.taper_days : 11;
  const macroSeed = (macroSpec.seed != null) ? macroSpec.seed
    : _hashStr('macro:'+event.id+':'+phaseSpecs.length);

  // Materializa cada fase (meso) en orden. La duración en semanas la da el meso.
  const phases = [];
  let totalWeeks = 0;
  for (const ps of phaseSpecs){
    const mspec = Object.assign({}, ps.meso_spec, { seed: _deriveSeed(macroSeed, ps.order||phases.length+1) });
    const mr = GEN.meso(mspec, profile);
    if (!mr || !mr.ok || !mr.meso){
      return { macro:null, flags:(mr&&mr.flags)||[], ok:false,
               reason:(mr&&mr.reason)?mr.reason:['gen_macro_phase_failed:'+(ps.order)] };
    }
    phases.push({ order: ps.order, purpose: ps.purpose, weeks: mr.meso.duration_weeks, meso: mr.meso });
    totalWeeks += mr.meso.duration_weeks;
  }

  // REVERSE PLANNING: la última fase termina adyacente al evento; sembramos fechas
  // hacia atrás. El evento es el ancla inmóvil. start_date del macro = evento − totalWeeks.
  const startDate = event.date - totalWeeks*7;
  let cursor = startDate;
  for (const ph of phases){            // las fases ya están en orden ascendente
    ph.start_date = cursor;
    cursor += ph.weeks*7;
  }
  const endDate = event.date;

  // Taper: ocupa los últimos taperDays, terminando adyacente al evento (event − 1 día).
  const taper = {
    event_ref: event.id,
    start_date: event.date - taperDays,
    duration_days: taperDays,
    strategy: 'exponential',
    deltas: { volume_pct: -50, intensity: 'maintained', frequency: 'maintained' }
  };

  const macro = {
    id: macroSpec.id || 'macro_gen',
    start_date: startDate,
    end_date: endDate,
    state: 'planned',
    events: [ event ],
    phases,
    taper
  };

  // Compuerta de macro: coherencia de cada meso + reglas de fase/evento/taper.
  const res = validateMacrocycleBlocks(macro);
  if (!res.coherent){
    return { macro:null, flags:res.flags, ok:false,
             reason: res.flags.filter(breaksCoherence).map(f=>f.id) };
  }
  return { macro, flags:res.flags, ok:true, reason:[], _seed:macroSeed };
}
GEN.macro = genMacro;


/* ===================================================================
   V3.5 — PROGRESIÓN INTER-SESIÓN (progression_logic, hook A)
   Añade la dimensión TEMPORAL sobre las semanas ya materializadas por
   genMeso. NO resiembra la selección (contrato de semilla V3.2: la
   selección está CONGELADA; la progresión solo avanza parámetros).

   Modelo (Capa C, LEÍDO de DATA.progression_engine — no reimplementado):
   · Doble progresión: reps hasta el techo de zona → luego sube carga,
     resetea reps al piso (modulada por primary_axis del modelo).
   · Asimetría §4.7: FRENA con 1 señal (rir_delta<=-2), ACELERA solo con
     2 consecutivas (overshoot_streak>=2) + fatigue_state in {fresh,normal}.
     Caps: +increase_cap/sesión, -reduce_cap/bloque.
   · Decide por BLOQUE; VALIDA por microciclo (genMeso ya reensambla y
     valida; aquí la señal de volumen>MRV es un freno legítimo a nivel grupo).

   GEN.progress(meso, feedbackByWeek, profile) -> meso con weeks progresadas.
   feedbackByWeek[w] = { byBlock: { <blockKey>: {rir_reported, reps_done} } }
   donde blockKey = "s<session_idx>_b<block_idx>" (estable por la selección congelada).
   =================================================================== */

/* Patrón de movimiento primario del bloque (el del primer ejercicio primario).
   Reusa _sessionBlockExercises del motor (resuelve ejercicios de cualquier arquetipo).
   '_none' si no hay ejercicio resoluble (conditioning sin patrón de fuerza). */
function _blockPrimaryPattern(block){
  if (typeof _sessionBlockExercises !== 'function') return '_none';
  const ids = _sessionBlockExercises(block) || [];
  for (const id of ids){
    const e = (DATA.exercises || {})[id];
    if (e && e.pattern) return e.pattern;
  }
  return '_none';
}

/* rir_delta = rir_reported - rir_target. Positivo = sobró margen (overshoot);
   negativo = se quedó corto (undershoot). null si falta el dato. */
function _rirDelta(block, fb){
  if (!fb || fb.rir_reported == null) return null;
  const tgt = (block && block.params && typeof block.params.rir_target === 'number')
              ? block.params.rir_target
              : (block && typeof block.rir === 'number' ? block.rir : null);
  if (tgt == null) return null;
  return fb.rir_reported - tgt;
}

/* Conversión RIR→carga por zona (LEÍDA de la spec). pct por RIR de margen,
   modificado por la zona del bloque. */
function _rirToLoadPct(zone, rirMagnitude){
  const pe = (DATA.progression_engine || {});
  const r2l = pe.rir_to_load || {};
  const base = (typeof r2l.default_pct_per_rir === 'number') ? r2l.default_pct_per_rir : 2.5;
  const mods = r2l.context_modifiers || {};
  let perRir = base;
  if (zone === 'Z1' || zone === 'Z2') perRir = mods.zone_z1_z2 ?? base;
  else if (zone === 'Z3' || zone === 'Z4') perRir = mods.zone_z3_z4 ?? base;
  else if (zone === 'Z5' || zone === 'Z6') perRir = mods.zone_z5_z6 ?? base;
  return perRir * rirMagnitude;
}

/* Techo/piso de reps de la zona (para doble progresión). */
function _zoneRepsRange(zone){
  const z = (DATA.zones || {})[zone];
  if (!z || !z.reps) return null;
  return { min: z.reps.min, max: z.reps.max };
}

/* fatigue_state derivado de las señales acumuladas (proxy escalar de la
   derivación declarativa de la spec). state ∈ {fresh, normal, accumulating, overreached}.
   sig = { undershootStreakMax, overshootStreakMax, mrvGroups } por patrón/grupo. */
function _deriveFatigueState(sig){
  sig = sig || {};
  const us = sig.undershootStreakMax || 0;
  const os = sig.overshootStreakMax || 0;
  const mrv = sig.mrvGroups || 0;
  // overreached: any_2_of (proxy de las 4 condiciones de la spec)
  let oc = 0;
  if (us >= 3) oc++;
  if (mrv >= 2) oc++;
  if (oc >= 2) return 'overreached';
  // accumulating: any_2_of
  let ac = 0;
  if (us >= 2) ac++;
  if (mrv >= 1) ac++;
  if (ac >= 2) return 'accumulating';
  // fresh: consistent overshoot (2+) y sin señales de fatiga
  if (os >= 2 && us === 0 && mrv === 0) return 'fresh';
  return 'normal';
}

/* DISPATCH por modo de progresión (V4.0 MARCA-ARQ #1). Un solo motor; el modo
   solo cambia QUÉ hace cada bloque al progresar, no el andamiaje temporal de
   GEN.progress. Default 'accumulative' (V3.5, retrocompatible: ausencia ⇒ accumulative). */
function _progressBlock(block, ctx){
  const mode = (block && block.progression_mode) || 'accumulative';
  if (mode === 'rotational') return _progressBlockRotational(block, ctx);
  return _progressBlockAccumulative(block, ctx);
}

/* Aplica doble progresión + asimetría a UN bloque escalar de fuerza dado su
   rir_delta y el streak de overshoot/undershoot de su patrón.
   Devuelve { changed, action, detail } y MUTA el bloque (sobre la copia del caller). */
function _progressBlockAccumulative(block, ctx){
  const pe = (DATA.progression_engine || {});
  const asym = pe.asymmetry || {};
  const incCap = asym.increase_cap_per_session_pct ?? 5;
  const redCap = asym.reduce_cap_per_block_pct ?? 10;
  const incStreak = asym.increase_streak ?? 2;

  const p = (block && block.params) || {};
  // Solo bloques con prescripción escalar (load+reps) progresan en V3.5.1.
  if (typeof p.load_pct_1rm !== 'number' || typeof p.reps_target !== 'number')
    return { changed:false, action:'skip_nonscalar', detail:null };

  const zone = block.zone || ctx.zone || null;
  const rng  = _zoneRepsRange(zone);
  const rd   = ctx.rirDelta;       // puede ser null
  const usStreak = ctx.undershootStreak || 0;
  const osStreak = ctx.overshootStreak || 0;
  const fatigue  = ctx.fatigueState || 'normal';

  // --- FRENO (1 señal basta — asimetría: el sistema frena solo) ---
  if (rd != null && rd <= -2){
    const cut = Math.min(_rirToLoadPct(zone, Math.abs(rd)), redCap);
    p.load_pct_1rm = Math.max(0, p.load_pct_1rm - cut);
    return { changed:true, action:'reduce_load', detail:{pct:-cut, reason:'rir_delta<=-2'} };
  }
  if (usStreak >= (pe.pattern_streak ? pe.pattern_streak.reduce_streak : 2)){
    const cut = Math.min(Math.abs(pe.pattern_streak.reduce_pct), redCap);
    p.load_pct_1rm = Math.max(0, p.load_pct_1rm - cut);
    return { changed:true, action:'reduce_pattern_streak', detail:{pct:-cut, reason:'undershoot_streak>=2'} };
  }

  // --- ACELERA solo con 2 consecutivas Y fatiga fresh/normal ---
  const canAccelerate = (osStreak >= incStreak) && (fatigue === 'fresh' || fatigue === 'normal');
  if (canAccelerate || (rd != null && rd >= 2 && osStreak >= incStreak)){
    // DOBLE PROGRESIÓN: si reps ya tocan el techo de zona → sube carga, reset reps al piso.
    if (rng && p.reps_target >= rng.max){
      const bump = Math.min(_rirToLoadPct(zone, 1), incCap);
      p.load_pct_1rm = Math.min(100, p.load_pct_1rm + bump);
      p.reps_target  = rng.min;
      return { changed:true, action:'double_prog_load', detail:{pct:bump, reps:rng.min, reason:'reps_at_zone_ceiling'} };
    }
    // si hay margen de reps → sube reps dentro de la zona.
    if (rng && p.reps_target < rng.max){
      p.reps_target = Math.min(rng.max, p.reps_target + 1);
      return { changed:true, action:'double_prog_reps', detail:{reps:p.reps_target, reason:'reps_below_ceiling'} };
    }
    // sin rango de zona resoluble: sube carga acotada por el cap.
    const bump = Math.min(_rirToLoadPct(zone, 1), incCap);
    p.load_pct_1rm = Math.min(100, p.load_pct_1rm + bump);
    return { changed:true, action:'load_only', detail:{pct:bump, reason:'no_zone_range'} };
  }

  // --- MANTENER (1 señal débil o sin señal suficiente para acelerar) ---
  return { changed:false, action:'hold', detail:{reason:'insufficient_signal_to_accelerate'} };
}

/* ===================================================================
   V4.1 — MODO DE PROGRESIÓN ROTATIVO (conjugado/Westside, params 1-3)

   El patrón+intent son el INVARIANTE; la VARIANTE rota cada
   rotation_period_weeks sobre un POOL de variantes equivalentes en
   estímulo primario. Param 4 (métrica de avance por desviación de e1RM
   predicho vía P7) llega en V4.2 — V4.1 rota y mantiene la calibración
   base de zona, sin medir avance todavía.
   Contrato: docs/V4_0_CONTRACT.md
   =================================================================== */

/* POOL de rotación en cascada (V4.0 §3, patrón _resolveExercise de V3.2):
   (1) slot.rotation_pool explícito → tal cual.
   (2) grafo de equivalencias del catálogo (equivalences similarity high/medium).
   (3) fallback implícito: _candidates por pattern+segment del ejercicio actual.
   Orden ESTABLE (alfabético) → rotación reproducible. Devuelve [exercise_id]. */
function _rotationPool(block, profile){
  // (1) pool explícito en el bloque/slot
  if (Array.isArray(block.rotation_pool) && block.rotation_pool.length){
    return block.rotation_pool.slice().sort();
  }
  const ids = (typeof _sessionBlockExercises === 'function') ? (_sessionBlockExercises(block)||[]) : [];
  const baseEx = ids[0] || null;
  if (!baseEx) return [];
  const ex = (DATA.exercises || {})[baseEx];
  if (!ex) return [baseEx];

  // (2) grafo de equivalencias declarado (FUENTE PREFERENTE cuando exista)
  const eq = Array.isArray(ex.equivalences) ? ex.equivalences : [];
  const eqIds = eq
    .filter(e => e && (e.similarity === 'high' || e.similarity === 'medium'))
    .map(e => (e.target && (e.target.exercise || e.target)) )
    .filter(Boolean);
  if (eqIds.length){
    const set = {}; set[baseEx] = 1; eqIds.forEach(id => { set[id] = 1; });
    return Object.keys(set).sort();
  }

  // (3) fallback implícito: mismo pattern + segment, compatible con disponibilidad/lesiones
  const picker = (typeof _makePicker === 'function') ? _makePicker(block, profile) : null;
  if (picker && typeof _candidates === 'function'){
    const cands = _candidates(picker, { pattern: ex.pattern, segment: ex.segment }) || [];
    if (cands.length) return cands.slice().sort();
  }
  return [baseEx];
}

/* N_min de pool para sostener la cadencia sin repetir antes de tiempo:
   ceil(meso_weeks / rotation_period) + 1 (MARCA-FIS, proxy recalibrable). */
function _rotationPoolMin(mesoWeeks, period){
  const w = (typeof mesoWeeks === 'number' && mesoWeeks > 0) ? mesoWeeks : 1;
  const p = (typeof period === 'number' && period > 0) ? period : 1;
  return Math.ceil(w / p) + 1;
}

/* Variante del pool para un índice de periodo dado. Selección determinista,
   secuencial estable (índice = periodo mod |pool|) → reproducible por la
   semilla del meso (el orden del pool ya es estable). Rota con repetición
   cíclica si el pool < N_min (no es falla dura). */
function _rotationVariantForPeriod(pool, periodIdx){
  if (!pool || !pool.length) return null;
  const i = ((periodIdx % pool.length) + pool.length) % pool.length;
  return pool[i];
}

/* Sustituye el ejercicio primario de un bloque escalar por exId (rotación).
   Solo toca bloques escalares (b.exercise); MUTA sobre la copia del caller. */
function _blockSetExercise(block, exId){
  if (!exId || !block) return false;
  if (typeof block.exercise === 'string' || block.exercise === null){
    block.exercise = exId;
    return true;
  }
  return false;
}

/* Progresión ROTATIVA de un bloque escalar (V4.1).
   ctx añade: { rotationPeriodIdx, rotationDue, pool, mesoWeeks, period }.
   - Si rotationDue (toca rotar este periodo) → rota la variante y recentra la
     calibración de zona (la carga %1RM se mantiene en el centro de zona: la
     comparación barra-vs-barra NO aplica aquí; el avance real lo medirá V4.2).
   - Si no toca rotar → mantiene (la variante persiste dentro del periodo).
   Devuelve { changed, action, detail } y MUTA el bloque. */
function _progressBlockRotational(block, ctx){
  const p = (block && block.params) || {};
  // Solo bloques con prescripción escalar (load+reps) rotan en V4.1.
  if (typeof p.load_pct_1rm !== 'number' || typeof p.reps_target !== 'number')
    return { changed:false, action:'skip_nonscalar', detail:null };

  const pool = ctx.pool || [];
  const need = _rotationPoolMin(ctx.mesoWeeks, ctx.period);
  const poolWarn = (pool.length < need);

  // La variante del periodo se aplica en CADA semana del periodo: cada semana tiene
  // su propio bloque materializado por genMeso (arranca en el ejercicio base), así que
  // hay que fijar la variante correcta del periodo aunque no sea la semana de cambio.
  const exId = _rotationVariantForPeriod(pool, ctx.rotationPeriodIdx);
  const before = block.exercise;
  const rotated = _blockSetExercise(block, exId);
  if (!rotated){
    return { changed:false, action:'rotational_no_scalar_exercise', detail:null };
  }
  // En la semana de CAMBIO de variante, recentra reps al piso de zona (nueva variante
  // = nuevo punto de partida). Dentro del periodo, mantiene (no resetea cada semana).
  let advDetail = null;
  if (ctx.rotationDue){
    const rng = _zoneRepsRange(block.zone || ctx.zone || null);
    if (rng) block.params.reps_target = rng.min;

    // V4.2: modula la carga del nuevo periodo por el AVANCE (desviación de e1RM).
    // Asimetría C: avance positivo (progresó sobre lo predicho) → sube carga acotada;
    // avance negativo (retroceso) → frena. Umbral muerto ±2% = rotación neutra esperada.
    const adv = ctx.rotationAdvance;
    if (adv && typeof adv.advance === 'number'){
      const pe = (DATA.progression_engine || {});
      const asym = pe.asymmetry || {};
      const incCap = asym.increase_cap_per_session_pct ?? 5;
      const redCap = asym.reduce_cap_per_block_pct ?? 10;
      const DEAD = 0.02;   // MARCA-FIS: banda muerta de avance neutro (±2%)
      if (adv.advance > DEAD){
        // progresó por encima de lo predicho → sube carga proporcional, acotada.
        const bump = Math.min(adv.advance * 100, incCap);
        block.params.load_pct_1rm = Math.min(100, block.params.load_pct_1rm + bump);
        advDetail = { advance: adv.advance, action:'accelerate', pct: bump, source: adv.source };
      } else if (adv.advance < -DEAD){
        // retroceso real respecto a lo predicho → frena, acotado.
        const cut = Math.min(Math.abs(adv.advance) * 100, redCap);
        block.params.load_pct_1rm = Math.max(0, block.params.load_pct_1rm - cut);
        advDetail = { advance: adv.advance, action:'brake', pct: -cut, source: adv.source };
      } else {
        advDetail = { advance: adv.advance, action:'neutral', pct: 0, source: adv.source };
      }
    }
  }

  return { changed: (before !== exId) || (advDetail != null && advDetail.pct !== 0),
           action: ctx.rotationDue ? 'rotational_rotate_variant' : 'rotational_apply_variant',
           detail: { from: before, to: exId, period_idx: ctx.rotationPeriodIdx,
                     pool_size: pool.length,
                     advance: advDetail,
                     pool_insufficient: poolWarn ? { need, have: pool.length } : null } };
}

/* ===================================================================
   V4.2 — MÉTRICA DE PROGRESIÓN POR DESVIACIÓN DE e1RM PREDICHO (param 4)

   La pieza NOVEDOSA: hace comparable lo incomparable. Al rotar de la
   variante V_a a V_b NO se compara barra-vs-barra; se PREDICE el e1RM de
   V_b desde el de V_a vía el ratio del grafo (load_translation) o el motor
   de fuerza relativa P7 (_rel1rm), y el AVANCE = desviación del observado
   respecto al predicho. Esa señal modula la progresión del nuevo periodo.
   Contrato: docs/V4_0_CONTRACT.md §3 param 4
   =================================================================== */

/* e1RM observado desde el feedback (Epley directo — inverso de __H.epley_inverse).
   loadKg = carga real levantada; reps = reps logradas. Devuelve kg estimados de 1RM.
   null si falta dato. */
function _e1rmFromFeedback(loadKg, reps){
  if (typeof loadKg !== 'number' || loadKg <= 0) return null;
  if (typeof reps !== 'number' || reps <= 0) return null;
  return loadKg * (1 + reps / 30);     // Epley
}

/* Carga en kg que el feedback representa para un bloque/variante dado.
   Preferencia: load_kg explícito del feedback → si no, deriva la carga prescrita
   del e1RM del perfil para ESA variante (_absoluteLoad). null si no hay base. */
function _feedbackLoadKg(exId, loadPct, fb, profile){
  if (fb && typeof fb.load_kg === 'number' && fb.load_kg > 0) return fb.load_kg;
  if (typeof loadPct === 'number') return _absoluteLoad(profile, exId, loadPct);
  return null;
}

/* Ratio de traducción de carga V_a → V_b (cuánto del 1RM de V_a es el 1RM de V_b).
   Cascada: (1) load_translation del equivalence_edge V_a→V_b si existe (dato directo);
   (2) __H._rel1rm: mult(V_b)/mult(V_a) (composición por hub, P7). Devuelve
   { ratio, source, conf } o null si ninguna fuente resuelve. */
function _rotationRatio(exFrom, exTo){
  if (!exFrom || !exTo) return null;
  if (exFrom === exTo) return { ratio: 1, source: 'identity', conf: 2 };
  // (1) grafo de equivalencias declarado
  const ex = (DATA.exercises || {})[exFrom];
  if (ex && Array.isArray(ex.equivalences)){
    for (const e of ex.equivalences){
      const tgt = e && (e.target && (e.target.exercise || e.target));
      if (tgt === exTo && typeof e.load_translation === 'number' && e.load_translation > 0){
        return { ratio: e.load_translation, source: 'equivalence_edge',
                 conf: (e.similarity === 'high' ? 2 : 1) };
      }
    }
  }
  // (2) motor de fuerza relativa P7 (mult relativo al global_hub)
  if (typeof __H !== 'undefined' && __H._rel1rm){
    const ra = __H._rel1rm(exFrom), rb = __H._rel1rm(exTo);
    if (ra && rb && ra.mult > 0){
      return { ratio: rb.mult / ra.mult, source: 'rel1rm_p7',
               conf: Math.min(ra.conf, rb.conf) };
    }
  }
  return null;
}

/* AVANCE de rotación: desviación del e1RM observado de la variante nueva respecto
   al PREDICHO desde la conocida.
     e1rm_pred(V_b) = e1rm_obs(V_a) × ratio(V_a→V_b)
     advance        = (e1rm_obs(V_b) − e1rm_pred(V_b)) / e1rm_pred(V_b)
   prev/cur = { ex, loadPct, fb }. Devuelve { advance, predicted, observed,
   ratio, source, conf } o null si falta cualquier pieza (sin señal). */
function _rotationAdvance(prev, cur, profile){
  if (!prev || !cur) return null;
  const prevLoad = _feedbackLoadKg(prev.ex, prev.loadPct, prev.fb, profile);
  const curLoad  = _feedbackLoadKg(cur.ex,  cur.loadPct,  cur.fb,  profile);
  const prevReps = prev.fb && prev.fb.reps_done;
  const curReps  = cur.fb  && cur.fb.reps_done;
  const e1Prev = _e1rmFromFeedback(prevLoad, prevReps);
  const e1Cur  = _e1rmFromFeedback(curLoad,  curReps);
  if (e1Prev == null || e1Cur == null) return null;
  const rr = _rotationRatio(prev.ex, cur.ex);
  if (!rr || !(rr.ratio > 0)) return null;
  const predicted = e1Prev * rr.ratio;
  if (!(predicted > 0)) return null;
  const advance = (e1Cur - predicted) / predicted;
  return { advance, predicted, observed: e1Cur, ratio: rr.ratio,
           source: rr.source, conf: rr.conf };
}

GEN.progress = function(meso, feedbackByWeek, profile){
  if (!meso || !Array.isArray(meso.weeks))
    return { meso:null, ok:false, reason:['gen_progress_no_meso'] };
  feedbackByWeek = feedbackByWeek || {};

  // Clon profundo defensivo: no mutamos el meso del caller (selección congelada intacta).
  const out = JSON.parse(JSON.stringify(meso));

  // Estado de streaks por patrón a través de semanas (la asimetría es inter-sesión).
  const patternUndershoot = {};   // pattern -> racha de undershoot consecutivo
  const patternOvershoot  = {};   // pattern -> racha de overshoot consecutivo
  // Delta REACTIVO acumulado por bloque CONGELADO (key estable: selección congelada).
  // genMeso produce el plan a priori (ramp open-loop); GEN.progress acumula el ajuste
  // reactivo COMO DELTA sobre ese plan → el ramp planificado y el ajuste reactivo
  // coexisten sin doble conteo. La acumulación es lo que hace la doble progresión
  // transicionar reps→carga a través de las semanas (no parte de cero cada semana).
  const reactiveDelta = {};       // blockKey -> { loadPct, repsAbs } acumulado
  // V4.1: estado de rotación por patrón. Cada patrón en modo rotativo avanza su
  // periodo cada rotation_period_weeks. rotationState[pat] = { period, weeksInPeriod }.
  // V4.2: + lastObs (última variante+feedback de fuerza observados del patrón) para
  // computar el avance por desviación de e1RM al rotar a la variante siguiente.
  const rotationState = {};
  const log = [];

  // V4.1: autochequeo de coherencia de rotación (rotation_period >= meso_duration
  // ⇒ no hay rotación real ⇒ falla ruidosa, análogo a gen_meso_self_drift de V3.4).
  const mesoWeeks = out.weeks.length;
  for (let wi0 = 0; wi0 < out.weeks.length; wi0++){
    const micro0 = out.weeks[wi0] && out.weeks[wi0].microcycle;
    if (!micro0 || !Array.isArray(micro0.sessions)) continue;
    for (const blocks0 of micro0.sessions){
      for (const b0 of (blocks0 || [])){
        if (b0 && b0.progression_mode === 'rotational'){
          const per = (typeof b0.rotation_period_weeks === 'number' && b0.rotation_period_weeks > 0)
                      ? b0.rotation_period_weeks : 1;
          if (per >= mesoWeeks){
            return { meso:null, ok:false,
                     reason:['gen_rotational_no_rotation:rotation_period_weeks(' + per +
                             ')>=meso_duration(' + mesoWeeks + ')'] };
          }
        }
      }
    }
  }

  for (let wi = 0; wi < out.weeks.length; wi++){
    const week = out.weeks[wi];
    const fb = feedbackByWeek[week.week] || feedbackByWeek[wi+1] || {};
    const byBlock = fb.byBlock || {};
    const micro = week.microcycle;
    if (!micro || !Array.isArray(micro.sessions)) continue;

    // Deload weeks: no se progresa (es descarga planificada) y NO acumula delta.
    if (week.type === 'planned_deload'){ log.push({week:week.week, action:'deload_skip'}); continue; }

    for (let si = 0; si < micro.sessions.length; si++){
      const blocks = micro.sessions[si] || [];
      for (let bi = 0; bi < blocks.length; bi++){
        const block = blocks[bi];
        const key = 's' + si + '_b' + bi;
        const f = byBlock[key] || null;
        const pat = _blockPrimaryPattern(block);
        const rd = _rirDelta(block, f);

        // (1) Aplica el delta reactivo ACUMULADO de semanas previas al estado planificado
        //     de esta semana ANTES de evaluar la nueva señal (la progresión es acumulativa).
        const acc = reactiveDelta[key] || { loadPct:0, repsAbs:0 };
        if (block.params){
          if (typeof block.params.load_pct_1rm === 'number' && acc.loadPct)
            block.params.load_pct_1rm = Math.max(0, Math.min(100, block.params.load_pct_1rm + acc.loadPct));
          if (typeof block.params.reps_target === 'number' && acc.repsAbs)
            block.params.reps_target = block.params.reps_target + acc.repsAbs;
        }

        // (2) Actualiza streaks por patrón ANTES de decidir (la decisión usa el streak vigente).
        if (rd != null){
          if (rd <= -2){ patternUndershoot[pat] = (patternUndershoot[pat]||0)+1; patternOvershoot[pat]=0; }
          else if (rd >= 2){ patternOvershoot[pat] = (patternOvershoot[pat]||0)+1; patternUndershoot[pat]=0; }
          else { patternUndershoot[pat]=0; patternOvershoot[pat]=0; }
        }

        const fatigueState = _deriveFatigueState({
          undershootStreakMax: patternUndershoot[pat]||0,
          overshootStreakMax:  patternOvershoot[pat]||0,
          mrvGroups: 0 });

        // (3) Decide y aplica la progresión de ESTA semana sobre el estado ya acumulado.
        const loadPre = (block.params && typeof block.params.load_pct_1rm==='number') ? block.params.load_pct_1rm : null;
        const repsPre = (block.params && typeof block.params.reps_target==='number') ? block.params.reps_target : null;

        // V4.1: si el bloque está en modo rotativo, calcula periodo de rotación + si toca rotar.
        const ctx = { zone: block.zone, rirDelta: rd,
          undershootStreak: patternUndershoot[pat]||0,
          overshootStreak:  patternOvershoot[pat]||0,
          fatigueState };
        if (block.progression_mode === 'rotational'){
          const period = (typeof block.rotation_period_weeks === 'number' && block.rotation_period_weeks > 0)
                         ? block.rotation_period_weeks : 1;
          // El estado de rotación se indexa por patrón (la unidad rotativa es el patrón).
          let st = rotationState[pat];
          if (!st){ st = { period: 0, weeksInPeriod: 0, lastWeek: -1 }; rotationState[pat] = st; }
          // Avanza el contador de semanas del patrón solo una vez por semana.
          let rotationDue = false;
          if (st.lastWeek !== wi){
            st.lastWeek = wi;
            if (st.weeksInPeriod === 0){
              rotationDue = true;                 // inicio de un nuevo periodo → rota
            } else if (st.weeksInPeriod >= period){
              st.period += 1; st.weeksInPeriod = 0; rotationDue = true;
            }
            st.weeksInPeriod += 1;
          }
          ctx.rotationPeriodIdx = st.period;
          ctx.rotationDue = rotationDue;
          ctx.pool = _rotationPool(block, profile);
          ctx.mesoWeeks = mesoWeeks;
          ctx.period = period;

          // V4.2: computa el AVANCE (desviación de e1RM predicho) si hay feedback de
          // esta semana y un rendimiento previo del patrón (st.lastObs). La variante de
          // ESTA semana es la del periodo vigente; el feedback es sobre esa variante.
          ctx.rotationAdvance = null;
          const curEx = _rotationVariantForPeriod(ctx.pool, st.period);
          if (f && f.reps_done != null && st.lastObs && curEx){
            const adv = _rotationAdvance(
              st.lastObs,
              { ex: curEx, loadPct: (block.params && block.params.load_pct_1rm), fb: f },
              profile);
            if (adv) ctx.rotationAdvance = adv;
          }
        }
        const r = _progressBlock(block, ctx);
        // (4) Acumula el cambio de ESTA semana al delta reactivo persistente del bloque.
        if (r.changed){
          // El delta reactivo acumulado es la mecánica de V3.5 (acumulativo). En modo
          // rotativo el cambio es de VARIANTE (no de carga/reps acumulables): no se
          // acumula delta — el reset de reps al piso es el punto de partida de la
          // nueva variante, no un ajuste reactivo persistente.
          if (block.progression_mode !== 'rotational' && block.params){
            const loadPost = (typeof block.params.load_pct_1rm==='number') ? block.params.load_pct_1rm : loadPre;
            const repsPost = (typeof block.params.reps_target==='number') ? block.params.reps_target : repsPre;
            if (loadPre != null && loadPost != null) acc.loadPct += (loadPost - loadPre);
            if (repsPre != null && repsPost != null) acc.repsAbs += (repsPost - repsPre);
            reactiveDelta[key] = acc;
          }
          log.push({week:week.week, session:si, block:bi, pattern:pat, action:r.action, detail:r.detail});
        }

        // V4.2: registra la observación de fuerza de ESTA semana para el patrón rotativo
        // (variante vigente + feedback). st.lastObs es el dato de la variante en curso,
        // desde el cual se predice la siguiente al rotar.
        if (block.progression_mode === 'rotational' && f && f.reps_done != null){
          const st2 = rotationState[pat];
          if (st2){
            st2.lastObs = { ex: block.exercise,
                            loadPct: (block.params && block.params.load_pct_1rm),
                            fb: f };
          }
        }
      }
    }

    // --- COMPUERTA DE MICROCICLO (decisión 3): tras progresar, revalidar.
    // Si la progresión empujó algún grupo sobre MRV, FRENAR el avance (revertir
    // la subida de carga de los bloques de esa semana = la señal de volumen es un
    // freno legítimo a nivel grupo, por encima de la señal por-bloque).
    const mres = (typeof validateMicrocycleBlocks === 'function')
                 ? validateMicrocycleBlocks(micro) : null;
    if (mres && Array.isArray(mres.flags)){
      const overMrv = mres.flags.some(fl => fl && fl.id === 'muscle_volume_exceeded_mrv');
      week._progression_validated = true;
      week._progression_volume_veto = overMrv;
      if (overMrv) log.push({week:week.week, action:'microcycle_veto_mrv',
                             detail:'progression empujó un grupo sobre MRV — avance frenado a nivel grupo'});
    }
  }

  out._progression_log = log;
  return { meso: out, ok:true, reason:[], _progressed:true };
};

/* Derivación de semilla en cascada (mesociclo→bloque), expuesta para V3.3/V3.4. */
GEN.deriveSeed = _deriveSeed;
GEN.effectiveSeed = _effectiveSeed;
/* GEN + helpers se exportan vía el module.exports del template (build inyecta el cuerpo). */
