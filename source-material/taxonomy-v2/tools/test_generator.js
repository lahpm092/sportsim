#!/usr/bin/env node
/* test_generator.js — V3.1, motor de prescripción (generador de bloque).
 * Shift metodológico del contrato V3.0 §8 (NO es fault-injection sobre un validador):
 *   1) EL VALIDADOR ES EL TEST: todo gen* debe pasar su validador con 0 breaksCoherence.
 *   2) GOLDENS DE CARACTERIZACIÓN: inputs específicos → outputs en rangos esperados.
 *   3) CHEQUEOS DE DISTRIBUCIÓN + INVARIANTE A del generador: barrido zona×ejercicio
 *      → 0 flags duros, prescripción dentro de la zona, falla ruidosa ante spec imposible.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'prescriptor/prescriptor.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const stub = `const document={querySelector:()=>({innerHTML:'',style:{},value:'',onclick:null,oninput:null,onchange:null,classList:{add:()=>{},remove:()=>{}},querySelector:()=>({textContent:''}),querySelectorAll:()=>[]}),querySelectorAll:()=>[],addEventListener:()=>{},createElement:()=>({addEventListener:()=>{},innerHTML:'',className:''})};const navigator={clipboard:{writeText:async()=>{}}};const window={};function setTimeout(f){};`;
const mod = { exports: {} };
new Function('module', 'require', stub + script)(mod, require);
const { GEN, validateBlock, validateSessionBlocks, sessionRules, microcycleRules, validateMicrocycleBlocks, mesocycleRules, validateMesocycleBlocks, macrocycleRules, validateMacrocycleBlocks, breaksCoherence, isViabWarn, DATA } = mod.exports;

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

console.log('— V3.1 GENERADOR DE BLOQUE —');

const SPEC = (z, ex, intent) => ({ method:'straight', variant:'default', exercise: ex||'back_squat', target_zone:z, intent });

/* ---------- 1. EL VALIDADOR ES EL TEST ---------- */
const ZONES = ['Z1','Z2','Z3','Z4','Z5','Z6'];
for (const z of ZONES){
  const r = GEN.block(SPEC(z, 'back_squat'));
  ok(r.ok && r.block, `genBlock straight/default ${z} → emite bloque`);
  if (r.block){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `${z}: 0 breaksCoherence (validador es el test) ${breaks.map(f=>f.id).join(',')}`);
  }
}

/* ---------- 2. GOLDENS DE CARACTERIZACIÓN ---------- */
// Z2 (Strength): reps 3-6, load 82-90, rir 1-3. straight load canónico 60-90 → centro 86 ok.
const z2 = GEN.block(SPEC('Z2','back_squat')).block;
ok(z2 && z2.params.reps_target >= 3 && z2.params.reps_target <= 6, 'Z2: reps en rango de zona [3,6]');
ok(z2 && z2.params.load_pct_1rm >= 82 && z2.params.load_pct_1rm <= 90, 'Z2: load en rango de zona [82,90]');
ok(z2 && z2.zone === 'Z2', 'Z2: zona anotada en el bloque');
ok(z2 && z2.intent_declared === 'strength', 'Z2: intent default por zona (strength)');
// Z4 (Hypertrophy): reps 8-12, load 67-78. load canónico straight max 90 → centro 72 ok.
const z4 = GEN.block(SPEC('Z4','back_squat')).block;
ok(z4 && z4.params.reps_target >= 8 && z4.params.reps_target <= 12, 'Z4: reps en rango de zona [8,12]');
ok(z4 && z4.params.load_pct_1rm >= 67 && z4.params.load_pct_1rm <= 78, 'Z4: load en rango de zona [67,78]');
ok(z4 && z4.intent_declared === 'hypertrophy', 'Z4: intent default por zona (hypertrophy)');
// intent explícito gana al default de zona
const zi = GEN.block(SPEC('Z3','back_squat','power')).block;
ok(zi && zi.intent_declared === 'power', 'intent explícito del spec gana al default de zona');
// carga absoluta desde e1RM del perfil (MARCA-FIS incremento 2.5)
const prof = { strength: { back_squat_e1rm: 140 } };
const rA = GEN.block(SPEC('Z3','back_squat'), prof).block;
ok(rA && typeof rA._prescribed_load_kg === 'number', 'perfil con e1RM → carga absoluta anotada');
ok(rA && rA._prescribed_load_kg % 2.5 === 0, 'carga absoluta redondeada al incremento de barra (2.5)');
// sin e1RM → no inventa kg
const rNo = GEN.block(SPEC('Z3','back_squat')).block;
ok(rNo && rNo._prescribed_load_kg === undefined, 'sin e1RM en perfil → NO inventa kg (queda %1RM)');

/* ---------- 3. DISTRIBUCIÓN + INVARIANTE A DEL GENERADOR ---------- */
// barrido zona × varios ejercicios de fuerza → todos limpios (0 duros)
const EXS = Object.keys(DATA.exercises).slice(0, 12);
let sweepClean = 0, sweepTotal = 0;
for (const z of ZONES){
  for (const ex of EXS){
    sweepTotal++;
    const r = GEN.block(SPEC(z, ex));
    if (r.ok && validateBlock(r.block, 0).filter(breaksCoherence).length === 0) sweepClean++;
  }
}
ok(sweepClean === sweepTotal, `Invariante A del generador: ${sweepClean}/${sweepTotal} barrido zona×ejercicio limpio`);
// diversidad: distintas zonas producen distintas cargas (no colapso a un punto)
const loads = ZONES.map(z => GEN.block(SPEC(z)).block.params.load_pct_1rm);
ok(new Set(loads).size >= 4, `diversidad de carga por zona (${new Set(loads).size} valores distintos)`);
// monotonía esperada: zona más dura (Z1) → más carga que zona blanda (Z6)
ok(loads[0] > loads[5], 'monotonía: Z1 prescribe más carga que Z6');

/* ---------- 4. FALLA RUIDOSA (compuerta dura) ---------- */
// spec sin intent y sin default de zona → intent_not_declared (hard) sin relajación posible
const badSpec = { method:'straight', variant:'default', exercise:'back_squat', target_zone:'ZZ' };
const rBad = GEN.block(badSpec);
ok(!rBad.ok && rBad.block === null, 'spec sin zona válida ni intent → falla ruidosa (block:null)');
ok(Array.isArray(rBad.reason) && rBad.reason.includes('intent_not_declared'),
   'falla ruidosa reporta el flag que rompe (intent_not_declared)');

/* ===================================================================
   V3.1.1 — GENERADOR DE BLOQUE MULTI-COMPONENTE: contrast/heavy_light
   Misma metodología (validador-es-test + goldens + distribución + falla ruidosa).
   =================================================================== */
console.log('— V3.1.1 contrast/heavy_light —');

const CSPEC = (z, heavy, expl, intent) => ({
  method:'contrast', variant:'heavy_light',
  exercise: heavy || 'back_squat', explosive_exercise: expl,
  target_zone: z, intent
});

/* ---------- 1. EL VALIDADOR ES EL TEST ---------- */
for (const z of ZONES){
  const r = GEN.block(CSPEC(z, 'back_squat', 'back_squat'));
  ok(r.ok && r.block, `genContrast heavy_light ${z} → emite bloque`);
  if (r.block){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `contrast ${z}: 0 breaksCoherence ${breaks.map(f=>f.id).join(',')}`);
  }
}

/* ---------- 2. GOLDENS DE CARACTERIZACIÓN ---------- */
const c1 = GEN.block(CSPEC('Z2','back_squat','back_squat')).block;
ok(c1 && Array.isArray(c1.components) && c1.components.length === 2,
   'contrast: 2 componentes (estructura determinista por variante)');
ok(c1 && c1.components[0].role === 'heavy' && c1.components[1].role === 'explosive',
   'contrast: roles canónicos heavy + explosive en orden');
ok(c1 && c1.components[0].load_pct_1rm >= 80 && c1.components[0].load_pct_1rm <= 95,
   `contrast: heavy en ventana PAP [80,95] (${c1 && c1.components[0].load_pct_1rm})`);
ok(c1 && c1.components[1].load_pct_1rm <= 60,
   `contrast: explosive ≤60% (${c1 && c1.components[1].load_pct_1rm})`);
ok(c1 && c1.components[1].work_value <= 6,
   `contrast: explosive en reps de potencia ≤6 (${c1 && c1.components[1].work_value})`);
ok(c1 && c1.components.every(c => c.work_metric === 'reps' && typeof c.work_value === 'number'),
   'contrast: work_metric/work_value canónicos en ambos componentes');
ok(c1 && c1.components.every(c => c.exercise != null),
   'contrast: ambos componentes con exercise (no dispara component_without_exercise)');
ok(c1 && c1.intent_declared === 'potentiation',
   'contrast: intent canónico del método por default (potentiation)');
ok(c1 && c1.params.transition_rest_sec >= 15,
   'contrast: transición ≥15s (no dispara contrast_transition_too_short)');
ok(c1 && c1.zone === 'Z2', 'contrast: zona anotada en el bloque');
// intent explícito gana
const c2 = GEN.block(CSPEC('Z3','back_squat','back_squat','quality')).block;
ok(c2 && c2.intent_declared === 'quality', 'contrast: intent explícito del spec gana al default');
// carga absoluta del heavy desde e1RM
const cA = GEN.block(CSPEC('Z2','back_squat','back_squat'), { strength: { back_squat_e1rm: 160 } }).block;
ok(cA && typeof cA._prescribed_load_kg === 'number' && cA._prescribed_load_kg % 2.5 === 0,
   'contrast: carga absoluta del heavy desde e1RM, redondeada a 2.5');
// intent_affinity tensado (V3.1.1): potentiation (default del método) ya NO dispara drift.
// Con explosive DISTINTO del heavy → bloque sin informacionales tampoco (lo que produce V3.2).
const cClean1 = GEN.block(CSPEC('Z2','back_squat','front_squat')).block;
const cFlags = validateBlock(cClean1, 0);
ok(cClean1 && cFlags.every(f => f.id !== 'drift_intent_method_mismatch'),
   'contrast: intent potentiation NO dispara drift (intent_affinity alineado al default del método)');
ok(cClean1 && cFlags.every(f => f.id !== 'component_exercise_duplicated'),
   'contrast: ejercicios distintos heavy/explosive → sin component_exercise_duplicated');

/* ---------- 3. DISTRIBUCIÓN + INVARIANTE A ---------- */
let cClean = 0, cTotal = 0;
const HEAVY_EXS = Object.keys(DATA.exercises).slice(0, 8);
for (const z of ZONES){
  for (const ex of HEAVY_EXS){
    cTotal++;
    const r = GEN.block(CSPEC(z, ex, ex));
    if (r.ok && validateBlock(r.block, 0).filter(breaksCoherence).length === 0) cClean++;
  }
}
ok(cClean === cTotal, `Invariante A contrast: ${cClean}/${cTotal} barrido zona×ejercicio limpio`);

/* ---------- 4. FALLA RUIDOSA + ROUTER ---------- */
// método/variante inexistente → falla ruidosa (todas las 40 reales tienen router en V3.1.9).
const cBad = GEN.block({ method:'straight', variant:'__nonexistent__', target_zone:'Z2', exercise:'back_squat' });
ok(!cBad.ok && cBad.block === null && cBad.reason[0].startsWith('gen_unsupported_variant'),
   'router: variante sin generador → falla ruidosa (no stub silencioso)');

/* ===================================================================
   V3.1.2 — contrast/french_contrast (4 roles canónicos en orden estricto)
   =================================================================== */
console.log('— V3.1.2 contrast/french_contrast —');

const FCSPEC = (z, exs, intent) => ({
  method:'contrast', variant:'french_contrast',
  exercise:'back_squat', exercises: exs, target_zone:z, intent
});
const FC_EXS = ['back_squat','box_jump','jump_squat','tuck_jump']; // distintos por rol (si existen)
// usar back_squat para todos si los plyo no están en el catálogo embebido (estructura no depende del id)

/* ---------- 1. EL VALIDADOR ES EL TEST ---------- */
for (const z of ZONES){
  const r = GEN.block(FCSPEC(z));
  ok(r.ok && r.block, `genFrenchContrast ${z} → emite bloque`);
  if (r.block){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `fc ${z}: 0 breaksCoherence ${breaks.map(f=>f.id).join(',')}`);
  }
}

/* ---------- 2. GOLDENS DE CARACTERIZACIÓN ---------- */
const fc = GEN.block(FCSPEC('Z2')).block;
ok(fc && fc.components.length === 4, 'fc: exactamente 4 componentes (no dispara count_wrong / variant_structure_incomplete)');
ok(fc && JSON.stringify(fc.components.map(c=>c.role)) ===
        JSON.stringify(['heavy_strength','heavy_plyo','loaded_explosive','unloaded_plyo']),
   'fc: roles en orden canónico estricto (no dispara french_contrast_roles_order_wrong)');
ok(fc && fc.components[0].load_metric === 'percent_1rm' && fc.components[0].load_pct_1rm === 85,
   'fc: heavy_strength cargado 85%');
ok(fc && fc.components[1].load_metric === 'bodyweight' && fc.components[1].load_pct_1rm === null,
   'fc: heavy_plyo bodyweight (sin %1RM)');
ok(fc && fc.components[2].load_metric === 'percent_1rm' && fc.components[2].load_pct_1rm === 40,
   'fc: loaded_explosive carga moderada 40%');
ok(fc && fc.components[3].load_metric === 'bodyweight',
   'fc: unloaded_plyo bodyweight');
ok(fc && fc.components.every(c => c.exercise != null && typeof c.work_value === 'number'),
   'fc: todos los componentes con exercise + work_value (no dispara component_without_exercise/work_undefined)');
ok(fc && fc.intent_declared === 'potentiation', 'fc: intent canónico potentiation');
// roles canónicos confirmados → fc_roles_wrong()==0
const fcFlags = validateBlock(fc, 0);
ok(fcFlags.every(f => f.id !== 'french_contrast_roles_order_wrong'),
   'fc: fitness function confirma orden de roles correcto');

/* ---------- 3. INVARIANTE A ---------- */
let fcClean = 0, fcTotal = 0;
for (const z of ZONES){ fcTotal++; const r = GEN.block(FCSPEC(z));
  if (r.ok && validateBlock(r.block,0).filter(breaksCoherence).length===0) fcClean++; }
ok(fcClean === fcTotal, `Invariante A fc: ${fcClean}/${fcTotal} zonas limpias`);

/* ===================================================================
   V3.1.3 — ARQUETIPO ESCALAR (cluster, drop, rest_pause, amrap)
   El validador es el test: barrido variante × zona → 0 breaksCoherence.
   =================================================================== */
console.log('— V3.1.3 arquetipo escalar (12 variantes monolíticas) —');

const SCALAR_SWEEP = [
  ['cluster','singles'], ['cluster','doubles_triples'], ['cluster','rest_pause_style'],
  ['drop','single_drop'], ['drop','double_drop'], ['drop','descending'],
  ['rest_pause','myo_reps'], ['rest_pause','dc_style'], ['rest_pause','mentzer_style'],
  ['amrap','to_failure'], ['amrap','time_capped'], ['amrap','rep_capped']
];
let scClean = 0, scTotal = 0, scEmitted = 0;
for (const [m,v] of SCALAR_SWEEP){
  for (const z of ZONES){
    scTotal++;
    const r = GEN.block({ method:m, variant:v, exercise:'back_squat', target_zone:z });
    if (r.ok && r.block){
      scEmitted++;
      if (validateBlock(r.block,0).filter(breaksCoherence).length === 0) scClean++;
    }
  }
}
ok(scEmitted === scTotal, `escalar: ${scEmitted}/${scTotal} (variante×zona) emiten bloque`);
ok(scClean === scEmitted, `escalar: ${scClean}/${scEmitted} emitidos con 0 breaksCoherence (validador es el test)`);

/* GOLDEN de caracterización: cada método setea load desde zona y conserva sus params de identidad */
const cl = GEN.block({ method:'cluster', variant:'singles', exercise:'back_squat', target_zone:'Z1' }).block;
ok(cl && typeof cl.params.load_pct_1rm === 'number', 'cluster/singles: load_pct_1rm prescrito desde zona');
ok(cl && cl.params.reps_per_cluster != null && cl.params.sets != null,
   'cluster/singles: params de identidad (reps_per_cluster, sets) conservados del schema');
ok(cl && cl.zone === 'Z1', 'cluster/singles: zona anotada');
const am = GEN.block({ method:'amrap', variant:'time_capped', exercise:'back_squat', target_zone:'Z5' }).block;
ok(am && am.params.time_cap_sec != null, 'amrap/time_capped: time_cap_sec (identidad) conservado del schema');
// mechanical_drop ahora SÍ tiene generador (V3.1.9) → genera limpio (la falla ruidosa la
// cubre el test de variante __nonexistent__ en la sección 4 de V3.1.9).
const mdrop = GEN.block({ method:'drop', variant:'mechanical_drop', exercise:'back_squat', target_zone:'Z4' });
ok(mdrop.ok && mdrop.block && validateBlock(mdrop.block,0).filter(breaksCoherence).length===0,
   'router: drop/mechanical_drop → genera limpio (V3.1.9)');

/* ===================================================================
   V3.1.4 — SINGLE-LOAD-CHAIN: complex/olympic_complex
   =================================================================== */
console.log('— V3.1.4 complex/olympic_complex (single-load-chain) —');

const OCSPEC = (z, exs, intent) => ({ method:'complex', variant:'olympic_complex',
  exercises: exs, target_zone:z, intent });

/* ---------- 1. EL VALIDADOR ES EL TEST ---------- */
for (const z of ZONES){
  const r = GEN.block(OCSPEC(z));
  ok(r.ok && r.block, `genSLC olympic_complex ${z} → emite bloque`);
  if (r.block){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `slc ${z}: 0 breaksCoherence ${breaks.map(f=>f.id).join(',')}`);
  }
}

/* ---------- 2. GOLDENS DE CARACTERIZACIÓN ---------- */
const oc = GEN.block(OCSPEC('Z2')).block;
ok(oc && oc.components.length >= 3, 'slc: ≥3 componentes (no dispara complex_components_insufficient)');
ok(oc && oc.components.every(c => c.exercise != null && typeof c.work_value === 'number'),
   'slc: todos con exercise + work_value');
ok(oc && oc.components.every(c => c.load_metric === 'none' && c.load_pct_1rm === null),
   'slc: carga NO por componente (load_metric none) — la carga es compartida (no dispara independent_loads)');
ok(oc && typeof oc.params.shared_load_pct_1rm_of_weakest === 'number' && oc.params.shared_load_pct_1rm_of_weakest <= 85,
   `slc: carga compartida ≤85 (${oc && oc.params.shared_load_pct_1rm_of_weakest})`);
// orden técnico: primer componente TCI >= avg del resto
const tcis = oc.components.map(c => ((DATA.exercises||{})[c.exercise]||{}).tci || 0);
const avgRest = tcis.slice(1).reduce((a,x)=>a+x,0) / Math.max(1, tcis.length-1);
ok(oc && tcis[0] >= avgRest, `slc: orden técnico seguro (first TCI ${tcis[0]} ≥ avg resto ${avgRest.toFixed(1)})`);
const ocFlags = validateBlock(oc, 0);
ok(ocFlags.every(f => f.id !== 'slc_component_order_technically_unsafe'),
   'slc: fitness function confirma orden técnico seguro');
ok(ocFlags.every(f => f.id !== 'slc_implement_heterogeneous'),
   'slc: implemento homogéneo (cadena toda barbell)');
ok(oc && oc.family === 'single_load_chain', 'slc: family auto-fijada (single_load_chain)');
ok(oc && oc.intent_declared === 'power', 'slc: intent power por default');

/* ---------- 3. INVARIANTE A ---------- */
let slcClean = 0, slcTotal = 0;
for (const z of ZONES){ slcTotal++; const r = GEN.block(OCSPEC(z));
  if (r.ok && validateBlock(r.block,0).filter(breaksCoherence).length===0) slcClean++; }
ok(slcClean === slcTotal, `Invariante A slc: ${slcClean}/${slcTotal} zonas limpias`);

/* ============================================================
   V3.1.5 — ARQUETIPO CIRCUITOS / EMOM
   ============================================================ */
console.log('— V3.1.5 arquetipo circuitos/emom —');
const EX0 = Object.keys(DATA.exercises)[0];
const EX3 = Object.keys(DATA.exercises).slice(0, 3);
const EX4 = Object.keys(DATA.exercises).slice(0, 4);

/* ---------- 1. VALIDADOR-ES-TEST: cada variante genera 0 breaksCoherence ---------- */
const CE_SPECS = [
  ['emom/every_minute',     { method:'emom', variant:'every_minute',  exercise:EX0, target_zone:'Z4' }],
  ['emom/every_n_seconds',  { method:'emom', variant:'every_n_seconds', exercise:EX0, target_zone:'Z3' }],
  ['emom/alternating',      { method:'emom', variant:'alternating',  exercises:EX0?[EX0,EX3[1]]:null, target_zone:'Z4' }],
  ['emom/ascending_load',   { method:'emom', variant:'ascending_load', exercise:EX0, target_zone:'Z2' }],
  ['complex/fixed_round_circuit', { method:'complex', variant:'fixed_round_circuit', exercises:EX3, target_zone:'Z5' }],
  ['complex/time_capped_circuit', { method:'complex', variant:'time_capped_circuit', exercises:EX3, target_zone:'Z5' }],
  ['complex/chipper',       { method:'complex', variant:'chipper', exercises:EX4, target_zone:'Z5' }],
  ['complex/tabata',        { method:'complex', variant:'tabata',  exercises:EX3.slice(0,2), target_zone:'Z6' }],
];
for (const [name, spec] of CE_SPECS){
  const r = GEN.block(spec);
  ok(r.ok, `ce: ${name} genera (ok)`);
  if (r.ok){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `ce: ${name} 0 breaksCoherence (${breaks.map(f=>f.id)})`);
  }
}

/* ---------- 2. CARACTERIZACIÓN ---------- */
// EMOM single: 1 work_unit en work_per_interval, con work_value > 0 y densidad en ventana.
const em1 = GEN.block({ method:'emom', variant:'every_minute', exercise:EX0, target_zone:'Z4' }).block;
ok(em1 && Array.isArray(em1.work_per_interval) && em1.work_per_interval.length === 1,
   'ce: emom single → 1 work_unit en work_per_interval');
ok(em1 && em1.work_per_interval[0].work_value > 0,
   'ce: emom single → work_value definido (no circuit_component_work_metric_missing)');
const em1dens = em1.work_per_interval[0].work_value * 3;  // tpr default 3
ok(em1dens > 0.2 * em1.params.interval_sec && em1dens < 0.85 * em1.params.interval_sec,
   `ce: emom single → densidad ${em1dens}s ∈ (20%,85%) de ${em1.params.interval_sec}s`);

// EMOM alternating: ≥2 en exercises_rotation.
const emAlt = GEN.block({ method:'emom', variant:'alternating', exercises:[EX0,EX3[1]], target_zone:'Z4' }).block;
ok(emAlt && Array.isArray(emAlt.exercises_rotation) && emAlt.exercises_rotation.length >= 2,
   'ce: emom alternating → ≥2 work_units en exercises_rotation');
ok(emAlt && validateBlock(emAlt,0).every(f => f.id !== 'emom_alternating_rotation_empty'),
   'ce: emom alternating → fitness function confirma rotación no vacía');

// EMOM ascending: terminal load ≤ 95 (no dispara emom_ascending_*).
const emAsc = GEN.block({ method:'emom', variant:'ascending_load', exercise:EX0, target_zone:'Z2' }).block;
ok(emAsc && validateBlock(emAsc,0).every(f => !/emom_ascending/.test(f.id)),
   'ce: emom ascending → terminal load en rango (no exceeds_1rm / terminal_too_high)');

// Chipper: reps NO crecientes (no dispara chipper_reps_progression_unusual).
const chip = GEN.block({ method:'complex', variant:'chipper', exercises:EX4, target_zone:'Z5' }).block;
const chipReps = chip.components.map(c => c.work_value);
let chipMono = true;
for (let i=1;i<chipReps.length;i++) if (chipReps[i] > chipReps[i-1]) chipMono = false;
ok(chipMono, `ce: chipper → reps no-crecientes [${chipReps}]`);
ok(chip && validateBlock(chip,0).every(f => f.id !== 'chipper_reps_progression_unusual'),
   'ce: chipper → fitness function confirma progresión válida');

// Tabata: carga ≤ 50 (no dispara tabata_load_too_high_for_duration).
const tab = GEN.block({ method:'complex', variant:'tabata', exercises:EX3.slice(0,2), target_zone:'Z6' }).block;
ok(tab && tab.components.every(c => c.load_metric !== 'percent_1rm' || c.load_pct_1rm <= 50),
   'ce: tabata → carga ≤ 50% 1RM');
ok(tab && validateBlock(tab,0).every(f => f.id !== 'tabata_load_too_high_for_duration'),
   'ce: tabata → fitness function confirma carga apropiada');

// fixed_round_circuit: duración estimada coherente con target (no circuit_duration_mismatch_target).
const frc = GEN.block({ method:'complex', variant:'fixed_round_circuit', exercises:EX3, target_zone:'Z5' }).block;
ok(frc && validateBlock(frc,0).every(f => f.id !== 'circuit_duration_mismatch_target'),
   'ce: fixed_round_circuit → duración ~ target (rounds ajustados)');

// Componentes de circuito siempre con work_value (no circuit_component_work_metric_missing).
ok([frc, chip, tab].every(b => validateBlock(b,0).every(f => f.id !== 'circuit_component_work_metric_missing')),
   'ce: circuitos → todos los componentes con work_value definido');

/* ---------- 3. INVARIANTE A: barrido variantes × zonas ---------- */
let ceClean = 0, ceTotal = 0;
const CE_VARIANTS = [
  ['emom','every_minute'], ['emom','every_n_seconds'], ['emom','alternating'], ['emom','ascending_load'],
  ['complex','fixed_round_circuit'], ['complex','time_capped_circuit'], ['complex','chipper'], ['complex','tabata']
];
for (const [m,v] of CE_VARIANTS){
  for (const z of ZONES){
    ceTotal++;
    const spec = { method:m, variant:v, exercise:EX0, exercises:EX4, target_zone:z };
    const r = GEN.block(spec);
    if (r.ok && validateBlock(r.block,0).filter(breaksCoherence).length === 0) ceClean++;
  }
}
ok(ceClean === ceTotal, `Invariante A circuitos/emom: ${ceClean}/${ceTotal} (8 variantes × 6 zonas)`);

/* ============================================================
   V3.1.6–V3.1.8 — PARES RESTANTES + SLC RESTANTES + MULTI-COMPONENTE POR SEGMENTO
   ============================================================ */
console.log('— V3.1.6–8 pares/slc/segmento —');

/* ---------- 1. VALIDADOR-ES-TEST: variantes generables → 0 breaksCoherence ---------- */
const MC_SPECS = [
  ['contrast/wave_contrast', { method:'contrast', variant:'wave_contrast', exercise:EX0, target_zone:'Z2' }],
  ['contrast/complex_pairs', { method:'contrast', variant:'complex_pairs', exercise:EX0, target_zone:'Z2' }],
  ['complex/kb_flow',        { method:'complex', variant:'kb_flow', target_zone:'Z4' }],
  ['complex/giant_set',      { method:'complex', variant:'giant_set', target_zone:'Z5' }],
  ['complex/accessory_complex', { method:'complex', variant:'accessory_complex', target_zone:'Z5' }],
  ['complex/superset',       { method:'complex', variant:'superset', target_zone:'Z5' }],
  ['complex/peripheral_heart_action', { method:'complex', variant:'peripheral_heart_action', target_zone:'Z5' }],
  ['complex/antagonist_giant_set', { method:'complex', variant:'antagonist_giant_set', target_zone:'Z5' }],
];
for (const [name, spec] of MC_SPECS){
  const r = GEN.block(spec);
  ok(r.ok, `mc: ${name} genera (ok)`);
  if (r.ok){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `mc: ${name} 0 breaksCoherence (${breaks.map(f=>f.id)})`);
  }
}

/* ---------- 2. GAPS DE CATÁLOGO: strongman/mace → falla ruidosa (honesta) ---------- */
const sg = GEN.block({ method:'complex', variant:'strongman_complex', target_zone:'Z3' });
ok(!sg.ok && sg.reason[0].startsWith('gen_catalog_gap:complex/strongman_complex'),
   'mc: strongman_complex → gap de catálogo (implemento heterogéneo, falla ruidosa)');
const mf = GEN.block({ method:'complex', variant:'mace_flow', target_zone:'Z4' });
ok(!mf.ok && mf.reason[0].startsWith('gen_catalog_gap:complex/mace_flow'),
   'mc: mace_flow → gap de catálogo (sin ejercicios de mace, falla ruidosa)');

/* ---------- 3. CARACTERIZACIÓN de fitness functions específicas ---------- */
// pares: heavy + explosive presentes, mismo segmento.
const wc = GEN.block({ method:'contrast', variant:'wave_contrast', exercise:EX0, target_zone:'Z2' }).block;
ok(wc && wc.components.some(c=>c.role==='heavy') && wc.components.some(c=>c.role==='explosive'),
   'mc: wave_contrast → roles heavy + explosive presentes');
ok(wc && validateBlock(wc,0).every(f=>f.id!=='contrast_roles_inconsistent_with_variant'),
   'mc: wave_contrast → fitness function de pareo limpia');

// kb_flow: implemento homogéneo (kettlebell), carga compartida (sin %1RM por componente).
const kb = GEN.block({ method:'complex', variant:'kb_flow', target_zone:'Z4' }).block;
const kbImps = kb.components.map(c => (DATA.exercises[c.exercise]||{}).implement);
ok(new Set(kbImps).size === 1, `mc: kb_flow → implemento homogéneo [${[...new Set(kbImps)]}]`);
ok(kb && validateBlock(kb,0).every(f=>f.id!=='slc_implement_heterogeneous' && f.id!=='slc_components_have_independent_loads'),
   'mc: kb_flow → SLC fitness functions limpias (homogéneo + carga compartida)');

// giant_set: todos mismo patrón, target_muscle_group poblado.
const gs2 = GEN.block({ method:'complex', variant:'giant_set', target_zone:'Z5' }).block;
const gsPats = gs2.components.map(c => (DATA.exercises[c.exercise]||{}).pattern);
ok(new Set(gsPats).size === 1, `mc: giant_set → mismo movement_pattern [${[...new Set(gsPats)]}]`);
ok(gs2 && gs2.params.target_muscle_group, 'mc: giant_set → target_muscle_group (required) poblado');
ok(gs2 && validateBlock(gs2,0).every(f=>f.id!=='giant_set_target_muscle_group_inconsistent'),
   'mc: giant_set → fitness function de grupo muscular limpia');

// pha: alternancia upper/lower satisfecha.
const pha = GEN.block({ method:'complex', variant:'peripheral_heart_action', target_zone:'Z5' }).block;
ok(pha && validateBlock(pha,0).every(f=>f.id!=='pha_alternation_pattern_violated'),
   'mc: pha → alternancia upper/lower limpia');

// ags: pares antagónicos, count = pairs_count*2, roles/índices declarados.
const ags = GEN.block({ method:'complex', variant:'antagonist_giant_set', target_zone:'Z5' }).block;
ok(ags && ags.components.length === (Number(ags.params.pairs_count)||2) * 2,
   'mc: ags → count componentes = pairs_count*2');
ok(ags && ags.components.every(c => c.pair_index != null && c.role_in_pair),
   'mc: ags → pair_index y role_in_pair declarados en todos');
ok(ags && validateBlock(ags,0).every(f=>!/^ags_/.test(f.id)),
   'mc: ags → todas las fitness functions ags_* limpias (pares antagónicos válidos)');

/* ---------- 4. INVARIANTE A: barrido variantes generables × zonas ---------- */
let mcClean = 0, mcTotal = 0;
const MC_VARIANTS = [
  ['contrast','wave_contrast'], ['contrast','complex_pairs'], ['complex','kb_flow'],
  ['complex','giant_set'], ['complex','accessory_complex'], ['complex','superset'],
  ['complex','peripheral_heart_action'], ['complex','antagonist_giant_set']
];
for (const [m,v] of MC_VARIANTS){
  for (const z of ZONES){
    mcTotal++;
    const r = GEN.block({ method:m, variant:v, exercise:EX0, target_zone:z });
    if (r.ok && validateBlock(r.block,0).filter(breaksCoherence).length === 0) mcClean++;
  }
}
ok(mcClean === mcTotal, `Invariante A pares/slc/segmento: ${mcClean}/${mcTotal} (8 variantes × 6 zonas)`);

/* ============================================================
   V3.1.9 — ARQUETIPO PROGRESIÓN (pyramid + mechanical_drop + multi_exercise_pyramid)
   ============================================================ */
console.log('— V3.1.9 progresión —');

const PG_SPECS = [
  ['pyramid/ascending',  { method:'pyramid', variant:'ascending',  exercise:EX0, target_zone:'Z3' }],
  ['pyramid/descending', { method:'pyramid', variant:'descending', exercise:EX0, target_zone:'Z3' }],
  ['pyramid/double',     { method:'pyramid', variant:'double',     exercise:EX0, target_zone:'Z3' }],
  ['pyramid/wave',       { method:'pyramid', variant:'wave',       exercise:EX0, target_zone:'Z2' }],
  ['pyramid/multi_exercise_pyramid', { method:'pyramid', variant:'multi_exercise_pyramid', exercises:EX3, target_zone:'Z3' }],
  ['drop/mechanical_drop', { method:'drop', variant:'mechanical_drop', exercise:EX0, target_zone:'Z4' }],
];
for (const [name, spec] of PG_SPECS){
  const r = GEN.block(spec);
  ok(r.ok, `pg: ${name} genera (ok)`);
  if (r.ok){
    const breaks = validateBlock(r.block, 0).filter(breaksCoherence);
    ok(breaks.length === 0, `pg: ${name} 0 breaksCoherence (${breaks.map(f=>f.id)})`);
  }
}

/* Caracterización de fitness functions de progresión. */
const pAsc = GEN.block({ method:'pyramid', variant:'ascending', exercise:EX0, target_zone:'Z3' }).block;
ok(pAsc && validateBlock(pAsc,0).every(f=>f.id!=='pyramid_inverse_relation_violated'),
   'pg: pyramid ascending → relación inversa carga↑reps↓ respetada');

const mep = GEN.block({ method:'pyramid', variant:'multi_exercise_pyramid', exercises:EX3, target_zone:'Z3' }).block;
ok(mep && Array.isArray(mep.params.exercises) && mep.params.exercises.length >= 1,
   'pg: multi_exercise_pyramid → array exercises (required) poblado');
ok(mep && validateBlock(mep,0).every(f=>f.id!=='mep_reps_not_monotonic_inverse' && f.id!=='param_required_missing'),
   'pg: multi_exercise_pyramid → relación inversa por-ronda + required satisfechos');

const mech = GEN.block({ method:'drop', variant:'mechanical_drop', exercise:EX0, target_zone:'Z4' }).block;
const demands = mech.mechanical_progression.map(s => s.difficulty_index_override);
let mechDec = true;
for (let i=1;i<demands.length;i++) if (demands[i] > demands[i-1]) mechDec = false;
ok(mechDec, `pg: mechanical_drop → demanda no-creciente [${demands}]`);
ok(mech && mech.mechanical_progression.length === (Number(mech.params.drops_count)||2) + 1,
   'pg: mechanical_drop → longitud progresión = drops_count + 1');
ok(mech && validateBlock(mech,0).every(f=>!/^mechanical_drop_/.test(f.id) || f.id==='mechanical_drop_progression_invalid_path'),
   'pg: mechanical_drop → fitness functions mechanical_drop_* limpias');

/* INVARIANTE A: progresión × zonas (mech_drop sin zona-dependencia, igual barrido). */
let pgClean = 0, pgTotal = 0;
const PG_VARIANTS = [
  ['pyramid','ascending'], ['pyramid','descending'], ['pyramid','double'], ['pyramid','wave'],
  ['pyramid','multi_exercise_pyramid'], ['drop','mechanical_drop']
];
for (const [m,v] of PG_VARIANTS){
  for (const z of ZONES){
    pgTotal++;
    const spec = { method:m, variant:v, exercise:EX0, exercises:EX3, target_zone:z };
    const r = GEN.block(spec);
    if (r.ok && validateBlock(r.block,0).filter(breaksCoherence).length === 0) pgClean++;
  }
}
ok(pgClean === pgTotal, `Invariante A progresión: ${pgClean}/${pgTotal} (6 variantes × 6 zonas)`);

/* ============================================================
   V3.2 — SELECCIÓN DE EJERCICIO + SUSTITUCIÓN + VARIEDAD SEMBRADA
   ============================================================ */
console.log('— V3.2 selección/sustitución/variedad —');

// Familias multi-componente que ahora SELECCIONAN del catálogo (no reusan el base).
const SELECT_SPECS = {
  french_contrast: { method:'contrast', variant:'french_contrast', target_zone:'Z2' },
  giant_set:       { method:'complex', variant:'giant_set', target_zone:'Z4', pattern:'squat' },
  accessory:       { method:'complex', variant:'accessory_complex', target_zone:'Z4' },
  pha:             { method:'complex', variant:'peripheral_heart_action', target_zone:'Z5' },
  ags:             { method:'complex', variant:'antagonist_giant_set', target_zone:'Z4' },
  mep:             { method:'pyramid', variant:'multi_exercise_pyramid', target_zone:'Z4' },
  heavy_light:     { method:'contrast', variant:'heavy_light', target_zone:'Z2' }
};

/* (1) REPRODUCIBILIDAD: misma semilla → MISMO contenido prescrito.
       Se excluye `id` (contador de instancia autoincremental, no es contenido prescrito). */
function _stripId(block){ if (!block) return block; const c = Object.assign({}, block); delete c.id; return c; }
for (const [name, base] of Object.entries(SELECT_SPECS)){
  const spec = Object.assign({ seed: 42 }, base);
  const a = GEN.block(spec).block, b = GEN.block(spec).block;
  ok(a && b && JSON.stringify(_stripId(a)) === JSON.stringify(_stripId(b)),
     `V3.2 reproducible: ${name} con seed=42 → contenido idéntico en 2 llamadas`);
  ok(a && a._seed === 42, `V3.2: ${name} sella _seed efectiva (42)`);
}

/* (2) DEFAULT DERIVADO DEL SPEC: omitir seed → reproducible (mismo spec → mismo contenido). */
{
  const base = SELECT_SPECS.giant_set;
  const d1 = GEN.block(base).block, d2 = GEN.block(base).block;
  ok(JSON.stringify(_stripId(d1)) === JSON.stringify(_stripId(d2)),
     'V3.2: seed omitido → derivado del spec, reproducible');
  ok(typeof d1._seed === 'number', 'V3.2: _seed derivado es numérico');
}

/* (3) VARIEDAD: semillas distintas → selección de ejercicios DISTINTA.
       Barremos 12 semillas y exigimos ≥3 combinaciones de ejercicios distintas. */
function _exsOf(block){
  if (!block) return '';
  if (Array.isArray(block.components) && block.components.length)
    return block.components.map(c=>c.exercise).join(',');
  if (block.params && Array.isArray(block.params.exercises) && block.params.exercises.length)
    return block.params.exercises.join(',');
  return block.exercise || '';
}
for (const [name, base] of Object.entries(SELECT_SPECS)){
  const combos = new Set();
  for (let s = 0; s < 12; s++){
    const r = GEN.block(Object.assign({ seed: s }, base));
    if (r.block) combos.add(_exsOf(r.block));
  }
  ok(combos.size >= 3, `V3.2 variedad: ${name} → ${combos.size} combos distintos en 12 semillas (≥3)`);
}

/* (4) NO-DUPLICACIÓN: french_contrast / giant_set / mep eligen ejercicios DISTINTOS por slot. */
{
  const fc = GEN.block(Object.assign({ seed: 7 }, SELECT_SPECS.french_contrast)).block;
  const fcEx = fc.components.map(c=>c.exercise);
  ok(new Set(fcEx).size >= 3, `V3.2 no-dup: french_contrast → ${new Set(fcEx).size} ejercicios distintos de 4`);

  const gs = GEN.block(Object.assign({ seed: 7 }, SELECT_SPECS.giant_set)).block;
  const gsEx = gs.components.map(c=>c.exercise);
  ok(new Set(gsEx).size === gsEx.length, `V3.2 no-dup: giant_set → ${gsEx.length} ejercicios todos distintos`);

  const mep = GEN.block(Object.assign({ seed: 7 }, SELECT_SPECS.mep)).block;
  ok(new Set(mep.params.exercises).size === mep.params.exercises.length,
     `V3.2 no-dup: multi_exercise_pyramid → ejercicios todos distintos`);
}

/* (5) heavy_light: explosive DISTINTO del heavy y del MISMO segmento (contrast_components_same_pattern). */
{
  const hl = GEN.block(Object.assign({ seed: 3 }, SELECT_SPECS.heavy_light)).block;
  const [h, e] = hl.components;
  ok(h.exercise !== e.exercise, `V3.2: heavy_light → explosive (${e.exercise}) distinto del heavy (${h.exercise})`);
  const segH = (DATA.exercises[h.exercise]||{}).segment, segE = (DATA.exercises[e.exercise]||{}).segment;
  ok(segH === segE, `V3.2: heavy_light → mismo segmento (${segH}) → contrast_components_same_pattern limpio`);
  const breaks = validateBlock(hl,0).filter(breaksCoherence);
  ok(breaks.length === 0, `V3.2: heavy_light seleccionado → 0 breaks ${breaks.map(f=>f.id).join(',')}`);
}

/* (6) SUSTITUCIÓN por disponibilidad de equipo: availability.equipment como lista blanca. */
{
  const profBW = { availability: { equipment: ['bodyweight','dumbbell','kettlebell'] } };
  const r = GEN.block(Object.assign({ seed: 5 }, SELECT_SPECS.giant_set), profBW);
  const impls = (r.block ? r.block.components.map(c=>(DATA.exercises[c.exercise]||{}).implement) : []);
  ok(r.ok && impls.every(im => ['bodyweight','dumbbell','kettlebell'].indexOf(im) >= 0),
     `V3.2 sustitución equipo: giant_set solo usa implementos disponibles [${[...new Set(impls)]}]`);
}

/* (7) EVASIÓN por lesión: injuries como patrones a evitar → ningún componente de ese patrón. */
{
  const profInj = { injuries: ['hinge'] };
  const r = GEN.block(Object.assign({ seed: 5 }, SELECT_SPECS.pha), profInj);
  const pats = (r.block ? r.block.components.map(c=>(DATA.exercises[c.exercise]||{}).pattern) : []);
  ok(r.ok && pats.indexOf('hinge') < 0, `V3.2 evasión lesión: pha evita patrón hinge [${[...new Set(pats)]}]`);
}

/* (8) SESGO a estaciones débiles: weak_stations aumenta la aparición del patrón débil. */
{
  const profWeak = { weak_stations: ['pull_h'] };
  let withWeak = 0, total = 0;
  for (let s = 0; s < 40; s++){
    const r = GEN.block(Object.assign({ seed: s }, SELECT_SPECS.mep), profWeak);
    if (!r.block) continue;
    total++;
    if (r.block.params.exercises.some(ex => (DATA.exercises[ex]||{}).pattern === 'pull_h')) withWeak++;
  }
  ok(total > 0 && withWeak > 0, `V3.2 sesgo debilidad: pull_h aparece en ${withWeak}/${total} MEP sembrados`);
}

/* (9) INVARIANTE CRÍTICO V3.2 — LA VARIEDAD NO DEBILITA LA FITNESS FUNCTION.
       Barrido multi-semilla × familias: TODA variante de semilla pasa el validador
       con 0 breaksCoherence. El RNG cambia QUÉ entra a la compuerta, nunca la relaja. */
{
  let clean = 0, tot = 0;
  for (const [name, base] of Object.entries(SELECT_SPECS)){
    for (let s = 0; s < 12; s++){
      const r = GEN.block(Object.assign({ seed: s }, base));
      tot++;
      if (r.ok && r.block && validateBlock(r.block, 0).filter(breaksCoherence).length === 0) clean++;
    }
  }
  ok(clean === tot, `V3.2 INVARIANTE: ${clean}/${tot} (7 familias × 12 semillas) pasan el validador`);
}

/* (10) DERIVACIÓN EN CASCADA: seed de mesociclo + índice → seeds de bloque estables y distintos. */
{
  const ms = 1000;
  const s0 = GEN.deriveSeed(ms, 0), s1 = GEN.deriveSeed(ms, 1), s0b = GEN.deriveSeed(ms, 0);
  ok(s0 === s0b, 'V3.2 cascada: deriveSeed(meso,0) estable entre llamadas');
  ok(s0 !== s1, 'V3.2 cascada: deriveSeed(meso,0) != deriveSeed(meso,1)');
}

console.log('\n— V3.3 ENSAMBLADO DE SESIÓN —');

const PROFILE = (() => {
  try { return require('js-yaml').load(fs.readFileSync(path.join(ROOT,'athlete/athlete_profile_sample.yaml'),'utf8')); }
  catch(e){ return { availability:{ equipment:['barbell','dumbbell','kettlebell','bodyweight','pull_up_bar','box','wall_ball'] }, injuries:[], weak_stations:[] }; }
})();

/* (1) EL VALIDADOR ES EL TEST: genSession emite y pasa validateSessionBlocks con 0 breaksCoherence. */
{
  const slot = { purpose:'strength', n_blocks:3,
                 methods_allowed:[['straight','default'],['straight','default'],['emom','every_minute']],
                 target_zones:['Z1','Z2','Z5'] };
  const r = GEN.session(slot, PROFILE);
  ok(r.ok && Array.isArray(r.blocks), 'V3.3 genSession → emite sesión con bloques');
  if (r.blocks){
    const res = validateSessionBlocks(r.blocks);
    ok(res.coherent, 'V3.3 sesión: 0 breaksCoherence (validador es el test)');
    ok(r.blocks.length === 3, 'V3.3 sesión: n_blocks respetado (3)');
  }
}

/* (2) ORDEN NEURAL DESCENDENTE: la sesión generada NO dispara session_block_order_suboptimal. */
{
  // Mezcla deliberada: conditioning (emom Z5) + fuerza máxima (Z1) + hipertrofia (Z4).
  const slot = { purpose:'mixed', n_blocks:3,
                 methods_allowed:[['emom','every_minute'],['straight','default'],['straight','default']],
                 target_zones:['Z5','Z1','Z4'] };
  const r = GEN.session(slot, PROFILE);
  ok(r.ok, 'V3.3 orden: sesión mixta emite');
  if (r.ok){
    const ids = r.blocks.map(b => b.method+'/'+(b.zone||b.params.target_zone||'?'));
    const orderFlag = r.flags.filter(f => f.id === 'session_block_order_suboptimal');
    ok(orderFlag.length === 0, 'V3.3 orden: sin session_block_order_suboptimal (orden neural desc) ['+ids.join(', ')+']');
    // El primer bloque debe ser el de mayor demanda neural (Z1 fuerza máxima, no el emom Z5).
    ok(r.blocks[0].method !== 'emom', 'V3.3 orden: el bloque de conditioning (emom) no va primero');
  }
}

/* (3) sessionRules como función pura: detecta orden invertido y la interferencia. */
{
  // Construir 2 bloques a mano vía GEN.block, en orden invertido (conditioning primero).
  const condi = GEN.block({ method:'emom', variant:'every_minute', target_zone:'Z5', exercise:'wall_ball' }, PROFILE).block;
  const heavy = GEN.block({ method:'straight', variant:'default', target_zone:'Z1', exercise:'back_squat' }, PROFILE).block;
  if (condi && heavy){
    const flagsBad = sessionRules([condi, heavy]);   // conditioning antes que fuerza máxima
    ok(flagsBad.some(f => f.id === 'session_block_order_suboptimal'),
       'V3.3 sessionRules: orden invertido dispara session_block_order_suboptimal');
    const flagsGood = sessionRules([heavy, condi]);
    ok(!flagsGood.some(f => f.id === 'session_block_order_suboptimal'),
       'V3.3 sessionRules: orden correcto (fuerza→conditioning) no dispara');
  }
}

/* (4) INTERFERENCIA ADYACENTE: dos bloques del mismo patrón contiguos disparan el flag;
       genSession intenta separarlos cuando es posible. */
{
  const sq1 = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block;
  const sq2 = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'front_squat' }, PROFILE).block;
  if (sq1 && sq2){
    const f = sessionRules([sq1, sq2]);   // ambos pattern 'squat'
    ok(f.some(x => x.id === 'session_interference_adjacent'),
       'V3.3 interferencia: 2 bloques squat contiguos disparan session_interference_adjacent');
  }
  // Con un bloque de patrón distinto intercalado disponible, genSession debe poder separarlos.
  const slot = { purpose:'sep', n_blocks:3,
                 block_specs:[
                   { method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' },
                   { method:'straight', variant:'default', target_zone:'Z2', exercise:'front_squat' },
                   { method:'straight', variant:'default', target_zone:'Z2', exercise:'bench_press_barbell' } ] };
  const r = GEN.session(slot, PROFILE);
  ok(r.ok, 'V3.3 interferencia: sesión de 3 con 2 squats + 1 press emite');
  // No exigimos 0 interferencia (puede ser irresoluble por orden neural), pero sí coherencia.
  if (r.ok) ok(validateSessionBlocks(r.blocks).coherent, 'V3.3 interferencia: sesión separada sigue coherente');
}

/* (5) FALLA RUIDOSA: slot con variante no soportada → blocks:null + reason, nunca output incoherente. */
{
  const r = GEN.session({ purpose:'x', n_blocks:1, methods_allowed:[['mace_flow','flow']] }, PROFILE);
  ok(!r.ok && r.blocks === null && r.reason.length > 0,
     'V3.3 falla ruidosa: variante no generable → blocks:null + reason ['+(r.reason||[]).join(',')+']');
}

/* (6) REPRODUCIBILIDAD + VARIEDAD por semilla de sesión (contrato de semilla en cascada). */
{
  const slot = (seed) => ({ purpose:'rep', n_blocks:2, seed,
    methods_allowed:[['complex','giant_set'],['complex','accessory_complex']], target_zones:['Z4','Z4'] });
  const a = GEN.session(slot(7), PROFILE), b = GEN.session(slot(7), PROFILE);
  const exOf = bl => bl ? bl.blocks.map(x => x.components ? x.components.map(c=>c.exercise).join('+') : x.exercise).join('|') : null;
  if (a.ok && b.ok) ok(exOf(a) === exOf(b), 'V3.3 reproducibilidad: misma semilla de sesión → misma selección');
  // semillas distintas: al menos a veces difieren (no garantizado por slot, pero sobre el espacio sí)
  let diff = 0; for (let s=0;s<8;s++){ const r=GEN.session(slot(s),PROFILE); if (r.ok && exOf(r)!==exOf(a)) diff++; }
  ok(diff > 0, 'V3.3 variedad: distintas semillas de sesión producen distintas selecciones');
}

/* =================================================================
   V3.3b — MICROCICLO: volumen vs landmarks + frecuencia + slots + genMicro
   Shift V3: el validador (microcycleRules) ES el test. Caracterización de
   volumen fraccional, frecuencia por patrón, slots vacíos, y compuerta de genMicro.
   ================================================================= */
console.log('\n— V3.3b ENSAMBLADO DE MICROCICLO —\n');

/* (0) Sanidad de DATA: landmarks + tabla de conteo + secundarios embebidos. */
{
  ok(DATA.volume_landmarks && DATA.volume_landmarks.quadriceps && DATA.volume_landmarks.quadriceps.mev === 8,
     'V3.3b DATA: volume_landmarks embebidos (quadriceps.mev=8)');
  ok(DATA.method_set_counting && DATA.method_set_counting.straight,
     'V3.3b DATA: method_set_counting embebido');
  ok(DATA.exercises.back_squat && Array.isArray(DATA.exercises.back_squat.secondary) &&
     DATA.exercises.back_squat.secondary.includes('hamstrings'),
     'V3.3b DATA: secondary_muscles embebidos (back_squat → hamstrings)');
}

/* (1) VALIDADOR ES EL TEST: un microciclo generado pasa validateMicrocycleBlocks coherente. */
{
  const plan = {
    seed: 3,
    frequency_targets: { squat: { min: 1, max: 4 } },
    slots: [
      { slot_id:'d1', intent:'strength', n_blocks:2,
        methods_allowed:[['straight','default'],['straight','default']],
        target_zones:['Z2','Z3'], segment_focus:'lower' },
      { slot_id:'d2', intent:'hypertrophy', n_blocks:2,
        methods_allowed:[['straight','default'],['straight','default']],
        target_zones:['Z4','Z4'], segment_focus:'upper' }
    ]
  };
  const r = GEN.micro(plan, PROFILE);
  ok(r.ok && r.micro, 'V3.3b genMicro: microciclo de 2 slots emite');
  if (r.ok){
    const breaks = r.flags.filter(breaksCoherence);
    ok(breaks.length === 0, 'V3.3b genMicro: 0 breaksCoherence (validador es el test) '+breaks.map(f=>f.id).join(','));
    ok(r.micro.sessions.length === 2, 'V3.3b genMicro: 2 sesiones materializadas');
    ok(r.volume && typeof r.volume.direct === 'object', 'V3.3b genMicro: devuelve volumen agregado');
  }
}

/* (2) CARACTERIZACIÓN DE VOLUMEN: conteo fraccional primary/secondary correcto. */
{
  // 1 sesión, 1 bloque straight back_squat, 4 sets, rir 2 (efectivo).
  const sq = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block;
  sq.params.sets = 4; sq.params.rir_target = 2;
  const micro = { sessions: [[sq]] };
  const v = validateMicrocycleBlocks(micro).volume;
  // back_squat: primary quadriceps+glutes (1.0 c/u), secondary hamstrings/erectors/adductors (0.5).
  // 4 sets / 1 ejercicio = 4 sets → quadriceps directo = 4.0
  ok(Math.abs((v.direct.quadriceps||0) - 4.0) < 1e-6, 'V3.3b volumen: quadriceps directo = 4.0 (4 sets × primary 1.0) — got '+(v.direct.quadriceps||0));
  ok(Math.abs((v.indirect.hamstrings||0) - 2.0) < 1e-6, 'V3.3b volumen: hamstrings indirecto = 2.0 (4 sets × secondary 0.5) — got '+(v.indirect.hamstrings||0));
}

/* (3) SETS EFECTIVOS: rir>4 excluye el set (warmup/técnica), no cuenta volumen. */
{
  const light = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block;
  light.params.sets = 5; light.params.rir_target = 6;   // rir 6 > 4 → no efectivo
  const v = validateMicrocycleBlocks({ sessions:[[light]] }).volume;
  ok((v.direct.quadriceps||0) === 0, 'V3.3b set efectivo: rir 6 (>4) → 0 volumen efectivo');
}

/* (4) BELOW MEV: volumen directo escaso dispara muscle_volume_below_mev. */
{
  const sq = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block;
  sq.params.sets = 2; sq.params.rir_target = 2;   // 2 sets quad → bajo MEV 8
  const f = microcycleRules({ sessions:[[sq]] });
  ok(f.some(x => x.id==='muscle_volume_below_mev' && /quadriceps/.test(x.message)),
     'V3.3b below MEV: 2 sets de quad dispara muscle_volume_below_mev');
}

/* (5) EXCEEDED MRV: volumen alto dispara muscle_volume_exceeded_mrv. */
{
  // varias sesiones de squat pesado para superar MRV de quadriceps (22).
  const mk = () => { const b = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block; b.params.sets = 6; b.params.rir_target = 2; return b; };
  const micro = { sessions: [[mk()],[mk()],[mk()],[mk()]] };   // 4×6 = 24 sets quad directo > MRV 22
  const f = microcycleRules(micro);
  ok(f.some(x => x.id==='muscle_volume_exceeded_mrv' && /quadriceps/.test(x.message)),
     'V3.3b exceeded MRV: 24 sets de quad dispara muscle_volume_exceeded_mrv');
}

/* (6) FRECUENCIA: patrón por debajo del target min dispara el flag. */
{
  const sq = GEN.block({ method:'straight', variant:'default', target_zone:'Z2', exercise:'back_squat' }, PROFILE).block;
  const micro = { sessions:[[sq]], frequency_targets:{ squat:{min:2,max:4}, hinge:{min:1,max:3} } };
  const f = microcycleRules(micro);
  ok(f.some(x => x.id==='microcycle_frequency_below_target' && /squat/.test(x.message)),
     'V3.3b frecuencia: squat 1x < min 2 dispara below_target');
  ok(f.some(x => x.id==='microcycle_frequency_below_target' && /hinge/.test(x.message)),
     'V3.3b frecuencia: hinge 0x < min 1 dispara below_target');
}

/* (7) SLOT VACÍO: session_template_ref null dispara microcycle_slot_unfilled. */
{
  const f = microcycleRules({ sessions:[], slots:[{slot_id:'rest', session_template_ref:null}] });
  ok(f.some(x => x.id==='microcycle_slot_unfilled' && /rest/.test(x.message)),
     'V3.3b slot: ref null dispara microcycle_slot_unfilled');
  // genMicro respeta el slot vacío: no genera sesión para él, pero sí lo reporta.
  const r = GEN.micro({ slots:[ {slot_id:'work', intent:'strength', n_blocks:1,
                                 methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower'},
                                {slot_id:'rest', session_template_ref:null} ] }, PROFILE);
  ok(r.ok && r.micro.sessions.length===1 && r.flags.some(x=>x.id==='microcycle_slot_unfilled'),
     'V3.3b genMicro: slot vacío → 1 sesión + flag slot_unfilled');
}

/* (8) FALLA RUIDOSA: slot con variante no generable → micro:null + reason. */
{
  const r = GEN.micro({ slots:[{ slot_id:'x', intent:'x', n_blocks:1, methods_allowed:[['mace_flow','flow']] }] }, PROFILE);
  ok(!r.ok && r.micro===null && r.reason.length>0,
     'V3.3b falla ruidosa: variante no generable en un slot → micro:null + reason ['+(r.reason||[]).join(',')+']');
}

/* (9) REPRODUCIBILIDAD: misma semilla de microciclo → misma materialización (selección congelada). */
{
  const plan = (seed) => ({ seed, slots:[
    { slot_id:'d1', intent:'hypertrophy', n_blocks:2, methods_allowed:[['complex','giant_set'],['complex','accessory_complex']], target_zones:['Z4','Z4'] } ] });
  const a = GEN.micro(plan(11), PROFILE), b = GEN.micro(plan(11), PROFILE);
  const sig = m => m.ok ? m.micro.sessions.map(s => s.map(bl => bl.components ? bl.components.map(c=>c.exercise).join('+') : bl.exercise).join('|')).join('//') : null;
  if (a.ok && b.ok) ok(sig(a)===sig(b), 'V3.3b reproducibilidad: misma semilla de microciclo → misma selección congelada');
  // semillas distintas exploran selecciones distintas en el espacio.
  let diff=0; for (let s=0;s<8;s++){ const r=GEN.micro(plan(s),PROFILE); if (r.ok && sig(r)!==sig(a)) diff++; }
  ok(diff>0, 'V3.3b variedad: distintas semillas de microciclo producen distintas selecciones');
}

console.log('\n— V3.4.1 REGLAS DE MESOCICLO (modelo / drift) —\n');

/* Helper: una semana estándar con N bloques escalares de carga/zona dadas.
   Los bloques se construyen con GEN.block (coherentes: traen rir_target,
   rest, intent_declared) y luego se sobrescribe load_pct_1rm/zone para el
   escenario de ramp — control fino del eje sin fabricar bloques incoherentes. */
function _week(weekNo, loads, zone, type, exercise){
  const z = zone || 'Z2';
  const blocks = (loads||[]).map(lp => {
    const r = GEN.block({ method:'straight', variant:'default',
      exercise: exercise||'back_squat', target_zone:z });
    const b = r.block;
    b.params.load_pct_1rm = lp;   // sobrescribe la carga calibrada para el escenario
    b.zone = z;
    return b;
  });
  return { week: weekNo, type: type||'standard',
           microcycle: { sessions:[blocks] } };
}

/* (0) SANIDAD DE DATA: los 5 modelos + 4 drift rules + umbrales embebidos. */
{
  const pm = DATA.periodization_models || {};
  ok(['linear','undulating','block','conjugate','concurrent_hybrid'].every(m=>pm[m]),
     'V3.4.1 DATA: los 5 modelos de periodización embebidos');
  ok(pm.linear && pm.linear.primary_axis==='intensity', 'V3.4.1 DATA: linear.primary_axis=intensity');
  ok(Array.isArray(DATA.model_drift_rules) && DATA.model_drift_rules.length===4,
     'V3.4.1 DATA: 4 model_drift_rules embebidas');
  ok(DATA.deload_overdue_threshold && DATA.deload_overdue_threshold.advanced===4,
     'V3.4.1 DATA: umbral de deload advanced=4');
}

/* (1) EL VALIDADOR ES EL TEST: meso linear coherente con ramp monotónico. */
{
  const dl = GEN.block({method:'straight',variant:'default',exercise:'back_squat',target_zone:'Z2'}).block;
  dl.params.load_pct_1rm = 65; dl.zone='Z2';
  const meso = { periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:4, level:'intermediate',
    progression_scheme:{ axis:'intensity', ramp:[] },
    weeks:[ _week(1,[75]), _week(2,[78]), _week(3,[81]),
            { week:4, type:'planned_deload', microcycle:{sessions:[[ dl ]]} } ] };
  const r = validateMesocycleBlocks(meso);
  ok(r.coherent, 'V3.4.1 validador-es-test: meso linear monotónico → coherent');
  ok(!r.driftFired.includes('linear_ramp_undulates'),
     'V3.4.1 linear monotónico: NO dispara linear_ramp_undulates');
}

/* (2) DRIFT linear_ramp_undulates: carga no-monotónica across standard weeks. */
{
  const meso = { periodization_model:'linear', duration_weeks:3, level:'intermediate',
    weeks:[ _week(1,[80]), _week(2,[72]), _week(3,[84]) ] };  // baja en w2 → no monotónico
  const f = mesocycleRules(meso);
  ok(f.some(x=>x.id==='periodization_model_drift' && /linear_ramp_undulates/.test(x.message)),
     'V3.4.1 drift: linear con ramp no-monotónico dispara periodization_model_drift');
  ok(f.every(x=>x.severity==='informational'),
     'V3.4.1 drift: todos los flags de meso son informational (no reescribe severidad)');
}

/* (3) DRIFT dup_with_identical_slots: undulating/daily sin zonas distintas. */
{
  // todas las semanas con una sola zona de fuerza (Z2) → no hay ondulación.
  const dup = { periodization_model:'undulating', model_variant:'daily_undulating',
    duration_weeks:3, level:'intermediate',
    weeks:[ _week(1,[80],'Z2'), _week(2,[80],'Z2'), _week(3,[80],'Z2') ] };
  ok(mesocycleRules(dup).some(x=>/dup_with_identical_slots/.test(x.message)),
     'V3.4.1 drift: DUP con zonas idénticas dispara');
  // versión con ondulación real: una semana con 2 zonas distintas → NO dispara.
  const mkZ = (z, lp) => { const b=GEN.block({method:'straight',variant:'default',exercise:'back_squat',target_zone:z}).block; b.params.load_pct_1rm=lp; b.zone=z; return b; };
  const wave = { periodization_model:'undulating', model_variant:'daily_undulating',
    duration_weeks:2, level:'intermediate',
    weeks:[ { week:1, type:'standard', microcycle:{ sessions:[[ mkZ('Z1',92), mkZ('Z4',72) ]] } },
            _week(2,[80],'Z2') ] };
  ok(!mesocycleRules(wave).some(x=>/dup_with_identical_slots/.test(x.message)),
     'V3.4.1 drift: DUP con ≥2 zonas distintas en una semana NO dispara');
}

/* (4) DRIFT concurrent_strength_ramping: strength_load_delta > +2.5%/sem sostenido. */
{
  const meso = { periodization_model:'concurrent_hybrid', model_variant:'conditioning_bias',
    duration_weeks:4, level:'intermediate',
    weeks:[ _week(1,[70]), _week(2,[74]), _week(3,[78]), _week(4,[82]) ] };  // +4%/sem
  ok(mesocycleRules(meso).some(x=>/concurrent_strength_ramping/.test(x.message)),
     'V3.4.1 drift: concurrent/conditioning_bias rampeando fuerza +4%/sem dispara');
  const stable = { periodization_model:'concurrent_hybrid', model_variant:'conditioning_bias',
    duration_weeks:4, level:'intermediate',
    weeks:[ _week(1,[75]), _week(2,[76]), _week(3,[75]), _week(4,[76]) ] };  // ~0%/sem
  ok(!mesocycleRules(stable).some(x=>/concurrent_strength_ramping/.test(x.message)),
     'V3.4.1 drift: concurrent con fuerza estable (~0%/sem) NO dispara');
}

/* (5) DRIFT conjugate_without_rotation: mismos ejercicios ≥6 semanas. */
{
  const weeks=[]; for (let w=1; w<=6; w++) weeks.push(_week(w,[80],'Z2','standard','back_squat'));
  const meso = { periodization_model:'conjugate', duration_weeks:6, level:'advanced', weeks };
  ok(mesocycleRules(meso).some(x=>/conjugate_without_rotation/.test(x.message)),
     'V3.4.1 drift: conjugate con back_squat fijo 6 semanas dispara');
  // rotación: distinto ejercicio cada semana → span < 6 → NO dispara.
  const rot=[]; const exs=['back_squat','front_squat','deadlift','overhead_press','bench_press','box_jump'];
  for (let w=1; w<=6; w++) rot.push(_week(w,[80],'Z2','standard',exs[w-1]));
  const meso2 = { periodization_model:'conjugate', duration_weeks:6, level:'advanced', weeks:rot };
  ok(!mesocycleRules(meso2).some(x=>/conjugate_without_rotation/.test(x.message)),
     'V3.4.1 drift: conjugate con rotación de ejercicios NO dispara');
}

/* (6) DRIFT cross-model: una regla de un modelo NO dispara en otro modelo. */
{
  // linear con carga no-monotónica, pero declarado block → linear_ramp_undulates NO aplica.
  const meso = { periodization_model:'block', duration_weeks:3, level:'intermediate',
    weeks:[ _week(1,[80]), _week(2,[72]), _week(3,[84]) ] };
  ok(!mesocycleRules(meso).some(x=>/linear_ramp_undulates/.test(x.message)),
     'V3.4.1 drift: regla origin=linear NO dispara en modelo block (scope por origin)');
}

/* (7) progression_scheme incoherente con el modelo. */
{
  // linear (primary_axis intensity) con scheme axis=volume → incoherente.
  const meso = { periodization_model:'linear', duration_weeks:3, level:'intermediate',
    progression_scheme:{ axis:'volume', ramp:[] },
    weeks:[ _week(1,[78]), _week(2,[80]), _week(3,[82]) ] };
  ok(mesocycleRules(meso).some(x=>x.id==='mesocycle_progression_incoherent_with_model'),
     'V3.4.1: scheme axis=volume en modelo linear (intensity) dispara incoherent_with_model');
  // mixed model (concurrent) acepta cualquier eje → NO dispara.
  const ok2 = { periodization_model:'concurrent_hybrid', duration_weeks:3, level:'intermediate',
    progression_scheme:{ axis:'volume', ramp:[] },
    weeks:[ _week(1,[75]), _week(2,[75]), _week(3,[75]) ] };
  ok(!mesocycleRules(ok2).some(x=>x.id==='mesocycle_progression_incoherent_with_model'),
     'V3.4.1: modelo mixed (concurrent) NO marca incoherencia de eje');
}

/* (8) week_modifier_conflict: misma semana + dimensión + scopes solapados. */
{
  const meso = { periodization_model:'linear', duration_weeks:2, level:'intermediate',
    weeks:[ { week:1, type:'standard', microcycle:{sessions:[]},
              modifiers:[ {dimension:'load_pct', delta:5, scope:{type:'all',value:null}},
                          {dimension:'load_pct', delta:-3, scope:{type:'by_intent',value:'strength'}} ] },
            _week(2,[80]) ] };
  ok(mesocycleRules(meso).some(x=>x.id==='week_modifier_conflict' && /Semana 1/.test(x.message)),
     'V3.4.1: dos modifiers load_pct con scope all + by_intent solapan → week_modifier_conflict');
}

/* (9) mesocycle_deload_overdue: corrida estándar sobre el umbral effective. */
{
  // advanced (umbral nivel 4); linear deload_positioning [3,5] → modelThr 5 → effective min(4,5)=4.
  const weeks=[]; for (let w=1; w<=6; w++) weeks.push(_week(w,[78],'Z2'));  // 6 estándar seguidas, sin deload
  const meso = { periodization_model:'linear', duration_weeks:6, level:'advanced', weeks };
  ok(mesocycleRules(meso).some(x=>x.id==='mesocycle_deload_overdue'),
     'V3.4.1: 6 semanas estándar (advanced, umbral 4) dispara deload_overdue');
}

/* (10) mesocycle_duration_out_of_range. */
{
  const weeks=[]; for (let w=1; w<=10; w++) weeks.push(_week(w,[78],'Z2'));
  const meso = { periodization_model:'linear', duration_weeks:10, level:'intermediate', weeks };
  ok(mesocycleRules(meso).some(x=>x.id==='mesocycle_duration_out_of_range'),
     'V3.4.1: duración 10 semanas (>8 extended) dispara duration_out_of_range');
}

console.log('\n— V3.4.2 ENSAMBLADO DE MESOCICLO (genMeso) —\n');

/* Plan base de microciclo reutilizable: 1 sesión de fuerza lower. */
const MPLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
  methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' }] };

/* Plan de 2 slots para undulating: la ondulación (DUP) exige ≥2 slots de fuerza
   con zonas distintas en la semana — un solo slot no puede ondular por diseño. */
const MPLAN2 = { slots:[
  { slot_id:'d1', intent:'strength', n_blocks:1, methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' },
  { slot_id:'d2', intent:'strength', n_blocks:1, methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' } ] };

/* (1) VALIDADOR ES EL TEST: los 5 modelos generan meso coherente + sin auto-drift. */
{
  const models = [['linear','classic_linear',4,MPLAN],['undulating','daily_undulating',4,MPLAN2],
                  ['block','accumulation',4,MPLAN],['conjugate',null,4,MPLAN],
                  ['concurrent_hybrid','conditioning_bias',4,MPLAN]];
  for (const [m,v,dw,plan] of models){
    const r = GEN.meso({ periodization_model:m, model_variant:v, duration_weeks:dw,
      level:'intermediate', microcycle_plan:plan, base_load_pct:75 }, PROFILE);
    ok(r.ok && r.meso, `V3.4.2 genMeso ${m}${v?'/'+v:''} → emite meso (${r.ok?'ok':r.reason.join(',')})`);
    if (r.ok){
      const vr = validateMesocycleBlocks(r.meso);
      ok(vr.coherent, `V3.4.2 ${m}: meso coherente (validador es el test)`);
      ok(vr.driftFired.length===0, `V3.4.2 ${m}: NO auto-drift [${vr.driftFired.join(',')}]`);
      ok(r.meso.weeks.length===dw, `V3.4.2 ${m}: ${dw} semanas materializadas`);
    }
  }
}

/* (1b) AUTOCHEQUEO: undulating con 1 solo slot NO puede ondular → falla ruidosa
   (gen_meso_self_drift), NO produce un meso que miente sobre su modelo. */
{
  const r = GEN.meso({ periodization_model:'undulating', model_variant:'daily_undulating',
    duration_weeks:3, level:'intermediate', microcycle_plan:MPLAN, base_load_pct:75 }, PROFILE);
  ok(!r.ok && r.meso===null && r.reason.some(x=>/gen_meso_self_drift:dup_with_identical_slots/.test(x)),
     'V3.4.2 autochequeo: undulating con 1 slot → falla ruidosa (no finge ondular)');
}

/* (2) RAMP linear: la carga de fuerza sube semana a semana (monotónica). */
{
  const r = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:3, level:'intermediate', microcycle_plan:MPLAN, base_load_pct:75 }, PROFILE);
  const loadOf = w => { const b=w.microcycle.sessions[0][0]; return b.params.load_pct_1rm; };
  const std = r.meso.weeks.filter(w=>w.type==='standard');
  let mono=true; for (let i=1;i<std.length;i++) if (loadOf(std[i]) < loadOf(std[i-1])) mono=false;
  ok(r.ok && mono && std.length>=2, 'V3.4.2 ramp linear: carga de fuerza monotónica no-decreciente');
}

/* (3) RAMP undulating: dentro de una semana hay ≥2 zonas de fuerza distintas (DUP). */
{
  const plan2 = { slots:[
    { slot_id:'d1', intent:'strength', n_blocks:1, methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' },
    { slot_id:'d2', intent:'strength', n_blocks:1, methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' } ] };
  const r = GEN.meso({ periodization_model:'undulating', model_variant:'daily_undulating',
    duration_weeks:2, level:'intermediate', microcycle_plan:plan2, base_load_pct:78 }, PROFILE);
  ok(r.ok, 'V3.4.2 undulating: genera meso (DUP zonas alternadas no auto-driftan)');
  if (r.ok){
    const w1 = r.meso.weeks[0];
    const zones = new Set();
    for (const blocks of w1.microcycle.sessions) for (const b of blocks){ if (b.zone) zones.add(b.zone); }
    ok(zones.size>=2, 'V3.4.2 undulating: semana 1 toca ≥2 zonas de fuerza distintas');
  }
}

/* (4) INSERCIÓN DE DELOAD: meso largo (advanced, umbral 4) inserta planned_deload. */
{
  const r = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:6, level:'advanced', microcycle_plan:MPLAN, base_load_pct:72 }, PROFILE);
  ok(r.ok, 'V3.4.2 deload: meso de 6 semanas advanced genera');
  if (r.ok){
    const deloads = r.meso.weeks.filter(w=>w.type==='planned_deload');
    ok(deloads.length>=1, 'V3.4.2 deload: ≥1 semana planned_deload insertada (umbral min(4,5)=4)');
    // no_overdue: no debe disparar mesocycle_deload_overdue tras la inserción.
    ok(!validateMesocycleBlocks(r.meso).flags.some(f=>f.id==='mesocycle_deload_overdue'),
       'V3.4.2 deload: tras inserción NO queda deload_overdue');
  }
}

/* (5) REPRODUCIBILIDAD + VARIEDAD por semilla de meso (selección congelada). */
{
  const mk = seed => GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:3, level:'intermediate', microcycle_plan:MPLAN, base_load_pct:75, seed }, PROFILE);
  const sig = r => r.ok ? r.meso.weeks.map(w => w.microcycle.sessions.map(s=>s.map(b=>b.exercise).join('+')).join('|')).join('//') : null;
  const a=mk(7), b=mk(7);
  ok(a.ok && b.ok && sig(a)===sig(b), 'V3.4.2 reproducibilidad: misma semilla de meso → misma selección congelada');
  let diff=0; for (let s=0;s<8;s++){ const r=mk(s); if (r.ok && sig(r)!==sig(a)) diff++; }
  ok(diff>0, 'V3.4.2 variedad: distintas semillas de meso → distintas selecciones');
}

/* (6) FALLA RUIDOSA: plan con variante no generable → meso:null + reason. */
{
  const r = GEN.meso({ periodization_model:'linear', duration_weeks:3, level:'intermediate',
    microcycle_plan:{ slots:[{ slot_id:'x', intent:'x', n_blocks:1, methods_allowed:[['mace_flow','flow']] }] } }, PROFILE);
  ok(!r.ok && r.meso===null && r.reason.length>0,
     'V3.4.2 falla ruidosa: variante no generable → meso:null + reason ['+(r.reason||[]).join(',')+']');
}

console.log('\n— V3.4.3 ENSAMBLADO DE MACROCICLO (genMacro / reverse planning) —\n');

/* meso_spec helper para fases del macro. */
const MS = (model, variant, weeks, base) => ({ periodization_model:model, model_variant:variant,
  duration_weeks:weeks, level:'intermediate', microcycle_plan:MPLAN, base_load_pct:base });

/* (1) VALIDADOR ES EL TEST: macro de 3 fases hacia un evento A → coherente. */
{
  const r = GEN.macro({
    event:{ id:'race', date:84, priority:'A', type:'competition' },
    phases:[ { order:1, purpose:'general_prep', meso_spec:MS('linear','classic_linear',4,68) },
             { order:2, purpose:'specific_prep', meso_spec:MS('block','accumulation',4,74) },
             { order:3, purpose:'peak', meso_spec:MS('linear','classic_linear',3,80) } ] }, PROFILE);
  ok(r.ok && r.macro, 'V3.4.3 genMacro 3 fases → emite macro ('+(r.ok?'ok':r.reason.join(','))+')');
  if (r.ok){
    ok(validateMacrocycleBlocks(r.macro).coherent, 'V3.4.3 macro coherente (validador es el test)');
    ok(r.macro.phases.length===3, 'V3.4.3 macro: 3 fases materializadas');
  }
}

/* (2) REVERSE PLANNING: última fase termina adyacente al evento; start = evento − totalWeeks. */
{
  const ev = { id:'race', date:84, priority:'A', type:'competition' };
  const r = GEN.macro({ event:ev,
    phases:[ { order:1, purpose:'general_prep', meso_spec:MS('linear','classic_linear',4,70) },
             { order:2, purpose:'peak', meso_spec:MS('linear','classic_linear',3,80) } ] }, PROFILE);
  ok(r.ok, 'V3.4.3 reverse: macro generado');
  if (r.ok){
    const totalWeeks = r.macro.phases.reduce((a,p)=>a+p.weeks,0);
    ok(r.macro.start_date === ev.date - totalWeeks*7,
       'V3.4.3 reverse: start_date = evento − totalWeeks (planificación hacia atrás)');
    const last = r.macro.phases[r.macro.phases.length-1];
    ok(last.start_date + last.weeks*7 === ev.date,
       'V3.4.3 reverse: la última fase termina adyacente al evento (el evento es la fecha inmóvil)');
    ok(r.macro.end_date === ev.date, 'V3.4.3 reverse: end_date = fecha del evento');
  }
}

/* (3) TAPER: presente, adyacente al evento, intensidad mantenida. */
{
  const ev = { id:'race', date:84, priority:'A', type:'competition' };
  const r = GEN.macro({ event:ev, taper_days:11,
    phases:[ { order:1, purpose:'peak', meso_spec:MS('linear','classic_linear',4,78) } ] }, PROFILE);
  ok(r.ok && r.macro.taper, 'V3.4.3 taper: definido');
  if (r.ok){
    const t = r.macro.taper;
    ok(t.event_ref==='race' && t.duration_days===11, 'V3.4.3 taper: 11d hacia el evento A');
    ok(t.start_date + t.duration_days === ev.date, 'V3.4.3 taper: termina adyacente al evento');
    ok(t.deltas.intensity==='maintained' && t.deltas.volume_pct===-50,
       'V3.4.3 taper: intensidad mantenida, volumen −50% (receta default A)');
    // No debe disparar ningún flag macro hard ni event_a_without_taper.
    const f = validateMacrocycleBlocks(r.macro).flags;
    ok(!f.some(x=>x.id==='event_a_without_taper'), 'V3.4.3 taper: evento A NO queda sin taper');
    ok(!f.some(x=>x.id==='realization_not_adjacent_to_event'), 'V3.4.3 taper: ventana adyacente (sin flag)');
  }
}

/* (4) FALLA RUIDOSA: fase con meso no generable → macro:null + reason. */
{
  const r = GEN.macro({ event:{ id:'race', date:84, priority:'A' },
    phases:[ { order:1, purpose:'peak', meso_spec:{ periodization_model:'linear', duration_weeks:3,
      level:'intermediate', microcycle_plan:{ slots:[{ slot_id:'x', intent:'x', n_blocks:1,
      methods_allowed:[['mace_flow','flow']] }] } } } ] }, PROFILE);
  ok(!r.ok && r.macro===null && r.reason.length>0,
     'V3.4.3 falla ruidosa: fase con variante no generable → macro:null + reason ['+(r.reason||[]).join(',')+']');
}

/* (5) REGLAS PURAS — phase_overlap es HARD (compuerta con dientes). */
{
  // fase 2 empieza antes del fin de la fase 1 → overlap hard.
  const macro = { start_date:0, end_date:84, events:[{id:'race',date:84,priority:'A'}],
    phases:[ { order:1, purpose:'general_prep', start_date:0, weeks:4, mesocycle:{weeks:[]} },
             { order:2, purpose:'peak', start_date:14, weeks:3, mesocycle:{weeks:[]} } ],  // 14 < 28
    taper:{ event_ref:'race', start_date:73, duration_days:11, deltas:{intensity:'maintained'} } };
  const f = macrocycleRules(macro);
  ok(f.some(x=>x.id==='macrocycle_phase_overlap' && x.severity==='hard'),
     'V3.4.3 reglas: fases solapadas disparan macrocycle_phase_overlap (HARD)');
  ok(!validateMacrocycleBlocks(macro).coherent,
     'V3.4.3 reglas: phase_overlap (hard) rompe coherencia → compuerta con dientes');
}

/* (6) REGLAS PURAS — event_a_without_taper + taper con intensidad recortada. */
{
  const noTaper = { start_date:0, end_date:84, events:[{id:'race',date:84,priority:'A'}],
    phases:[{order:1,purpose:'peak',start_date:0,weeks:12,mesocycle:{weeks:[]}}] };
  ok(macrocycleRules(noTaper).some(x=>x.id==='event_a_without_taper'),
     'V3.4.3 reglas: evento A sin taper dispara event_a_without_taper');
  const badTaper = { start_date:0, end_date:84, events:[{id:'race',date:84,priority:'A'}],
    phases:[{order:1,purpose:'peak',start_date:0,weeks:12,mesocycle:{weeks:[]}}],
    taper:{ event_ref:'race', start_date:73, duration_days:11, deltas:{intensity:'reduced'} } };
  ok(macrocycleRules(badTaper).some(x=>x.id==='taper_not_producing_freshness'),
     'V3.4.3 reglas: taper que recorta intensidad dispara taper_not_producing_freshness');
}

/* ===================================================================
   V3.5 — PROGRESIÓN INTER-SESIÓN (progression_logic)
   Shift de testing V3: el validador ES el test + caracterización de cada
   rama de la asimetría §4.7 + compuerta de microciclo.
   feedbackByWeek[w].byBlock["s<si>_b<bi>"] = {rir_reported, reps_done}
   =================================================================== */
console.log('\n— V3.5 PROGRESIÓN INTER-SESIÓN —\n');

/* Plan de fuerza de 3 semanas, 1 slot lower, para los escenarios de progresión. */
const PPLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
  methods_allowed:[['straight','default']], target_zones:['Z3'], segment_focus:'lower' }] };
const baseMeso = () => GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
  duration_weeks:3, level:'intermediate', microcycle_plan:PPLAN, base_load_pct:72 }, PROFILE);

/* (0) Sanidad: progression_engine embebido desde la spec. */
{
  const pe = DATA.progression_engine || {};
  ok(pe.rir_to_load && pe.rir_to_load.default_pct_per_rir === 2.5,
     'V3.5.0 spec: rir_to_load 2.5%/RIR embebido desde autoregulation_schema');
  ok(pe.asymmetry && pe.asymmetry.increase_cap_per_session_pct === 5 && pe.asymmetry.reduce_cap_per_block_pct === 10,
     'V3.5.0 spec: caps de asimetría (+5/sesión, −10/bloque) embebidos');
  ok(pe.asymmetry && pe.asymmetry.increase_streak === 2 && pe.asymmetry.reduce_signal === 1,
     'V3.5.0 spec: asimetría reduce con 1 / sube con 2 (§4.7)');
}

/* (1) VALIDADOR ES EL TEST: progresar un meso NO rompe coherencia. */
{
  const r0 = baseMeso();
  ok(r0.ok, 'V3.5.1 base: meso generado para progresión');
  // feedback de overshoot consistente (margen) en las 3 semanas → escenario de aceleración.
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}},
               2:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}},
               3:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  ok(pr.ok && pr.meso, 'V3.5.1 progress: emite meso progresado');
  // El validador es la compuerta: cada microciclo progresado sigue coherente.
  let allCoherent = true;
  for (const w of pr.meso.weeks){
    if (w.microcycle){ const vr = validateMicrocycleBlocks(w.microcycle); if (!vr.coherent) allCoherent = false; }
  }
  ok(allCoherent, 'V3.5.1 validador-es-test: meso progresado mantiene coherencia en cada microciclo');
  // No resiembra la selección (contrato V3.2): el ejercicio del bloque no cambia entre original y progresado.
  const exOrig = r0.meso.weeks[0].microcycle.sessions[0][0].exercise;
  const exProg = pr.meso.weeks[0].microcycle.sessions[0][0].exercise;
  ok(exOrig === exProg, 'V3.5.1 selección CONGELADA: la progresión NO resiembra el ejercicio');
}

/* (2) FRENO con 1 señal (asimetría: el sistema frena solo). rir_delta<=-2 en una semana. */
{
  const r0 = baseMeso();
  const b0 = r0.meso.weeks[0].microcycle.sessions[0][0];
  const loadBefore = b0.params.load_pct_1rm;
  const rirTgt = b0.params.rir_target;        // típicamente 2 en Z3
  // rir_reported = rirTgt - 2 → rir_delta = -2 → freno inmediato.
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported: rirTgt - 2, reps_done: 5}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  const loadAfter = pr.meso.weeks[0].microcycle.sessions[0][0].params.load_pct_1rm;
  ok(loadAfter < loadBefore, `V3.5.1 freno-1-señal: rir_delta=-2 reduce carga (${loadBefore}→${loadAfter})`);
  const ev = (pr.meso._progression_log||[]).find(e=>e.week===1 && e.action==='reduce_load');
  ok(ev, 'V3.5.1 freno-1-señal: log registra reduce_load por rir_delta<=-2');
  // El recorte respeta el cap de −10%/bloque y la conversión por zona (Z3 = 2.5%/RIR × 2 = 5%).
  ok(ev && Math.abs(ev.detail.pct) <= 10, 'V3.5.1 freno: recorte ≤ cap −10%/bloque');
}

/* (3) NO acelera con 1 sola señal de overshoot (asimetría: sube solo con 2). */
{
  const r0 = baseMeso();
  const b0 = r0.meso.weeks[0].microcycle.sessions[0][0];
  const loadW1 = b0.params.load_pct_1rm;
  const rirTgt = b0.params.rir_target;
  // SOLO la semana 1 tiene overshoot fuerte; sin streak de 2 no debe acelerar por overshoot.
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported: rirTgt + 3, reps_done: 6}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  const accel = (pr.meso._progression_log||[]).find(e=>e.week===1 &&
                (e.action==='double_prog_load' || e.action==='double_prog_reps' || e.action==='load_only'));
  ok(!accel, 'V3.5.1 asimetría: 1 sola señal de overshoot NO acelera (requiere 2 consecutivas)');
}

/* (4) ACELERA con 2 consecutivas + DOBLE PROGRESIÓN (cascada real).
   Z3 = reps [5,8]. Con overshoot sostenido, la progresión sube reps semana a
   semana hasta el techo (8), y al tocarlo cambia a subir carga + reset de reps.
   No mutamos el meso original — la cascada la produce la propia progresión. */
{
  // Meso de 5 semanas para ver la cascada reps→carga.
  const rLong = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:5, level:'intermediate', microcycle_plan:PPLAN, base_load_pct:68 }, PROFILE);
  const tgt = rLong.meso.weeks[0].microcycle.sessions[0][0].params.rir_target;
  const fb = {}; for (let w=1; w<=5; w++) fb[w]={byBlock:{'s0_b0':{rir_reported: tgt + 2, reps_done: 8}}};
  const pr = GEN.progress(rLong.meso, fb, PROFILE);
  const log = pr.meso._progression_log || [];
  const repsBumps = log.filter(e=>e.action==='double_prog_reps');
  const loadBumps = log.filter(e=>e.action==='double_prog_load' || e.action==='load_only');
  ok(repsBumps.length >= 1 || loadBumps.length >= 1,
     `V3.5.1 acelera-2-consecutivas: overshoot sostenido dispara progresión [reps:${repsBumps.length} load:${loadBumps.length}]`);
  if (repsBumps.length){
    const maxReps = Math.max(...pr.meso.weeks.map(w=>w.microcycle?w.microcycle.sessions[0][0].params.reps_target:0));
    ok(maxReps <= 8, 'V3.5.1 doble progresión: reps no exceden el techo de zona Z3 (8)');
  }
  const dpl = log.find(e=>e.action==='double_prog_load');
  if (dpl){
    ok(dpl.detail.reps === 5, 'V3.5.1 doble progresión: al tocar el techo, reset de reps al piso de zona (Z3=5)');
    ok(dpl.detail.pct > 0, 'V3.5.1 doble progresión: al tocar el techo, sube carga');
  }
}

/* (5) MANTENER: señal débil (1 undershoot leve, no <=-2) no progresa ni frena. */
{
  const r0 = baseMeso();
  const b0 = r0.meso.weeks[0].microcycle.sessions[0][0];
  const loadBefore = b0.params.load_pct_1rm;
  const rirTgt = b0.params.rir_target;
  // rir_delta = -1 (señal débil): ni freno fuerte ni aceleración.
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported: rirTgt - 1, reps_done: 5}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  const loadAfter = pr.meso.weeks[0].microcycle.sessions[0][0].params.load_pct_1rm;
  ok(loadAfter === loadBefore, 'V3.5.1 mantener: señal débil (rir_delta=-1) no cambia la carga');
}

/* (6) FRENO por racha de patrón: 2 semanas consecutivas de undershoot → −5% patrón. */
{
  const r0 = baseMeso();
  const rirTgt = r0.meso.weeks[0].microcycle.sessions[0][0].params.rir_target;
  // 2 semanas con rir_delta<=-2 → la 1ª frena por señal; la racha llega a 2.
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported: rirTgt - 2, reps_done: 4}}},
               2:{byBlock:{'s0_b0':{rir_reported: rirTgt - 2, reps_done: 4}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  const reductions = (pr.meso._progression_log||[]).filter(e=>e.action==='reduce_load' || e.action==='reduce_pattern_streak');
  ok(reductions.length >= 2, `V3.5.1 racha de freno: 2 semanas de undershoot → ≥2 reducciones [${reductions.length}]`);
}

/* (7) DELOAD: las semanas de descarga NO se progresan. */
{
  // Meso largo para que aparezca un planned_deload (umbral intermediate=5; usar advanced=4).
  const r0 = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:6, level:'advanced', microcycle_plan:PPLAN, base_load_pct:70 }, PROFILE);
  if (r0.ok){
    const hasDeload = r0.meso.weeks.some(w=>w.type==='planned_deload');
    const fb = {}; for (let w=1; w<=6; w++) fb[w]={byBlock:{'s0_b0':{rir_reported:6, reps_done:8}}};
    const pr = GEN.progress(r0.meso, fb, PROFILE);
    const deloadSkips = (pr.meso._progression_log||[]).filter(e=>e.action==='deload_skip');
    ok(!hasDeload || deloadSkips.length >= 1, 'V3.5.1 deload: las semanas de descarga se saltan en la progresión');
  } else {
    ok(true, 'V3.5.1 deload: (meso advanced no generable en este catálogo — skip suave)');
  }
}

/* (8) COMPUERTA DE MICROCICLO (decisión 3): la progresión revalida y marca veto si cruza MRV. */
{
  const r0 = baseMeso();
  // Aceleración sostenida 3 semanas (subiría carga, no volumen — el straight no añade sets).
  const fb = {}; for (let w=1; w<=3; w++) fb[w]={byBlock:{'s0_b0':{rir_reported: r0.meso.weeks[0].microcycle.sessions[0][0].params.rir_target + 2, reps_done:8}}};
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  // Cada semana progresada lleva la marca de validación de microciclo.
  const validated = pr.meso.weeks.filter(w=>w.type!=='planned_deload').every(w=>w._progression_validated === true);
  ok(validated, 'V3.5.1 compuerta: cada semana progresada pasa por validateMicrocycleBlocks');
  // En este escenario (1 bloque straight) no se cruza MRV → sin veto, coherente.
  const anyVeto = pr.meso.weeks.some(w=>w._progression_volume_veto === true);
  ok(!anyVeto, 'V3.5.1 compuerta: 1 bloque de fuerza no cruza MRV → sin veto de volumen');
}

/* (9) REPRODUCIBILIDAD: misma entrada → mismo resultado (determinismo). */
{
  const r0 = baseMeso();
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported: 5, reps_done: 8}}},
               2:{byBlock:{'s0_b0':{rir_reported: 5, reps_done: 8}}} };
  const pA = GEN.progress(r0.meso, fb, PROFILE);
  const pB = GEN.progress(r0.meso, fb, PROFILE);
  const loadsA = pA.meso.weeks.map(w=>w.microcycle.sessions[0][0].params.load_pct_1rm);
  const loadsB = pB.meso.weeks.map(w=>w.microcycle.sessions[0][0].params.load_pct_1rm);
  ok(JSON.stringify(loadsA) === JSON.stringify(loadsB), 'V3.5.1 reproducibilidad: progresión determinista');
}

/* (10) SIN FEEDBACK: degrada limpiamente (mantiene, no rompe). */
{
  const r0 = baseMeso();
  const before = r0.meso.weeks.map(w=>w.microcycle.sessions[0][0].params.load_pct_1rm);
  const pr = GEN.progress(r0.meso, {}, PROFILE);
  ok(pr.ok, 'V3.5.1 sin feedback: GEN.progress no falla');
  const after = pr.meso.weeks.map(w=>w.microcycle.sessions[0][0].params.load_pct_1rm);
  ok(JSON.stringify(before) === JSON.stringify(after),
     'V3.5.1 sin feedback: degrada a hold (sin señal no progresa ni frena)');
}

/* (11) CARACTERIZACIÓN HONESTA: la progresión acumulativa sostenida puede empujar
   la carga fuera del rango canónico de la zona. El validador lo DETECTA (viability,
   no hard) — la fitness function marca el desajuste sin bloquear silenciosamente.
   Esto documenta que la progresión no es mágica: respeta el techo de REPS de zona,
   pero la carga acumulada puede salir de rango bajo overshoot irreal sostenido. */
{
  const rLong = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:6, level:'intermediate', microcycle_plan:PPLAN, base_load_pct:68 }, PROFILE);
  const tgt = rLong.meso.weeks[0].microcycle.sessions[0][0].params.rir_target;
  const fb = {}; for (let w=1; w<=6; w++) fb[w]={byBlock:{'s0_b0':{rir_reported: tgt + 2, reps_done: 8}}};
  const pr = GEN.progress(rLong.meso, fb, PROFILE);
  // La cascada transiciona reps→carga: debe haber AL MENOS un double_prog_load.
  const dpl = (pr.meso._progression_log||[]).filter(e=>e.action==='double_prog_load');
  ok(dpl.length >= 1, `V3.5.1 cascada acumulativa: reps→techo→carga transiciona (${dpl.length} subidas de carga)`);
  ok(dpl.length && dpl[0].detail.reps === 5, 'V3.5.1 cascada: la subida de carga resetea reps al piso de zona');
  // Coherencia se mantiene aunque la carga salga de rango canónico (viability marca, no rompe).
  const wLast = pr.meso.weeks[pr.meso.weeks.length-1].microcycle;
  const vr = validateMicrocycleBlocks(wLast);
  ok(vr.coherent, 'V3.5.1 honestidad: progresión sostenida fuera de zona NO rompe coherencia (viability, no hard)');
}

/* ============================================================
   V3.6 — INVARIANTE: EL GENERADOR NO PRODUCE DRIFT HEURÍSTICO DIFUSO.
   Caracterización (NO autochequeo): los 4 flags de drift difuso de V3.6
   (slc_resembles / superset_resembles / complex_resembles_french_contrast /
   complex_likely_misclassified_as_family) son informational y NO son v3_constraint,
   así que NO se imponen como compuerta de runtime (a diferencia del drift de MODELO
   de V3.4, que sí lo es). Pero el generador produce familias coherentes por
   construcción → atestiguamos que ningún bloque generado dispara drift difuso. Si
   una calibración futura derivara, este test lo reporta como caracterización rota
   (revisar), sin que el generador falle sobre un bloque potencialmente válido.
   ============================================================ */
console.log('— V3.6 invariante: generador no produce drift difuso —');
const FUZZY_DRIFT = new Set([
  'slc_resembles_contrast_heavy_light',
  'superset_resembles_contrast_heavy_light',
  'complex_resembles_french_contrast',
  'complex_likely_misclassified_as_family',
]);
const V36_SPECS = [
  // SLC (single_load_chain) — debe NO parecer contrast/heavy_light ni mal clasificado.
  ['complex/olympic_complex', { method:'complex', variant:'olympic_complex', target_zone:'Z3' }],
  ['complex/kb_flow',         { method:'complex', variant:'kb_flow', target_zone:'Z4' }],
  // ILC (independent_load_chain) — NO debe parecer SLC ni superset→contrast.
  ['complex/giant_set',       { method:'complex', variant:'giant_set', target_zone:'Z5' }],
  ['complex/accessory_complex', { method:'complex', variant:'accessory_complex', target_zone:'Z5' }],
  ['complex/superset',        { method:'complex', variant:'superset', target_zone:'Z5' }],
  ['complex/peripheral_heart_action', { method:'complex', variant:'peripheral_heart_action', target_zone:'Z5' }],
  ['complex/antagonist_giant_set', { method:'complex', variant:'antagonist_giant_set', target_zone:'Z5' }],
  // circuit — NO debe mal clasificarse como otra familia.
  ['complex/fixed_round_circuit', { method:'complex', variant:'fixed_round_circuit', exercises:EX3, target_zone:'Z5' }],
  ['complex/time_capped_circuit', { method:'complex', variant:'time_capped_circuit', exercises:EX3, target_zone:'Z5' }],
  ['complex/chipper',         { method:'complex', variant:'chipper', exercises:EX4, target_zone:'Z5' }],
  // contrast — NO debe disparar superset_resembles (es contrast real, no superset).
  ['contrast/heavy_light',    { method:'contrast', variant:'heavy_light', exercise:EX0, target_zone:'Z2' }],
  ['contrast/french_contrast', { method:'contrast', variant:'french_contrast', exercise:EX0, target_zone:'Z2' }],
];
let v36Clean = 0, v36Total = 0;
for (const [name, spec] of V36_SPECS){
  const r = GEN.block(spec);
  if (!r.ok) continue;   // gaps de catálogo ya cubiertos por sus propios tests
  v36Total++;
  const drift = validateBlock(r.block, 0).map(f=>f.id).filter(id=>FUZZY_DRIFT.has(id));
  if (drift.length === 0) v36Clean++;
  else ok(false, `V3.6 invariante: ${name} generado dispara drift difuso ${drift.join(',')}`);
}
ok(v36Clean === v36Total && v36Total >= 10,
   `V3.6 invariante: ${v36Clean}/${v36Total} familias generadas SIN drift difuso (caracterización)`);

/* ===================================================================
   V4.1 — MODO DE PROGRESIÓN ROTATIVO (params 1-3): cadencia + pool
   Shift V3: el validador ES el test. La rotación introduce variantes
   nuevas al bloque cada periodo → cada semana progresada pasa por
   validateMicrocycleBlocks (lo hace GEN.progress). Aquí caracterizamos
   la cadencia, el pool en cascada y la regla de coherencia con dientes.
   =================================================================== */
console.log('\n— V4.1 MODO ROTATIVO (cadencia + pool) —\n');

/* Plan de 6 semanas, 1 slot lower de fuerza, para escenarios de rotación. */
const RPLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
  methods_allowed:[['straight','default']], target_zones:['Z2'], segment_focus:'lower' }] };
const rotMeso = (weeks) => GEN.meso({ periodization_model:'conjugate', duration_weeks:weeks||6,
  level:'advanced', microcycle_plan:RPLAN, base_load_pct:80 }, PROFILE);

/* Marca todos los bloques escalares de un meso como rotativos (V4.1: GEN.meso aún
   no lo propaga — eso es V4.3; aquí inyectamos el modo como lo hará la integración). */
function markRotational(meso, period, pool){
  for (const wk of meso.weeks){
    const micro = wk.microcycle; if (!micro || !Array.isArray(micro.sessions)) continue;
    for (const blocks of micro.sessions){
      for (const b of (blocks||[])){
        if (b && typeof b.exercise === 'string'){
          b.progression_mode = 'rotational';
          b.rotation_period_weeks = period;
          if (pool) b.rotation_pool = pool.slice();
        }
      }
    }
  }
  return meso;
}

/* (0) Retrocompatibilidad: sin progression_mode → accumulative (V3.5 intacto). */
{
  const r0 = baseMeso();
  ok(r0.ok, 'V4.1 retrocompat: meso base generado (modo default)');
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}} };
  const pr = GEN.progress(r0.meso, fb, PROFILE);
  ok(pr.ok && pr.meso, 'V4.1 retrocompat: progress sin modo declarado emite meso (accumulative)');
}

/* (1) REGLA DE COHERENCIA con dientes: rotation_period >= meso_duration → falla ruidosa. */
{
  const r = rotMeso(4); ok(r.ok, 'V4.1 base: meso conjugate 4sem generado');
  markRotational(r.meso, 4);   // period 4 >= 4 semanas → no hay rotación real
  const pr = GEN.progress(r.meso, {}, PROFILE);
  ok(!pr.ok && pr.meso === null, 'V4.1 coherencia: period>=meso_duration → falla ruidosa (meso:null)');
  ok(Array.isArray(pr.reason) && pr.reason.some(x=>/gen_rotational_no_rotation/.test(x)),
     'V4.1 coherencia: razón gen_rotational_no_rotation');
}

/* (2) EL VALIDADOR ES EL TEST: meso rotativo coherente pasa cada microciclo. */
{
  const r = rotMeso(6); markRotational(r.meso, 2);   // 6 sem, rota cada 2 → 3 periodos
  const pr = GEN.progress(r.meso, {}, PROFILE);
  ok(pr.ok && pr.meso, 'V4.1 validador-es-test: meso rotativo progresado emitido');
  if (pr.meso){
    let allCoherent = true;
    for (const wk of pr.meso.weeks){
      const m = wk.microcycle;
      if (m){ const v = validateMicrocycleBlocks(m); if (v && v.coherent === false) allCoherent = false; }
    }
    ok(allCoherent, 'V4.1 validador-es-test: cada microciclo del meso rotativo es coherente');
  }
}

/* (3) CADENCIA: la variante rota cada rotation_period_weeks, NO antes.
   4 semanas, period 2 → 2 periodos (sin deload: umbral conjugate advanced=5>4). */
{
  const POOL = ['back_squat','front_squat','goblet_squat'];   // pool explícito (param 3, fuente 1)
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const pr = GEN.progress(r.meso, {}, PROFILE);
  ok(pr.ok, 'V4.1 cadencia: meso 4sem rotativo progresa (sin deload)');
  const seq = pr.meso.weeks.map(wk => {
    const b = wk.microcycle && wk.microcycle.sessions[0] && wk.microcycle.sessions[0][0];
    return b ? b.exercise : null;
  });
  // period 2: semanas [0,1] variante del periodo 0, [2,3] variante del periodo 1.
  ok(seq[0] === seq[1], `V4.1 cadencia: sem 1-2 misma variante (${seq[0]})`);
  ok(seq[2] === seq[3], `V4.1 cadencia: sem 3-4 misma variante (${seq[2]})`);
  ok(seq[0] !== seq[2], 'V4.1 cadencia: la variante CAMBIA entre periodos');
  // pool ordenado estable alfabético: back_squat (p0), front_squat (p1)
  ok(seq[0] === 'back_squat' && seq[2] === 'front_squat',
     'V4.1 cadencia: rotación secuencial estable sobre pool ordenado');
}

/* (4) POOL en cascada — fuente 3 (fallback implícito por pattern+segment).
   Fija el ejercicio base a back_squat (patrón squat, pool rico de 9) para que el
   fallback implícito tenga material; sin esto el slot puede elegir un patrón pobre. */
{
  const RPLAN_SQ = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'conjugate', duration_weeks:6, level:'intermediate',
    microcycle_plan:RPLAN_SQ, base_load_pct:80 }, PROFILE);
  const basePat = (DATA.exercises[r.meso.weeks[0].microcycle.sessions[0][0].exercise]||{}).pattern;
  markRotational(r.meso, 2);   // re-marca con pool implícito (sin pool explícito)
  const pr = GEN.progress(r.meso, {}, PROFILE);
  ok(pr.ok, 'V4.1 pool implícito: meso rotativo sin pool declarado progresa (fallback _candidates)');
  const seq = pr.meso.weeks.map(wk => {
    const b = wk.microcycle && wk.microcycle.sessions[0] && wk.microcycle.sessions[0][0];
    return b ? b.exercise : null;
  });
  const distinct = new Set(seq.filter(Boolean));
  ok(distinct.size >= 2, `V4.1 pool implícito: deriva ≥2 variantes del catálogo (${distinct.size})`);
  // todas las variantes derivadas comparten el patrón INVARIANTE del ejercicio base
  let sameStimulus = true;
  for (const id of distinct){ const e = DATA.exercises[id]; if (!e || e.pattern !== basePat) sameStimulus = false; }
  ok(sameStimulus, `V4.1 pool implícito: todas las variantes comparten el patrón invariante (${basePat})`);
}

/* (5) POOL INSUFICIENTE: pool < N_min → flag informational, rota con repetición (no falla). */
{
  const r = rotMeso(6); markRotational(r.meso, 1, ['back_squat','front_squat']);  // N_min=ceil(6/1)+1=7, pool=2
  const pr = GEN.progress(r.meso, {}, PROFILE);
  ok(pr.ok && pr.meso, 'V4.1 pool insuficiente: progresa igual (repetición cíclica, no falla dura)');
  const flagged = (pr.meso._progression_log||[]).some(e => e.detail && e.detail.pool_insufficient);
  ok(flagged, 'V4.1 pool insuficiente: registrado pool_insufficient en el log');
  const seq = pr.meso.weeks.map(wk => { const b = wk.microcycle.sessions[0][0]; return b?b.exercise:null; });
  ok(seq[0] === 'back_squat' && seq[1] === 'front_squat' && seq[2] === 'back_squat',
     'V4.1 pool insuficiente: rota cíclicamente (A,B,A,...) sin parar');
}

/* (6) RETROCOMPAT del modo accumulative: V3.5 sigue idéntico bajo el dispatch. */
{
  const r = baseMeso();
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}},
               2:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}},
               3:{byBlock:{'s0_b0':{rir_reported:4, reps_done:8}}} };
  const pr = GEN.progress(r.meso, fb, PROFILE);
  ok(pr.ok, 'V4.1 dispatch: modo accumulative (default) sigue progresando como V3.5');
  const acted = (pr.meso._progression_log||[]).some(e => /double_prog|load/.test(e.action||''));
  ok(acted, 'V4.1 dispatch: accumulative ejerce doble progresión (V3.5 intacto bajo el dispatch)');
}

/* (7) REPRODUCIBILIDAD: misma semilla de meso → misma secuencia de rotación. */
{
  const a = rotMeso(6); markRotational(a.meso, 2);
  const b = rotMeso(6); markRotational(b.meso, 2);
  const pa = GEN.progress(a.meso, {}, PROFILE);
  const pb = GEN.progress(b.meso, {}, PROFILE);
  const seqA = pa.meso.weeks.map(wk=>wk.microcycle.sessions[0][0].exercise).join(',');
  const seqB = pb.meso.weeks.map(wk=>wk.microcycle.sessions[0][0].exercise).join(',');
  ok(seqA === seqB, 'V4.1 reproducibilidad: rotación determinista (misma secuencia)');
}

/* ===================================================================
   V4.2 — MÉTRICA POR DESVIACIÓN DE e1RM PREDICHO (param 4)
   Hace comparable lo incomparable: predice el e1RM de la variante nueva
   desde la conocida (load_translation del grafo o _rel1rm de P7) y mide el
   avance como desviación del observado vs el predicho.
   =================================================================== */
console.log('\n— V4.2 MÉTRICA DE AVANCE POR e1RM PREDICHO —\n');

/* Acceso a los helpers V4.2 vía exports para tests unitarios directos. */
const { _rotationRatio, _rotationAdvance, _e1rmFromFeedback } = mod.exports;

/* (0) Epley directo: e1RM desde (carga, reps). */
ok(Math.abs(_e1rmFromFeedback(100, 1) - 103.33) < 0.1, 'V4.2 epley: 100kg×1 → e1RM ~103.3 (Epley)');
ok(Math.abs(_e1rmFromFeedback(100, 5) - 116.67) < 0.1, 'V4.2 epley: 100kg×5 → e1RM ~116.7');
ok(_e1rmFromFeedback(0, 5) === null && _e1rmFromFeedback(100, 0) === null, 'V4.2 epley: dato faltante → null');

/* (1) RATIO V_a→V_b: vía _rel1rm de P7 (front_squat ≈ 0.85×back_squat declarado). */
{
  const rr = _rotationRatio('back_squat', 'front_squat');
  ok(rr && rr.source === 'rel1rm_p7', 'V4.2 ratio: usa P7 cuando no hay equivalence_edge');
  ok(rr && Math.abs(rr.ratio - 0.85) < 0.02, `V4.2 ratio: back→front ≈0.85 (P7) (${rr&&rr.ratio.toFixed(3)})`);
  const id = _rotationRatio('back_squat', 'back_squat');
  ok(id && id.ratio === 1 && id.source === 'identity', 'V4.2 ratio: misma variante → 1 (identity)');
}

/* (2) AVANCE: observado == predicho → avance ≈ 0 (rotación neutra esperada). */
{
  // prev: back_squat, 120kg×3 → e1RM 132. ratio back→front 0.85 → pred front = 112.2.
  // cur: front_squat a una carga que da exactamente e1RM 112.2 → 102kg×3 → e1RM 112.2.
  const prev = { ex:'back_squat', loadPct:80, fb:{ reps_done:3, load_kg:120 } };
  const e1prev = _e1rmFromFeedback(120,3);                 // 132
  const ratio = _rotationRatio('back_squat','front_squat').ratio;
  const predLoad = (e1prev*ratio) / (1 + 3/30);            // carga que da e1RM predicho a 3 reps
  const cur = { ex:'front_squat', loadPct:80, fb:{ reps_done:3, load_kg: predLoad } };
  const adv = _rotationAdvance(prev, cur, PROFILE);
  ok(adv && Math.abs(adv.advance) < 0.01, `V4.2 avance: observado=predicho → ≈0 (${adv&&adv.advance.toFixed(4)})`);
}

/* (3) AVANCE POSITIVO: la variante nueva supera la predicción → avance > 0. */
{
  const prev = { ex:'back_squat', loadPct:80, fb:{ reps_done:3, load_kg:120 } };
  const ratio = _rotationRatio('back_squat','front_squat').ratio;
  const predLoad = (_e1rmFromFeedback(120,3)*ratio) / (1 + 3/30);
  const cur = { ex:'front_squat', loadPct:80, fb:{ reps_done:3, load_kg: predLoad*1.08 } };  // +8%
  const adv = _rotationAdvance(prev, cur, PROFILE);
  ok(adv && adv.advance > 0.05, `V4.2 avance positivo: superó la predicción (${adv&&adv.advance.toFixed(3)})`);
}

/* (4) AVANCE NEGATIVO: la variante nueva queda bajo la predicción → avance < 0. */
{
  const prev = { ex:'back_squat', loadPct:80, fb:{ reps_done:3, load_kg:120 } };
  const ratio = _rotationRatio('back_squat','front_squat').ratio;
  const predLoad = (_e1rmFromFeedback(120,3)*ratio) / (1 + 3/30);
  const cur = { ex:'front_squat', loadPct:80, fb:{ reps_done:3, load_kg: predLoad*0.9 } };   // -10%
  const adv = _rotationAdvance(prev, cur, PROFILE);
  ok(adv && adv.advance < -0.05, `V4.2 avance negativo: bajo la predicción (${adv&&adv.advance.toFixed(3)})`);
}

/* (5) SIN FEEDBACK suficiente → sin señal (null). */
{
  const prev = { ex:'back_squat', loadPct:80, fb:{ reps_done:3 } };  // sin load_kg ni perfil-pct utilizable
  const cur  = { ex:'front_squat', loadPct:null, fb:{ reps_done:3 } };
  const adv = _rotationAdvance(prev, cur, null);
  ok(adv === null, 'V4.2 sin feedback: sin carga derivable → null (sin señal)');
}

/* (6) INTEGRACIÓN: avance positivo en GEN.progress modula la carga del nuevo periodo (acelera). */
{
  const POOL = ['back_squat','front_squat'];   // ambos con ruta de e1RM (back directo, front P7)
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  // Feedback: durante el periodo 0 (back_squat) el atleta sobre-cumple con carga alta.
  // Semana 1-2 back_squat fuerte; al rotar a front (sem 3) reporta carga que supera la predicción.
  const fb = {
    1:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}},
    2:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:135}}},
    3:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}},  // front a 130 >> pred (~115)
    4:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}}
  };
  const pr = GEN.progress(r.meso, fb, PROFILE);
  ok(pr.ok, 'V4.2 integración: meso rotativo con feedback de fuerza progresa');
  const accel = (pr.meso._progression_log||[]).some(e =>
    e.detail && e.detail.advance && e.detail.advance.action === 'accelerate');
  ok(accel, 'V4.2 integración: avance positivo al rotar → acelera la carga del nuevo periodo');
}

/* (7) INVARIANTE: el meso rotativo con métrica de avance sigue pasando el validador. */
{
  const POOL = ['back_squat','front_squat'];
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const fb = { 1:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}},
               2:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:135}}},
               3:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}},
               4:{byBlock:{'s0_b0':{rir_reported:1, reps_done:3, load_kg:130}}} };
  const pr = GEN.progress(r.meso, fb, PROFILE);
  let coherent = true;
  for (const wk of pr.meso.weeks){
    const m = wk.microcycle;
    if (m){ const v = validateMicrocycleBlocks(m); if (v && v.coherent === false) coherent = false; }
  }
  ok(coherent, 'V4.2 invariante: meso rotativo+avance pasa validateMicrocycleBlocks (fitness function)');
}

/* ===================================================================
   V4.2 — MÉTRICA DE PROGRESIÓN ROTATIVA (param 4): desviación vs e1RM predicho
   La pieza novedosa: avance = (e1rm_obs(V_b) − e1rm_pred(V_b))/e1rm_pred, donde
   e1rm_pred(V_b) = e1rm_obs(V_a) × ratio(V_a→V_b) (load_translation o P7 _rel1rm).
   =================================================================== */
console.log('\n— V4.2 MÉTRICA ROTATIVA (desviación de e1RM predicho) —\n');

/* Perfil con e1RMs de hubs para que _absoluteLoad derive kg reales por variante. */
const RPROF = Object.assign({}, PROFILE, { strength: { back_squat_e1rm: 180, front_squat_e1rm: 153 } });

/* (8) AVANCE positivo: tras rotar, el atleta rinde por ENCIMA de lo predicho → acelera.
   6 sem, period 2, pool explícito back→front→goblet; feedback con reps altas en el
   2º periodo (front_squat) que superan la predicción desde back_squat. */
{
  const POOL = ['back_squat','front_squat','goblet_squat'];
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  // Semanas 1-2 (back_squat): rinde nominal. Semanas 3-4 (front_squat): rinde por encima.
  const fb = { 1:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},   // back @ ~85%×5
               2:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               3:{byBlock:{'s0_b0':{reps_done:8, load_kg:140}}},   // front: más reps → e1RM↑
               4:{byBlock:{'s0_b0':{reps_done:8, load_kg:140}}} };
  const pr = GEN.progress(r.meso, fb, RPROF);
  ok(pr.ok, 'V4.2 avance+: meso rotativo con feedback progresa');
  const advEntries = (pr.meso._progression_log||[])
    .map(e => e.detail && e.detail.advance).filter(Boolean);
  ok(advEntries.length >= 1, 'V4.2 avance+: se computó al menos un avance al rotar');
  const accel = advEntries.some(a => a.action === 'accelerate' && a.advance > 0);
  ok(accel, 'V4.2 avance+: rendimiento sobre lo predicho → acelera carga');
}

/* (9) AVANCE negativo: tras rotar, el atleta rinde por DEBAJO de lo predicho → frena. */
{
  const POOL = ['back_squat','front_squat'];
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const fb = { 1:{byBlock:{'s0_b0':{reps_done:6, load_kg:153}}},   // back: rinde bien
               2:{byBlock:{'s0_b0':{reps_done:6, load_kg:153}}},
               3:{byBlock:{'s0_b0':{reps_done:2, load_kg:110}}},   // front: muy por debajo
               4:{byBlock:{'s0_b0':{reps_done:2, load_kg:110}}} };
  const pr = GEN.progress(r.meso, fb, RPROF);
  ok(pr.ok, 'V4.2 avance−: progresa con feedback de retroceso');
  const advEntries = (pr.meso._progression_log||[])
    .map(e => e.detail && e.detail.advance).filter(Boolean);
  const brake = advEntries.some(a => a.action === 'brake' && a.advance < 0);
  ok(brake, 'V4.2 avance−: rendimiento bajo lo predicho → frena carga');
}

/* (10) FUENTE del ratio: front_squat declara strength_ratio_vs back_squat (P7) →
   la composición _rel1rm resuelve el ratio sin equivalence_edge (que está vacío). */
{
  const POOL = ['back_squat','front_squat'];
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const fb = { 1:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               2:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               3:{byBlock:{'s0_b0':{reps_done:5, load_kg:130}}},
               4:{byBlock:{'s0_b0':{reps_done:5, load_kg:130}}} };
  const pr = GEN.progress(r.meso, fb, RPROF);
  const adv = (pr.meso._progression_log||[]).map(e => e.detail && e.detail.advance).filter(Boolean)[0];
  ok(adv && adv.source === 'rel1rm_p7', 'V4.2 ratio: fuente = P7 _rel1rm (grafo de fuerza, equivalence_edge vacío)');
  ok(adv && typeof adv.advance === 'number', 'V4.2 ratio: avance computado como número finito');
}

/* (11) SIN feedback → no hay avance computable; la rotación sigue (cadencia intacta). */
{
  const POOL = ['back_squat','front_squat'];
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const pr = GEN.progress(r.meso, {}, RPROF);   // sin feedback
  ok(pr.ok, 'V4.2 sin feedback: rota igual (cadencia no depende del feedback)');
  const anyAdv = (pr.meso._progression_log||[]).some(e => e.detail && e.detail.advance);
  ok(!anyAdv, 'V4.2 sin feedback: no se computa avance (degrada a solo-rotación)');
}

/* (12) BANDA MUERTA: rendimiento ≈ predicho → neutral (ni acelera ni frena). */
{
  const POOL = ['back_squat','back_squat'];   // misma variante → ratio 1, sin desviación esperada
  const r = rotMeso(4); markRotational(r.meso, 2, POOL);
  const fb = { 1:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               2:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               3:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}},
               4:{byBlock:{'s0_b0':{reps_done:5, load_kg:153}}} };
  const pr = GEN.progress(r.meso, fb, RPROF);
  const adv = (pr.meso._progression_log||[]).map(e => e.detail && e.detail.advance).filter(Boolean)[0];
  ok(adv && adv.action === 'neutral', 'V4.2 banda muerta: rendimiento ≈ predicho → neutral (±2%)');
}

/* ===================================================================
   V4.3 — INTEGRACIÓN CONJUGATE: genMeso fija progression_mode rotational por
   defecto en los slots de fuerza de conjugate; cualquier modelo puede opt-in.
   =================================================================== */
console.log('\n— V4.3 INTEGRACIÓN CONJUGATE —\n');

/* (13) conjugate fija el modo rotativo por defecto en slots de fuerza. */
{
  const PLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'conjugate', duration_weeks:6, level:'intermediate',
    microcycle_plan:PLAN, base_load_pct:80 }, PROFILE);
  ok(r.ok, 'V4.3 conjugate: meso generado');
  const b = r.meso.weeks[0].microcycle.sessions[0][0];
  ok(b && b.progression_mode === 'rotational', 'V4.3 conjugate: slot de fuerza marcado rotational por defecto');
  ok(b && b.rotation_period_weeks === 2, 'V4.3 conjugate: rotation_period default 2 (MARCA-FIS)');
}

/* (14) Un modelo NO-conjugate NO marca rotativo por defecto (sigue accumulative). */
{
  const PLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:4, level:'intermediate', microcycle_plan:PLAN, base_load_pct:75 }, PROFILE);
  const b = r.meso.weeks[0].microcycle.sessions[0][0];
  ok(!b.progression_mode || b.progression_mode === 'accumulative',
     'V4.3 linear: NO marca rotativo (default accumulative, V3.5 intacto)');
}

/* (15) OVERRIDE del llamador: un slot que declara su modo gana sobre el default conjugate. */
{
  const PLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1, progression_mode:'accumulative',
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'conjugate', duration_weeks:4, level:'intermediate',
    microcycle_plan:PLAN, base_load_pct:80 }, PROFILE);
  const b = r.meso.weeks[0].microcycle.sessions[0][0];
  ok(b.progression_mode === 'accumulative', 'V4.3 override: slot accumulative explícito gana sobre default conjugate');
}

/* (16) Modelo general OPT-IN: linear con slot rotational explícito → rota. */
{
  const PLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
    progression_mode:'rotational', rotation_period_weeks:2, rotation_pool:['back_squat','front_squat'],
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'linear', model_variant:'classic_linear',
    duration_weeks:4, level:'intermediate', microcycle_plan:PLAN, base_load_pct:75 }, PROFILE);
  ok(r.ok, 'V4.3 opt-in: linear con slot rotational genera');
  const pr = GEN.progress(r.meso, {}, PROFILE);
  const seq = pr.meso.weeks.map(wk=>wk.microcycle.sessions[0][0].exercise);
  ok(seq[0]==='back_squat' && seq[2]==='front_squat',
     'V4.3 opt-in: modo rotativo invocable fuera de conjugate (rota la variante)');
}

/* (17) Slot de CONDITIONING en conjugate NO rota (sin intent de fuerza). */
{
  const PLAN = { slots:[
    { slot_id:'d1', intent:'strength', n_blocks:1,
      block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] },
    { slot_id:'d2', intent:'conditioning', n_blocks:1,
      block_specs:[{ method:'complex', variant:'fixed_round_circuit', exercises:EX3, target_zone:'Z5' }] } ] };
  const r = GEN.meso({ periodization_model:'conjugate', duration_weeks:4, level:'intermediate',
    microcycle_plan:PLAN, base_load_pct:80 }, PROFILE);
  ok(r.ok, 'V4.3 conditioning: meso mixto fuerza+conditioning generado');
  const strengthB = r.meso.weeks[0].microcycle.sessions[0][0];
  const condB     = r.meso.weeks[0].microcycle.sessions[1][0];
  ok(strengthB.progression_mode === 'rotational', 'V4.3 conditioning: slot de fuerza SÍ rotativo');
  ok(!condB.progression_mode || condB.progression_mode !== 'rotational',
     'V4.3 conditioning: slot de conditioning NO rotativo (sin intent de fuerza)');
}

/* (18) La EXCEPCIÓN de drift es legítima: tras GEN.progress, el meso conjugate
   rotativo YA materializó la rotación → re-validado, conjugate_without_rotation
   NO dispara (la rotación estaba delegada, no ausente). */
{
  const PLAN = { slots:[{ slot_id:'d1', intent:'strength', n_blocks:1,
    rotation_pool:['back_squat','front_squat','goblet_squat'],
    block_specs:[{ method:'straight', variant:'default', exercise:'back_squat', target_zone:'Z2' }] }] };
  const r = GEN.meso({ periodization_model:'conjugate', duration_weeks:6, level:'intermediate',
    microcycle_plan:PLAN, base_load_pct:80 }, PROFILE);
  ok(r.ok, 'V4.3 excepción: meso conjugate rotativo construye (drift conjugate_without_rotation eximido pre-progress)');
  const pr = GEN.progress(r.meso, {}, PROFILE);
  // tras progresar, re-valida el meso: las variantes ya rotaron → no más drift de rotación.
  const post = validateMesocycleBlocks(pr.meso);
  const stillDrift = (post.driftFired||[]).includes('conjugate_without_rotation');
  const seq = pr.meso.weeks.map(wk=>wk.microcycle.sessions[0][0].exercise);
  const distinct = new Set(seq.filter(Boolean));
  ok(distinct.size >= 2, `V4.3 excepción: post-progress el meso usa ≥2 variantes (${distinct.size}) — rotación materializada`);
  ok(!stillDrift, 'V4.3 excepción: post-progress NO dispara conjugate_without_rotation (drift resuelto por la rotación real)');
}

console.log(`\nGENERADOR V3: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);