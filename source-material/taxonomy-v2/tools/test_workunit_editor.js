#!/usr/bin/env node
/* test_workunit_editor.js — v0.2.0 fault-injection del editor unificado de work_units.
 * Verifica: forma canónica del work_unit (3 métricas + load_metric de 6 valores),
 * shim de lectura (reps plano → canónico, idempotente), instanciación por método
 * (components vs work_per_interval), y serialización YAML canónica.
 * (El sincronizador de compatibilidad c.reps fue retirado en P4.1: las reglas que
 * lo leían migraron al compilador y ahora usan work_metric/work_value directamente.)
 * Disciplina del proyecto: cada aserción positiva tiene su contraparte negativa.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'prescriptor/prescriptor.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const stub = `const document={querySelector:()=>({innerHTML:'',style:{},value:'',onclick:null,oninput:null,onchange:null,classList:{add:()=>{},remove:()=>{}},querySelector:()=>({textContent:''}),querySelectorAll:()=>[]}),querySelectorAll:()=>[],addEventListener:()=>{},createElement:()=>({addEventListener:()=>{},innerHTML:'',className:''})};const navigator={clipboard:{writeText:async()=>{}}};const window={};function setTimeout(f){};`;
const mod = { exports: {} };
new Function('module','require', stub + script)(mod, require);
const X = mod.exports;
const { newWorkUnit, normalizeWU, normalizeBlockWUs, wuArrayKey, wuList, hasWUList,
        WU_WORK_METRICS, WU_LOAD_METRICS, newBlock, applyDefaults, exportYAML, S } = X;

let pass = 0, fail = 0;
const ok  = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

console.log('— v0.2.0 WORK_UNIT EDITOR —');

// 1. forma canónica
const wu = newWorkUnit();
ok(WU_WORK_METRICS.join(',') === 'reps,duration_sec,distance_m', 'métricas canónicas exactas (sin calories)');
ok(WU_LOAD_METRICS.length === 6 && WU_LOAD_METRICS.includes('bodyweight') && WU_LOAD_METRICS.includes('none'), 'load_metric enum de 6 valores');
ok(wu.work_metric === 'reps' && wu.load_metric === 'percent_1rm', 'defaults sensatos del work_unit');
ok(!('calories' in wu), 'calories NO existe en el modelo (fuera de schema canónico)');

// 2. shim de lectura: reps plano → canónico
const old = normalizeWU({ exercise:'back_squat', role:'heavy', reps:5 });
ok(old.work_metric === 'reps' && old.work_value === 5, 'shim: reps plano → work_metric/work_value');
ok(old.load_metric === 'percent_1rm', 'shim: load_metric default tras normalizar');
// idempotencia
const twice = normalizeWU(normalizeWU({ reps:8 }));
ok(twice.work_metric === 'reps' && twice.work_value === 8, 'shim idempotente');
// alias exercise_ref → exercise
const aliased = normalizeWU({ exercise_ref:'deadlift', reps:3 });
ok(aliased.exercise === 'deadlift', 'shim: exercise_ref → exercise');
// metric inválida → reps
const badm = normalizeWU({ work_metric:'watts', work_value:200 });
ok(badm.work_metric === 'reps', 'shim: work_metric fuera de enum → reps (sanitiza)');
const badl = normalizeWU({ load_metric:'rpe' });
ok(badl.load_metric === 'percent_1rm', 'shim: load_metric fuera de enum → percent_1rm (sanitiza)');
// NO sobrescribe un work_unit ya canónico
const canon = normalizeWU({ work_metric:'duration_sec', work_value:30, load_metric:'none' });
ok(canon.work_metric === 'duration_sec' && canon.work_value === 30 && canon.load_metric === 'none', 'shim NO corrompe work_unit ya canónico');

// 3. arrayKey por método
const bC = newBlock(); bC.method='contrast';
const bX = newBlock(); bX.method='complex';
const bE = newBlock(); bE.method='emom';
const bS = newBlock(); bS.method='straight';
ok(wuArrayKey(bC) === 'components', 'contrast → components');
ok(wuArrayKey(bX) === 'components', 'complex → components');
ok(wuArrayKey(bE) === 'work_per_interval', 'emom → work_per_interval');
ok(hasWUList(bC) && hasWUList(bX) && hasWUList(bE), 'contrast/complex/emom tienen lista de work_units');
ok(!hasWUList(bS), 'straight NO tiene lista (ejercicio único)');

// 4. normalizeBlockWUs aplica al array correcto
const bImport = newBlock(); bImport.method='emom';
bImport.work_per_interval = [{ reps:10 }, { duration_sec:20, load_metric:'time' }];
normalizeBlockWUs(bImport);
ok(bImport.work_per_interval[0].work_metric === 'reps' && bImport.work_per_interval[0].work_value === 10, 'normalizeBlockWUs normaliza work_per_interval (reps)');
ok(bImport.work_per_interval[1].work_metric === 'duration_sec' && bImport.work_per_interval[1].work_value === 20, 'normalizeBlockWUs preserva métrica no-reps');

// 5. serialización YAML canónica (round-trip de exportYAML)
S.name = 'fi_test'; S.intent = ''; S.activeIdx = 0;
// 5a. EMOM con work_per_interval en tiempo + carga none
const e = newBlock(); e.method='emom'; e.variant=Object.keys(X.DATA.methods.emom.variants)[0]; applyDefaults(e);
e.work_per_interval = [ Object.assign(newWorkUnit(), { exercise:'kb_swing_two_hand', work_metric:'duration_sec', work_value:40, load_metric:'none' }) ];
S.blocks = [e];
let y = exportYAML();
ok(/work_per_interval:/.test(y), 'YAML: emite work_per_interval para EMOM');
ok(/duration_sec: 40/.test(y), 'YAML: serializa métrica duration_sec con su valor');
ok(/load_metric: none/.test(y), 'YAML: serializa load_metric none');
ok(!/load_pct_1rm/.test(y), 'YAML: no emite load_pct_1rm cuando metric=none');
ok(!/reps_per_component/.test(y), 'YAML: NO usa el campo plano viejo reps_per_component');

// 5b. contrast con load percent_1rm + role
const c = newBlock(); c.method='contrast'; c.variant=Object.keys(X.DATA.methods.contrast.variants)[0]; applyDefaults(c);
c.components = [ Object.assign(newWorkUnit(), { exercise:'back_squat', role:'heavy', work_metric:'reps', work_value:3, load_metric:'percent_1rm', load_pct_1rm:88 }) ];
S.blocks = [c];
y = exportYAML();
ok(/components:/.test(y), 'YAML: emite components para contrast');
ok(/role: heavy/.test(y) && /reps: 3/.test(y) && /load_pct_1rm: 88/.test(y), 'YAML: role + reps + load_pct_1rm canónicos');

// 5c. absolute_load → load_value + load_unit
const a = newBlock(); a.method='complex'; a.variant=Object.keys(X.DATA.methods.complex.variants)[0]; applyDefaults(a);
a.components = [ Object.assign(newWorkUnit(), { exercise:'farmers_carry', work_metric:'distance_m', work_value:20, load_metric:'absolute_load', load_value:32, load_unit:'kg' }) ];
S.blocks = [a];
y = exportYAML();
ok(/distance_m: 20/.test(y) && /load_value: 32/.test(y) && /load_unit: kg/.test(y), 'YAML: absolute_load → load_value + load_unit');

// ====================== P5.1 — editor de rampa (set_ramp / round_plan) ======================
const { rampKey, rampActive, newRampStep, normalizeRamp, normalizeRampStep, seedRamp } = X;
// rampKey por método/variante
function rb(variant){ const b=newBlock(); b.method='pyramid'; b.variant=variant; applyDefaults(b); return b; }
ok(rampKey(rb('ascending'))==='set_ramp', 'rampKey: ascending → set_ramp');
ok(rampKey(rb('descending'))==='set_ramp', 'rampKey: descending → set_ramp');
ok(rampKey(rb('multi_exercise_pyramid'))==='round_plan', 'rampKey: MEP → round_plan');
ok(rampKey(rb('double'))===null && rampKey(rb('wave'))===null, 'rampKey: double/wave → null (no-monótonos por diseño)');
{ const b=newBlock(); ok(rampKey(b)===null, 'rampKey: no-pyramid → null'); }
// rampActive gobernado por load_progression == custom
{ const b=rb('ascending'); b.params.load_progression='linear'; ok(!rampActive(b), 'rampActive: linear → false');
  b.params.load_progression='custom'; ok(rampActive(b), 'rampActive: custom → true'); }
// seedRamp interpola lineal desde escalares (punto de partida monótono)
{ const b=rb('ascending'); b.params.load_progression='custom'; seedRamp(b);
  ok(b.set_ramp.length===4, 'seedRamp: longitud = sets_count (4)');
  ok(b.set_ramp[0].load_pct_1rm===60 && b.set_ramp[3].load_pct_1rm===90, 'seedRamp: endpoints = first/last_set');
  const loads=b.set_ramp.map(s=>s.load_pct_1rm);
  let mono=true; for(let i=1;i<loads.length;i++) if(loads[i-1]>loads[i]) mono=false;
  ok(mono, 'seedRamp: rampa sembrada es monótona (no dispara el flag por defecto)'); }
// normalizeRampStep coacciona '' → null y strings → number
{ const s=normalizeRampStep({load_pct_1rm:'80', reps:''}); ok(s.load_pct_1rm===80 && s.reps===null, 'normalizeRampStep: coercion numerica + vacio a null'); }
// export YAML emite set_ramp solo en custom
{ const b=rb('ascending'); b.intent_declared='hypertrophy'; b.params.load_progression='custom';
  b.set_ramp=[{load_pct_1rm:60,reps:12},{load_pct_1rm:75,reps:6},{load_pct_1rm:90,reps:3}];
  S.blocks=[b]; const yr=exportYAML();
  ok(/set_ramp:/.test(yr) && /load_pct_1rm: 75/.test(yr) && /reps: 6/.test(yr), 'YAML: emite set_ramp en custom'); }
{ const b=rb('ascending'); b.intent_declared='hypertrophy'; b.params.load_progression='linear';
  b.set_ramp=[{load_pct_1rm:60,reps:12}]; S.blocks=[b];
  ok(!/set_ramp:/.test(exportYAML()), 'YAML: NO emite set_ramp fuera de custom'); }
// round_plan para MEP
{ const b=rb('multi_exercise_pyramid'); b.intent_declared='hypertrophy'; b.params.load_progression='custom';
  b.round_plan=[{load_pct_1rm:65,reps:10},{load_pct_1rm:85,reps:4}]; S.blocks=[b];
  ok(/round_plan:/.test(exportYAML()), 'YAML: emite round_plan (MEP) en custom'); }

// ====================== P5.2 — editor de progresión mecánica ======================
const { mechKey, newMechStep, normalizeMech, normalizeMechStep } = X;
{ const b=newBlock(); b.method='drop'; b.variant='mechanical_drop'; ok(mechKey(b)==='mechanical_progression', 'mechKey: drop/mechanical_drop → mechanical_progression');
  b.variant='standard'; ok(mechKey(b)===null, 'mechKey: otra variante de drop → null'); }
{ const s=normalizeMechStep({exercise_ref:'leg_extension', difficulty_index_override:'3.5'});
  ok(s.exercise==='leg_extension', 'normalizeMechStep: exercise_ref → exercise (compat catálogo)');
  ok(s.difficulty_index_override===3.5, 'normalizeMechStep: override coercion numerica'); }
{ const s=normalizeMechStep({exercise:'leg_extension', difficulty_index_override:''});
  ok(s.difficulty_index_override===null, 'normalizeMechStep: override vacio a null'); }
{ const b=newBlock(); b.method='drop'; b.variant='mechanical_drop'; b.intent_declared='hypertrophy'; applyDefaults(b);
  b.mechanical_progression=[{exercise:'leg_extension',variation_descriptor:'full',difficulty_index_override:4.0},
                            {exercise:'leg_extension',variation_descriptor:'partial',difficulty_index_override:3.0}];
  S.blocks=[b]; const ym=exportYAML();
  ok(/mechanical_progression:/.test(ym) && /exercise_ref: leg_extension/.test(ym), 'YAML: emite mechanical_progression con exercise_ref');
  ok(/difficulty_index_override: 4/.test(ym) && /variation_descriptor:/.test(ym), 'YAML: emite override + variation_descriptor'); }

console.log(`\nWORK_UNIT EDITOR: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
