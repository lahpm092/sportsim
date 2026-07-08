#!/usr/bin/env node
/*
test_prescriptor.js — suite automática del motor de validación.
  1. GOLDEN: casos reales anotados (tests/validation_cases.json) — cada hallazgo
     de uso se vuelve test permanente.
  2. INVARIANTE A: todo variant con sus defaults + fixture válido → 0 flags.
  3. INVARIANTE B: todo parámetro numérico fuera de rango → dispara el flag
     correcto (checks GENERADOS desde los schemas, no escritos a mano).
  4. CRASH SAFETY: el motor nunca lanza excepción.
Uso: node tools/test_prescriptor.js   (desde la raíz del repo)
El build llama esto automáticamente: sin verde no hay entrega.
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- cargar el motor desde el HTML generado ----
const html = fs.readFileSync(path.join(ROOT, 'prescriptor/prescriptor.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const stub = `const document={querySelector:()=>({innerHTML:'',style:{},value:'',onclick:null,oninput:null,onchange:null,classList:{add:()=>{},remove:()=>{}},querySelector:()=>({textContent:''}),querySelectorAll:()=>[]}),querySelectorAll:()=>[],addEventListener:()=>{},createElement:()=>({addEventListener:()=>{},innerHTML:'',className:''})};const navigator={clipboard:{writeText:async()=>{}}};const window={};function setTimeout(f){};`;
const mod = { exports: {} };
new Function('module','require', stub + script)(mod, require);
const { validateBlock, newBlock, applyDefaults, DATA } = mod.exports;

let pass = 0, fail = 0, gaps = [];
const bad = (msg) => { console.log('  ✗ ' + msg); fail++; };
const ok = () => pass++;

function mk(method, variant, setup, params){
  const b = newBlock(); b.method = method; b.variant = variant; applyDefaults(b);
  Object.assign(b, setup || {}); Object.assign(b.params, params || {}); return b;
}

// ---- fixtures: ejercicio/componentes/intent válidos por método-variante ----
const FIX = {
  _intent_override: { 'cluster/rest_pause_style':'strength' },
  _skip_single: { 'pyramid/multi_exercise_pyramid':'editor multi-ejercicio pendiente (v0.2)' },
  _single: { straight:['back_squat','strength'], cluster:['back_squat','max_strength'],
             drop:['leg_extension','hypertrophy'], rest_pause:['leg_extension','hypertrophy'],
             amrap:['bench_press_barbell','strength'], pyramid:['deadlift_conventional','strength'],
             emom:['kb_swing_two_hand','conditioning'] },
  contrast: {
    heavy_light:   { intent:'power', comps:[{exercise:'deadlift_conventional',role:'heavy',reps:3},{exercise:'box_jump',role:'explosive',reps:4}] },
    complex_pairs: { intent:'power', comps:[{exercise:'back_squat',role:'heavy',reps:3},{exercise:'box_jump',role:'explosive',reps:4}] },
    wave_contrast: { intent:'power', comps:[{exercise:'back_squat',role:'heavy',reps:3},{exercise:'box_jump',role:'explosive',reps:4}] },
    french_contrast:{ intent:'power', comps:[{exercise:'back_squat',role:'heavy_strength',reps:3},{exercise:'box_jump',role:'heavy_plyo',reps:4},{exercise:'push_press',role:'loaded_explosive',reps:4},{exercise:'power_clean',role:'unloaded_plyo',reps:3}] },
  },
  complex: {
    olympic_complex:{ intent:'power', comps:[{exercise:'power_clean',reps:3},{exercise:'push_jerk',reps:3}] },
    kb_flow:        { intent:'conditioning', comps:[{exercise:'kb_swing_two_hand',reps:10},{exercise:'kb_clean',reps:6}] },
    giant_set:      { intent:'hypertrophy', comps:[{exercise:'curl_dumbbell',reps:10},{exercise:'barbell_curl',reps:10},{exercise:'cable_curl',reps:12}], params:{target_muscle_group:'biceps'} },
    accessory_complex:{ intent:'hypertrophy', comps:[{exercise:'leg_extension',reps:12},{exercise:'leg_curl_lying',reps:12}] },
    peripheral_heart_action:{ intent:'conditioning', comps:[{exercise:'goblet_squat',reps:12},{exercise:'push_up',reps:12}] },
    superset:       { intent:'hypertrophy', comps:[{exercise:'curl_dumbbell',reps:10},{exercise:'triceps_pushdown',reps:10}] },
    antagonist_giant_set:{ intent:'hypertrophy', comps:[
      {exercise:'curl_dumbbell',reps:10,pair_index:0,role_in_pair:'agonist'},
      {exercise:'triceps_pushdown',reps:10,pair_index:0,role_in_pair:'antagonist'},
      {exercise:'leg_extension',reps:12,pair_index:1,role_in_pair:'agonist'},
      {exercise:'leg_curl_lying',reps:12,pair_index:1,role_in_pair:'antagonist'}], params:{pairs_count:2} },
    fixed_round_circuit:{ intent:'conditioning', comps:[{exercise:'burpee',reps:30},{exercise:'wall_ball',reps:45}] },
    time_capped_circuit:{ intent:'conditioning', comps:[{exercise:'burpee',reps:20},{exercise:'wall_ball',reps:25}] },
    chipper:        { intent:'conditioning', comps:[{exercise:'burpee',reps:40},{exercise:'wall_ball',reps:30}] },
    tabata:         { intent:'conditioning', comps:[{exercise:'burpee',reps:8},{exercise:'kb_swing_two_hand',reps:10}] },
    strongman_complex:{ skip:'fixture pendiente: catálogo sin pareja de implemento strongman homogéneo' },
    mace_flow:      { skip:'fixture pendiente: catálogo sin ejercicios de mace' },
  }
};
function fixture(method, variant){
  if (method === 'contrast' || method === 'complex'){
    const f = FIX[method][variant];
    if (!f) return null;
    if (f.skip) return { skip: f.skip };
    return { setup: { intent_declared: f.intent, components: JSON.parse(JSON.stringify(f.comps)) }, params: f.params || {} };
  }
  const skip = FIX._skip_single[method+'/'+variant];
  if (skip) return { skip };
  const [ex, intentBase] = FIX._single[method];
  const intent = FIX._intent_override[method+'/'+variant] || intentBase;
  // EMOM v0.2.0: el trabajo por intervalo vive en work_per_interval (array<work_unit>),
  // no en el dead `reps_per_interval`. tpr(kb_swing)=1.5 → 20 reps = 30s: entre el 20%
  // (too_light) y el 85% (density) del intervalo de 60s, holgado en ambos bordes.
  // (alternating usa exercises_rotation y las reglas density la excluyen → queda con [].)
  if (method === 'emom')
    return variant === 'alternating'
      ? { setup: { exercise: ex, intent_declared: intent,
            exercises_rotation: [{ exercise: ex, role:'', work_metric:'reps', work_value:20 },
                                 { exercise:'kb_clean', role:'', work_metric:'reps', work_value:8 }] }, params: {} }
      : { setup: { exercise: ex, intent_declared: intent,
            work_per_interval: [{ exercise: ex, role:'', work_metric:'reps', work_value:20 }] }, params: {} };
  // P5.2 — mechanical_drop: mechanical_progression válida (length = drops_count(2)+1 = 3,
  // demanda decreciente vía difficulty_index_override, misma exercise = sin rom-change,
  // exercise en catálogo = sin step_not_in_catalog).
  if (method === 'drop' && variant === 'mechanical_drop')
    return { setup: { exercise: ex, intent_declared: intent,
             mechanical_progression: [
               { exercise: ex, difficulty_index_override: 4.0 },
               { exercise: ex, difficulty_index_override: 3.0 },
               { exercise: ex, difficulty_index_override: 2.0 } ] }, params: {} };
  return { setup: { exercise: ex, intent_declared: intent }, params: {} };
}

// ============ 1. GOLDEN CASES ============
console.log('— GOLDEN CASES —');
const goldens = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/validation_cases.json'), 'utf8'));
for (const g of goldens.cases){
  let flags;
  try { flags = validateBlock(g.block, 0).map(f => f.id); }
  catch(e){ bad(`${g.id}: EXCEPCIÓN ${e.message}`); continue; }
  const missing = (g.expect_contains || []).filter(id => !flags.includes(id));
  const forbidden = (g.expect_absent || []).filter(id => flags.includes(id));
  const cleanFail = g.expect_clean && flags.length > 0;
  if (missing.length || forbidden.length || cleanFail)
    bad(`${g.id}: ${missing.length?'faltan '+missing.join(','):''} ${forbidden.length?'sobran '+forbidden.join(','):''} ${cleanFail?'esperaba limpio, dio '+flags.join(','):''}`);
  else ok();
}
console.log(`  ${pass} pass`);

// ============ 2. INVARIANTE A: defaults limpios ============
console.log('— INVARIANTE A: variant + defaults + fixture → limpio —');
let aPass = 0;
for (const [mid, m] of Object.entries(DATA.methods)){
  for (const vid of Object.keys(m.variants)){
    const f = fixture(mid, vid);
    if (!f){ gaps.push(`${mid}/${vid}: sin fixture`); continue; }
    if (f.skip){ gaps.push(`${mid}/${vid}: ${f.skip}`); continue; }
    const b = mk(mid, vid, f.setup, f.params);
    let flags;
    try { flags = validateBlock(b, 0); }
    catch(e){ bad(`${mid}/${vid}: EXCEPCIÓN ${e.message}`); continue; }
    if (flags.length) bad(`${mid}/${vid} con defaults → ${flags.map(x=>x.id).join(', ')}`);
    else { ok(); aPass++; }
  }
}
console.log(`  ${aPass} variants limpios | gaps declarados: ${gaps.length}`);

// ============ 3. INVARIANTE B: fronteras de rango (generado) ============
console.log('— INVARIANTE B: fronteras de rango generadas desde schemas —');
let bChecks = 0, bPass = 0;
for (const [mid, m] of Object.entries(DATA.methods)){
  for (const [vid, v] of Object.entries(m.variants)){
    const f = fixture(mid, vid);
    if (!f || f.skip) continue;
    for (const [k, spec] of Object.entries(v.params_schema || {})){
      if (!spec.range_extended) continue;
      if (k === 'components' || k === 'work_per_interval') continue;
      // fuera de extendido → hard
      for (const v_bad of [spec.range_extended.min - 1, spec.range_extended.max + 1]){
        const b = mk(mid, vid, f.setup, f.params);
        b.params[k] = v_bad; bChecks++;
        let flags;
        try { flags = validateBlock(b, 0).map(x => x.id); }
        catch(e){ bad(`${mid}/${vid}.${k}=${v_bad}: EXCEPCIÓN`); continue; }
        if (flags.includes('param_out_of_extended_range')){ bPass++; ok(); }
        else bad(`${mid}/${vid}.${k}=${v_bad} no disparó extended_range (dio: ${flags.join(',')||'nada'})`);
      }
      // brecha canónico-extendido → informational (si existe brecha superior)
      const rc = spec.range_canonical;
      if (rc && spec.range_extended.max > rc.max){
        const mid_val = Math.min(spec.range_extended.max, rc.max + 1);
        const b = mk(mid, vid, f.setup, f.params);
        b.params[k] = mid_val; bChecks++;
        const flags = validateBlock(b, 0).map(x => x.id);
        if (flags.includes('param_out_of_canonical_range')){ bPass++; ok(); }
        else bad(`${mid}/${vid}.${k}=${mid_val} no disparó canonical_range`);
      }
    }
  }
}
console.log(`  ${bPass}/${bChecks} checks de frontera`);

// ============ P3.4: FI del helper intent_off_method + embedding de afinidad ============
console.log('— P3.4: afinidad intent↔método (intent_off_method) —');
(function(){
  // DATA.intent_affinity embebido desde la fuente
  if (DATA && DATA.intent_affinity && DATA.intent_affinity.cluster) ok();
  else bad('DATA.intent_affinity no embebido');
  // off-vocab: cluster sirve a max_strength/strength/power; conditioning está fuera → dispara
  let b = mk('cluster','singles',{exercise:'back_squat',intent_declared:'conditioning'},
            {reps_per_cluster:2,clusters_per_set:3,rest_intra_set_sec:20,load_pct_1rm:88,rest_inter_set_sec:180,sets:4});
  if (validateBlock(b,0).map(f=>f.id).includes('drift_intent_method_mismatch')) ok();
  else bad('intent_off_method: cluster+conditioning debía disparar');
  // dentro de vocab: cluster+max_strength → NO dispara
  b = mk('cluster','singles',{exercise:'back_squat',intent_declared:'max_strength'},
        {reps_per_cluster:2,clusters_per_set:3,rest_intra_set_sec:20,load_pct_1rm:88,rest_inter_set_sec:180,sets:4});
  if (!validateBlock(b,0).map(f=>f.id).includes('drift_intent_method_mismatch')) ok();
  else bad('intent_off_method: cluster+max_strength NO debía disparar');
  // método universal (straight, sin entrada en la tabla) → NUNCA dispara, sea cual sea el intent
  b = mk('straight','default',{exercise:'back_squat',intent_declared:'conditioning'},
        {load_pct_1rm:60,reps_target:12,sets:3,rest_inter_set_sec:90});
  if (!validateBlock(b,0).map(f=>f.id).includes('drift_intent_method_mismatch')) ok();
  else bad('intent_off_method: straight (universal) NO debía disparar');
})();

// ============ Reporte ============
console.log('\n================ RESULTADO ================');
console.log(`PASS: ${pass}  FAIL: ${fail}`);
if (gaps.length){ console.log('KNOWN GAPS (declarados, no fallos):'); gaps.forEach(g=>console.log('  · '+g)); }
process.exit(fail ? 1 : 0);
