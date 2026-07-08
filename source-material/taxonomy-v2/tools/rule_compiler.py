#!/usr/bin/env python3
"""
rule_compiler.py — compila rules/prescriptor_rules.yaml (FUENTE autorada) a:
  1. compiled/compiled_rules.yaml  (artefacto normalizado, derivado, NO editar)
  2. la cadena JS inyectable en el template (closures {id,sev,applies,test,msg,sugg})

Contrato: docs/P3_0_CONTRACT.md. El FLAG es autoridad de su ficha
(severity/level/applies_at/detail_schema/*_template se copian de flag_catalog).
Aquí se autora la LÓGICA (id/tier/scope/when/emits/fidelity).

Invariantes de integridad (BUILD ERROR, adelantados a compile-time):
  E1  regla sin `emits`                          → imposible por construcción
  E2  `emits` referencia flag inexistente
  E3  `emits` referencia flag con applies_at ∉ {block, session}
  TIER  construcción T4/T5 (array selector / fn:*) dentro de regla T1–T3

P3.1.1: el traductor de `when` cubre el subconjunto escalar de la regla piloto.
Crece en P3.1.3 (18 reglas T1) con `component_role(...)` y bindings computados.
"""
import hashlib
import json
import re
from pathlib import Path

try:
    import yaml
except ImportError:
    raise SystemExit("PyYAML requerido")

COMPILABLE_TIERS = {"T1", "T2", "T3", "T4"}  # P4.1: T4 entra (familia F3 EXISTS)
PRESCRIPTOR_SCOPES = {"block", "session"}
# severidad del motor (P3.1.2): vocabulario completo. viability ya NO se colapsa;
# el motor distingue hard / viability(+level) / informational y el sello refleja
# overall_coherent=false ⟺ hard OR viability.hard_fail.
_SEV_TO_ENGINE = {"structural_hard": "hard", "viability": "viability",
                  "informational": "informational"}

# Rutas/identificadores no-parámetro permitidos como `b.<x>` directos.
_DIRECT_PATHS = {"intent_declared", "method", "variant", "exercise", "family", "zone"}
# Tokens prohibidos en P3 (frontera de tier; el compilador rechaza con BUILD ERROR).
_FORBIDDEN_RE = re.compile(r"\[|fn:")


class BuildError(Exception):
    """Error de compilación que debe abortar el build (no silenciar)."""


# ---------------------------------------------------------------- when → JS
# Funciones puras whitelisteadas (T1: aritmética cerrada). component_role(...) y
# los helpers T2/T3 se añaden en sus familias respectivas.
_PURE_FN = {"floor": "Math.floor", "ceil": "Math.ceil", "abs": "Math.abs",
            "min": "Math.min", "max": "Math.max", "round": "Math.round"}

# Helpers de estimación T2/T3 (Grupo 7+ del spec). Funciones puras DEFINIDAS EN EL
# MOTOR (inyectadas una vez, reusables) cuyo NOMBRE el compilador whitelistea para
# `when`/`bindings`. A diferencia de _PURE_FN (mapeo 1:1 a Math.*), estas mapean a
# globales `__H.<name>` provistas por el bloque HELPERS_JS. Solo subconjunto
# escalar-puro en P3.2: estimate_*duration sobre components[] son T4 (no aquí).
_HELPER_FN = {
    # aggregate_volume(first, last, count) → volumen lineal: reps_promedio × count.
    # Heurística viability (no precisión de generador). Confirmada por usuario.
    "aggregate_volume": "__H.aggregate_volume",
    # --- P3.3 (T3) zona/viabilidad. Grupos 2-3 del spec. Todos ESCALAR-puros:
    # epley_inverse(load) → reps_max_teorico (tabla canónica + interpolación lineal).
    "epley_inverse": "__H.epley_inverse",
    # viability_level(reps_target, load) → entero {0:ok,1:warning_mild,2:warning_strong,
    #   3:hard_fail, -1:underloaded}. Umbrales del spec (sesión P3.3.0, "como están").
    "viability_level": "__H.viability_level",
    # zone_max_reps(load, reps, rir) → max reps de la zona clasificada por classify_zone;
    # null si no hay zona coherente (score < 0.70). rir puede venir asumido (RIR=2, opción B).
    "zone_max_reps": "__H.zone_max_reps",
    # zone_id(load, reps, rir) → string de zona 'Z1'..'Z6' o null (para el mensaje).
    "zone_id": "__H.zone_id",
    # P5.5c — zone_score(load, reps, rir) → max score (0..1, redondeado a 2 dec) del
    # mejor match de zona, INDEPENDIENTE del umbral 0.70. Para el binding {max_score}
    # de no_coherent_zone (que dispara cuando ese score < 0.70 → classify_zone null).
    "zone_score": "__H.zone_score",
    # --- P3.4 — drift de afinidad intent↔método. intent_off_method(intent, method,
    # variant) → bool: true si el intent declarado está FUERA del vocabulario
    # intrínseco del método/variante (tabla DATA.intent_affinity, embebida del
    # source). Escalar puro (pertenencia a un array embebido, sin iteración de
    # components[]). Reemplaza el lookup hardcoded INTENT_AFFINITY/COMPLEX_AFFINITY.
    "intent_off_method": "__H.intent_off_method",
}
# Definiciones JS inyectadas al motor (marcador __ESTIMATION_HELPERS__).
HELPER_DEFS_JS = (
    "const __H = {\n"
    "  // P3.2 — volumen lineal escalar: (first+last)/2 * count. Sin iteración de\n"
    "  // arrays. count<1 → 0. Devuelve número (puede ser fraccional; el caller\n"
    "  // compara contra umbral entero).\n"
    "  aggregate_volume: function(first, last, count){\n"
    "    if (first==null || last==null || count==null || count < 1) return 0;\n"
    "    return ((first + last) / 2) * count;\n"
    "  },\n"
    "  // P3.3 (T3) — Grupo 3: epley_inverse. Tabla canónica del spec (ancla\n"
    "  // inmutable, confirmada 'tal cual'); interpolación lineal entre entradas;\n"
    "  // clamp fuera de rango; redondeo a entero. load null → null.\n"
    "  _EPLEY: [[100,1],[95,2],[90,4],[85,6],[80,8],[75,10],[70,12],[65,15],\n"
    "           [60,18],[55,22],[50,30]],\n"
    "  epley_inverse: function(load){\n"
    "    if (load==null) return null;\n"
    "    var t=this._EPLEY;\n"
    "    if (load >= t[0][0]) return t[0][1];\n"
    "    if (load <= t[t.length-1][0]) return t[t.length-1][1];\n"
    "    for (var i=0;i<t.length-1;i++){\n"
    "      var hi=t[i], lo=t[i+1];\n"
    "      if (load <= hi[0] && load >= lo[0]){\n"
    "        var frac=(load - lo[0])/(hi[0]-lo[0]);\n"
    "        return Math.round(lo[1] + frac*(hi[1]-lo[1]));\n"
    "      }\n"
    "    }\n"
    "    return null;\n"
    "  },\n"
    "  // P3.3 (T3) — Grupo 3: compute_viability colapsado a un CÓDIGO escalar de\n"
    "  // nivel (la regla decide qué flag emite según el código). Umbrales del spec:\n"
    "  //   delta = reps_target - reps_max_teorico\n"
    "  //   delta in [-4,0] → 0 ok ; delta < -4 → -1 underloaded\n"
    "  //   0<delta_pct<=15 → 1 warning_mild ; 15<..<=30 → 2 warning_strong ; >30 → 3 hard_fail\n"
    "  viability_level: function(reps_target, load){\n"
    "    if (reps_target==null || load==null) return null;\n"
    "    var rmax=this.epley_inverse(load);\n"
    "    if (rmax==null || rmax<=0) return null;\n"
    "    var delta=reps_target - rmax;\n"
    "    if (delta <= 0) return (delta >= -4) ? 0 : -1;\n"
    "    var dpct=(delta/rmax)*100;\n"
    "    if (dpct <= 15) return 1;\n"
    "    if (dpct <= 30) return 2;\n"
    "    return 3;\n"
    "  },\n"
    "  // P3.3 (T3) — Grupo 2: match_range con decaimiento lineal (span min 2).\n"
    "  _match: function(v, r){\n"
    "    if (v==null || r==null) return 0;\n"
    "    if (v >= r.min && v <= r.max) return 1;\n"
    "    var d = (v < r.min) ? (r.min - v) : (v - r.max);\n"
    "    var span = Math.max(r.max - r.min, 2);\n"
    "    return Math.max(0, 1 - d/span);\n"
    "  },\n"
    "  // P3.3 (T3) — Grupo 2: classify_zone. Score 0.5*reps+0.3*load+0.2*rir sobre\n"
    "  // DATA.zones; umbral 0.70; tie-breaker por índice menor (sesgo conservador).\n"
    "  // Devuelve {zone, max_reps} o null (sin zona coherente). rir puede ser asumido.\n"
    "  classify_zone: function(reps, load, rir){\n"
    "    var Z=(typeof DATA!=='undefined' && DATA.zones) ? DATA.zones : null;\n"
    "    if (!Z || reps==null || load==null) return null;\n"
    "    var best=null, bestScore=-1, ids=Object.keys(Z);\n"
    "    for (var i=0;i<ids.length;i++){\n"
    "      var z=Z[ids[i]];\n"
    "      var s=0.5*this._match(reps,z.reps)+0.3*this._match(load,z.load_pct_1rm)\n"
    "            +0.2*this._match(rir,z.rir);\n"
    "      if (s > bestScore + 1e-9){ bestScore=s; best=ids[i]; }\n"
    "    }\n"
    "    if (bestScore < 0.70) return null;\n"
    "    return { zone: best, max_reps: Z[best].reps.max };\n"
    "  },\n"
    "  // Accesor escalar para cluster_size_exceeds_zone_reps: max reps de la zona\n"
    "  // clasificada (null si no coherente). rir asumido por el caller (opción B).\n"
    "  zone_max_reps: function(load, reps, rir){\n"
    "    var r=this.classify_zone(reps, load, rir);\n"
    "    return r ? r.max_reps : null;\n"
    "  },\n"
    "  // Accesor escalar del id de zona (string 'Z1'..'Z6') o null. Para el mensaje.\n"
    "  zone_id: function(load, reps, rir){\n"
    "    var r=this.classify_zone(reps, load, rir);\n"
    "    return r ? r.zone : null;\n"
    "  },\n"
    "  // P5.5c — max score del mejor match de zona (sin aplicar el umbral). Para el\n"
    "  // binding {max_score} de no_coherent_zone. null si faltan reps/load/DATA.zones.\n"
    "  zone_score: function(load, reps, rir){\n"
    "    var Z=(typeof DATA!=='undefined' && DATA.zones) ? DATA.zones : null;\n"
    "    if (!Z || reps==null || load==null) return null;\n"
    "    var bestScore=-1, ids=Object.keys(Z);\n"
    "    for (var i=0;i<ids.length;i++){\n"
    "      var z=Z[ids[i]];\n"
    "      var s=0.5*this._match(reps,z.reps)+0.3*this._match(load,z.load_pct_1rm)\n"
    "            +0.2*this._match(rir,z.rir);\n"
    "      if (s>bestScore) bestScore=s;\n"
    "    }\n"
    "    return Math.round(bestScore*100)/100;\n"
    "  },\n"
    "  // P3.4 — afinidad intent↔método. Lee DATA.intent_affinity (embebido del\n"
    "  // source): { method: [intents...] } y { complex_variant: [intents...] } bajo\n"
    "  // la clave 'complex'. Para method 'complex' resuelve por variant; para el\n"
    "  // resto por method. true = el intent está FUERA del vocabulario (drift).\n"
    "  // Sin entrada en la tabla → false (método universal, p.ej. straight).\n"
    "  intent_off_method: function(intent, method, variant){\n"
    "    if (intent==null || method==null) return false;\n"
    "    var A=(typeof DATA!=='undefined' && DATA.intent_affinity) ? DATA.intent_affinity : null;\n"
    "    if (!A) return false;\n"
    "    var aff = (method==='complex') ? (A.complex||{})[variant] : A[method];\n"
    "    if (!aff) return false;\n"
    "    return aff.indexOf(intent) === -1;\n"
    "  },\n"
    "  // P4.3 — F6 REDUCE/AGG (primer helper-sobre-array). Tiempo de trabajo\n"
    "  // estimado de una lista de work_units (EMOM work_per_interval). Modelo del\n"
    "  // hardcode extendido a forma canónica: reps → tpr(ejercicio)*reps (tpr\n"
    "  // default 3, fiel al ||3 del hardcode); duration_sec → segundos directos.\n"
    "  // distance_m NO contribuye (catálogo sin modelo de paso) — MARCA P4.3.\n"
    "  // work_value nulo/<=0 se ignora. Devuelve segundos (float; el caller redondea).\n"
    "  estimate_work_duration: function(wus){\n"
    "    if (!Array.isArray(wus)) return 0;\n"
    "    var total=0;\n"
    "    for (var i=0;i<wus.length;i++){\n"
    "      var c=wus[i]||{}; var val=Number(c.work_value);\n"
    "      if (!isFinite(val) || val<=0) continue;\n"
    "      if (c.work_metric==='duration_sec'){ total += val; }\n"
    "      else if (c.work_metric==='reps'){\n"
    "        var t=(typeof DATA!=='undefined' && DATA.exercises)\n"
    "              ? ((DATA.exercises[c.exercise]||{}).tpr) : null;\n"
    "        total += (t||3)*val;\n"
    "      }\n"
    "      // distance_m: sin modelo de paso → no contribuye (MARCA)\n"
    "    }\n"
    "    return total;\n"
    "  },\n"
    "  // P4.4 — F6 estimación de duración (spec Grupo 7). Block-helper: recibe el\n"
    "  // bloque y estima segundos totales. chipper = una pasada (sum + ~5s\n"
    "  // transición por componente + 20% fatiga si >600s). Round-based (con\n"
    "  // total_rounds) = (trabajo_por_ronda + rest_entre_componentes*(n-1)) *\n"
    "  // rondas + rest_inter_ronda*(rondas-1). Heurístico. tcc no usa esto (su\n"
    "  // duración ES el time_cap; su métrica derivada es estimate_rounds).\n"
    "  estimate_total_duration: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    var work=this.estimate_work_duration(comps);\n"
    "    var n=comps.length;\n"
    "    var p=(b&&b.params)||{};\n"
    "    var restBetween=Number(p.rest_between_components_sec)||0;\n"
    "    if (b && b.variant==='chipper'){\n"
    "      var tc=work + 5*Math.max(n-1,0);\n"
    "      if (work>600) tc*=1.2;\n"
    "      return tc;\n"
    "    }\n"
    "    var rounds=Number(p.total_rounds)||1;\n"
    "    var restRound=Number(p.rest_inter_round_sec)||0;\n"
    "    var roundSec=work + restBetween*Math.max(n-1,0);\n"
    "    return roundSec*rounds + restRound*Math.max(rounds-1,0);\n"
    "  },\n"
    "  // P4.4 — rondas estimadas dentro del time_cap (time_capped_circuit):\n"
    "  // floor(time_cap_sec / duración_de_una_ronda). null si no hay trabajo o cap.\n"
    "  estimate_rounds: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    var work=this.estimate_work_duration(comps);\n"
    "    var n=comps.length;\n"
    "    var p=(b&&b.params)||{};\n"
    "    var restBetween=Number(p.rest_between_components_sec)||0;\n"
    "    var roundSec=work + restBetween*Math.max(n-1,0);\n"
    "    if (roundSec<=0) return null;\n"
    "    var capSec=Number(p.time_cap_min)*60;\n"
    "    if (!isFinite(capSec)||capSec<=0) return null;\n"
    "    return Math.floor(capSec/roundSec);\n"
    "  },\n"
    "  // P5.1 — F6 monotonía: recibe un array de valores (ya mapeados desde el\n"
    "  // campo por el preprocesador) y verifica progresión monótona NO ESTRICTA\n"
    "  // (permite escalón plano: un set repetido no viola monotonía). Nulos/NaN se\n"
    "  // descartan ANTES de comparar (un set sin carga declarada no rompe la rampa;\n"
    "  // su ausencia la cubre otro flag). dir ∈ {'inc','dec'}. <2 valores → true\n"
    "  // (vacuo: nada que ordenar). Es predicado puro y determinista — exactamente\n"
    "  // lo que el motor declarativo debe poseer (el contrato lo reservaba a fn:\n"
    "  // solo porque el array no estaba capturado, no por necesidad de código).\n"
    "  is_monotonic: function(vals, dir){\n"
    "    if (!Array.isArray(vals)) return true;\n"
    "    var v=vals.map(function(x){return Number(x);})\n"
    "              .filter(function(x){return isFinite(x);});\n"
    "    for (var k=1;k<v.length;k++){\n"
    "      if (dir==='inc' && !(v[k-1] <= v[k])) return false;\n"
    "      if (dir==='dec' && !(v[k-1] >= v[k])) return false;\n"
    "    }\n"
    "    return true;\n"
    "  },\n"
    "  // P5.1 — índice 1-based del PRIMER elemento que rompe la monotonía (0 si es\n"
    "  // monótona). Para el binding {component_index}/{set}/{round} del mensaje. Opera\n"
    "  // sobre los valores ya mapeados; descarta nulos como is_monotonic (índice\n"
    "  // relativo a la secuencia no-nula, coherente con el predicado de disparo).\n"
    "  monotonic_break: function(vals, dir){\n"
    "    if (!Array.isArray(vals)) return 0;\n"
    "    var v=vals.map(function(x){return Number(x);})\n"
    "              .filter(function(x){return isFinite(x);});\n"
    "    for (var k=1;k<v.length;k++){\n"
    "      if (dir==='inc' && !(v[k-1] <= v[k])) return k+1;\n"
    "      if (dir==='dec' && !(v[k-1] >= v[k])) return k+1;\n"
    "    }\n"
    "    return 0;\n"
    "  },\n"
    "  // ---- P5.3 — AGS (antagonist_giant_set): chequeos de PAREO (group-by por\n"
    "  // pair_index). Block-helpers porque comparan items entre sí / contra un param\n"
    "  // del bloque (pairs_count), fuera del alcance de un <pred> de item.\n"
    "  _cat: function(c){ return (typeof DATA!=='undefined' && DATA.exercises)\n"
    "        ? (DATA.exercises[c && c.exercise]||{}) : {}; },\n"
    "  // pair_index inválido: 1-based index del PRIMER componente cuyo pair_index es\n"
    "  // nulo, no-entero, <0 o >=pairs_count. 0 si todos válidos.\n"
    "  ags_first_bad_pair_index: function(b){\n"
    "    var comps=(b&&b.components)||[]; var pc=Number((b&&b.params||{}).pairs_count);\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var pi=comps[i]&&comps[i].pair_index; var n=Number(pi);\n"
    "      if (pi==null || pi==='' || !isFinite(n) || n<0 || (isFinite(pc) && n>=pc)) return i+1;\n"
    "    }\n"
    "    return 0;\n"
    "  },\n"
    "  // valor del pair_index ofensor (binding {actual_value}).\n"
    "  ags_bad_pair_index_value: function(b){\n"
    "    var idx=this.ags_first_bad_pair_index(b);\n"
    "    if (!idx) return null;\n"
    "    var c=(b&&b.components||[])[idx-1]; return c?c.pair_index:null;\n"
    "  },\n"
    "  // balance de pareo: todo pair_index declarado debe aparecer EXACTAMENTE 2\n"
    "  // veces. true = DESBALANCEADO. Ignora componentes sin pair_index (los cubre\n"
    "  // ags_pair_index_invalid). Sin grupos → ok.\n"
    "  ags_pairs_unbalanced: function(b){\n"
    "    var comps=(b&&b.components)||[]; var counts={};\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var pi=comps[i]&&comps[i].pair_index;\n"
    "      if (pi==null||pi==='') continue;\n"
    "      counts[pi]=(counts[pi]||0)+1;\n"
    "    }\n"
    "    var keys=Object.keys(counts);\n"
    "    if (!keys.length) return false;\n"
    "    for (var k=0;k<keys.length;k++){ if (counts[keys[k]]!==2) return true; }\n"
    "    return false;\n"
    "  },\n"
    "  // primer par (1-based por pair_index+1) cuyos DOS componentes comparten\n"
    "  // movement_pattern (catálogo) → antagonismo dudoso. 0 si todos distintos.\n"
    "  ags_first_shared_pattern_pair: function(b){\n"
    "    var comps=(b&&b.components)||[]; var groups={};\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var pi=comps[i]&&comps[i].pair_index;\n"
    "      if (pi==null||pi==='') continue;\n"
    "      (groups[pi]=groups[pi]||[]).push(comps[i]);\n"
    "    }\n"
    "    var keys=Object.keys(groups).sort(function(a,c){return a-c;});\n"
    "    for (var k=0;k<keys.length;k++){\n"
    "      var g=groups[keys[k]];\n"
    "      if (g.length!==2) continue;\n"
    "      var p0=this._cat(g[0]).pattern, p1=this._cat(g[1]).pattern;\n"
    "      if (p0!=null && p1!=null && p0===p1) return Number(keys[k])+1;\n"
    "    }\n"
    "    return 0;\n"
    "  },\n"
    "  // ---- P5.5b — PHA (peripheral_heart_action): alternancia de segmentos.\n"
    "  // Proxy declarativo de fn:check_pha_strict_alternation (Group 10, v3). El\n"
    "  // segmento por componente es catálogo-derivado (cat_segment; decisión P5.5b\n"
    "  // nº1, fidelity partial — el spec lo querría declarado por componente, no\n"
    "  // capturado por el editor v0.2.0). 3 ramas de alternation_pattern:\n"
    "  //   strict_upper_lower (default): todos upper|lower, alternando.\n"
    "  //   push_pull_lower: ciclo [push,pull,lower] por posición. push={push_h,push_v},\n"
    "  //     pull={pull_h,pull_v,olympic_pull}, lower=cat_segment==='lower'\n"
    "  //     (interpretación documentada; el fn: del spec queda sin definir).\n"
    "  //   custom: EXENTO (return 0) — coherente con la drift rule ilc_pha_resembles_circuit.\n"
    "  // Si algún cat_segment es null → 0 (lo cubre pha_body_segments_undeclared; no se\n"
    "  // evalúa alternancia con huecos). Los 4 públicos comparten _pha_scan.\n"
    "  _pha_role_ppl: function(c){\n"
    "    var seg=this._cat(c).segment, pat=this._cat(c).pattern;\n"
    "    if (seg==='lower') return 'lower';\n"
    "    if (pat==='push_h'||pat==='push_v') return 'push';\n"
    "    if (pat==='pull_h'||pat==='pull_v'||pat==='olympic_pull') return 'pull';\n"
    "    return 'other';\n"
    "  },\n"
    "  _pha_name: function(c){ return this._cat(c).name||(c&&c.exercise)||null; },\n"
    "  _pha_scan: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    var ap=(b&&b.params||{}).alternation_pattern;\n"
    "    if (ap==='custom') return {index:0};\n"
    "    if (comps.length<2) return {index:0};\n"
    "    for (var j=0;j<comps.length;j++){ if (this._cat(comps[j]).segment==null) return {index:0}; }\n"
    "    if (ap==='push_pull_lower'){\n"
    "      var cycle=['push','pull','lower'];\n"
    "      for (var i=0;i<comps.length;i++){\n"
    "        var exp=cycle[i%3], act=this._pha_role_ppl(comps[i]);\n"
    "        if (act!==exp) return {index:i+1, actual:act, expected:exp, name:this._pha_name(comps[i])};\n"
    "      }\n"
    "      return {index:0};\n"
    "    }\n"
    "    var prev=null;\n"
    "    for (var i2=0;i2<comps.length;i2++){\n"
    "      var s=this._cat(comps[i2]).segment;\n"
    "      if (s!=='upper' && s!=='lower')\n"
    "        return {index:i2+1, actual:s, expected:'upper|lower', name:this._pha_name(comps[i2])};\n"
    "      if (prev!=null && s===prev)\n"
    "        return {index:i2+1, actual:s, expected:(prev==='upper'?'lower':'upper'), name:this._pha_name(comps[i2])};\n"
    "      prev=s;\n"
    "    }\n"
    "    return {index:0};\n"
    "  },\n"
    "  pha_first_alternation_break: function(b){ return this._pha_scan(b).index; },\n"
    "  pha_break_actual: function(b){ var r=this._pha_scan(b); return r.index?r.actual:null; },\n"
    "  pha_break_expected: function(b){ var r=this._pha_scan(b); return r.index?r.expected:null; },\n"
    "  pha_break_name: function(b){ var r=this._pha_scan(b); return r.index?r.name:null; },\n"
    "  // P5.5c — zone_spread: nº de zonas INFERIDAS distintas entre componentes\n"
    "  // (classify_zone por componente; reps de work_metric, load de load_pct_1rm,\n"
    "  // rir=2 asumido). Para complex_zone_spread_excessive (demanda heterogénea).\n"
    "  zone_spread: function(b){\n"
    "    var comps=(b&&b.components)||[]; var seen={}, n=0;\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var c=comps[i]||{};\n"
    "      var reps=(c.work_metric==='reps')?c.work_value:(c.reps!=null?c.reps:null);\n"
    "      var load=(c.load_metric==='percent_1rm')?c.load_pct_1rm:null;\n"
    "      var rir=(c.rir!=null)?c.rir:2;\n"
    "      var z=this.zone_id(load, reps, rir);\n"
    "      if (z!=null && !seen[z]){ seen[z]=1; n++; }\n"
    "    }\n"
    "    return n;\n"
    "  },\n"
    "  // P5.6 — french_contrast: roles en orden canónico exacto. 1-based index del\n"
    "  // primer rol fuera de secuencia [heavy_strength, heavy_plyo, loaded_explosive,\n"
    "  // unloaded_plyo]; 0 si correcto o si !=4 componentes (el conteo lo cubre\n"
    "  // french_contrast_components_count_wrong, sin doble-disparo).\n"
    "  fc_roles_wrong: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    var canon=['heavy_strength','heavy_plyo','loaded_explosive','unloaded_plyo'];\n"
    "    if (comps.length!==4) return 0;\n"
    "    for (var i=0;i<4;i++){ if ((comps[i]||{}).role!==canon[i]) return i+1; }\n"
    "    return 0;\n"
    "  },\n"
    "  // P5.7 — SLC: TCI del primer componente y promedio de TCI del resto (catálogo).\n"
    "  // slc_component_order_technically_unsafe dispara si el primero es >=2 más simple\n"
    "  // que el promedio del resto (margen para no marcar progresiones leves; partial).\n"
    "  slc_first_tci: function(b){\n"
    "    var comps=(b&&b.components)||[]; if (!comps.length) return null;\n"
    "    var t=this._cat(comps[0]).tci; return (t==null)?null:Number(t);\n"
    "  },\n"
    "  slc_avg_rest_tci: function(b){\n"
    "    var comps=(b&&b.components)||[]; var s=0,n=0;\n"
    "    for (var i=1;i<comps.length;i++){ var t=this._cat(comps[i]).tci; if (t!=null){ s+=Number(t); n++; } }\n"
    "    return n? Math.round((s/n)*100)/100 : null;\n"
    "  },\n"
    "  // V3.6.2 — superset (mismo patrón, 2 ejercicios alternados) que en realidad\n"
    "  // se prescribe como un PAR DE CONTRASTE: mismo movement_pattern (catálogo),\n"
    "  // cargas heavy+light (una >=80%, otra <=60%) y descanso en ventana PAP (>=90s).\n"
    "  // Umbral duro (detección de patrón casi-booleana, como el resto del validador).\n"
    "  // Requiere EXACTAMENTE 2 componentes con %1RM legible y mismo patrón. true=parece\n"
    "  // contraste. Carga del componente = load_pct_1rm si load_metric==='percent_1rm'.\n"
    "  superset_resembles_contrast: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    if (comps.length!==2) return false;\n"
    "    var p0=this._cat(comps[0]).pattern, p1=this._cat(comps[1]).pattern;\n"
    "    if (p0==null || p1==null || p0!==p1) return false;\n"
    "    function ld(c){ return (c&&c.load_metric==='percent_1rm' && c.load_pct_1rm!=null)\n"
    "                           ? Number(c.load_pct_1rm) : null; }\n"
    "    var l0=ld(comps[0]), l1=ld(comps[1]);\n"
    "    if (l0==null || l1==null) return false;\n"
    "    var hi=Math.max(l0,l1), lo=Math.min(l0,l1);\n"
    "    if (!(hi>=80 && lo<=60)) return false;\n"
    "    var rest=Number((b&&b.params||{}).rest_between_components_sec);\n"
    "    return isFinite(rest) && rest>=90;\n"
    "  },\n"
    "  // V3.6.3 — bloque complex (NO french_contrast) cuyos 4 componentes llevan los\n"
    "  // 4 roles canónicos de french_contrast [heavy_strength, heavy_plyo,\n"
    "  // loaded_explosive, unloaded_plyo] (en cualquier orden) → french_contrast mal\n"
    "  // etiquetado. Umbral duro: exactamente 4 comps Y los 4 roles presentes como\n"
    "  // conjunto. La variante french_contrast real se EXCLUYE por scope.\n"
    "  resembles_french_contrast: function(b){\n"
    "    var comps=(b&&b.components)||[];\n"
    "    if (comps.length!==4) return false;\n"
    "    var canon=['heavy_strength','heavy_plyo','loaded_explosive','unloaded_plyo'];\n"
    "    var roles={};\n"
    "    for (var i=0;i<4;i++){ var r=(comps[i]||{}).role; if(r!=null) roles[r]=1; }\n"
    "    for (var j=0;j<canon.length;j++){ if(!roles[canon[j]]) return false; }\n"
    "    return true;\n"
    "  },\n"
    "  // P6.1 — family canónica de la variante (DATA.methods[m].variants[v].family).\n"
    "  // Para complex_family_mismatch_with_variant: el editor la auto-fija read-only,\n"
    "  // pero el validador compara contra cualquier family declarada (bloques de v3/import).\n"
    "  variant_family: function(b){\n"
    "    var M=(typeof DATA!=='undefined'&&DATA.methods)?DATA.methods:null;\n"
    "    if(!M||!b)return null;\n"
    "    var m=M[b.method]; if(!m||!m.variants)return null;\n"
    "    var v=m.variants[b.variant]; return (v&&v.family!=null)?v.family:null;\n"
    "  },\n"
    "  // V3.6.4 — CLASIFICADOR DIFUSO de familia (complex). A diferencia de los 3\n"
    "  // resembles_* (umbral duro), este es un ARGMAX sobre las 3 familias del método\n"
    "  // complex porque su mensaje EXIGE nombrar la familia ganadora — no es expresable\n"
    "  // como booleano. Reusa la mecánica de score ponderado de classify_zone (P3.3):\n"
    "  // cada señal estructural suma a la familia que la firma. Firmas:\n"
    "  //   single_load_chain   = carga compartida + comps SIN carga propia + implemento homogéneo\n"
    "  //   independent_load_chain = comps con %1RM propios + sin carga compartida\n"
    "  //   circuit             = params de tiempo/rondas + sin carga compartida\n"
    "  // Devuelve {family, score, runnerScore} o null si no hay señal. score∈[0,1]\n"
    "  // (fracción de peso capturado por la ganadora). MARCA-FIS: pesos recalibrables.\n"
    "  _familyScores: function(b){\n"
    "    var comps=(b&&b.components)||[]; var p=(b&&b.params)||{};\n"
    "    if (!comps.length) return null;\n"
    "    var s={single_load_chain:0, independent_load_chain:0, circuit:0};\n"
    "    var W=0;\n"
    "    // (1) carga compartida declarada → SLC (peso 2).\n"
    "    var shared = (p.shared_load_pct_1rm_of_weakest!=null);\n"
    "    if (shared){ s.single_load_chain+=2; W+=2; }\n"
    "    // (2) fracción de comps con %1RM propio → ILC. La señal SLC de \"componentes\n"
    "    // sin carga propia\" SOLO cuenta si hay carga compartida a nivel bloque (la\n"
    "    // firma real de single_load_chain: load_metric:none PORQUE la carga vive en\n"
    "    // shared_load_*). Sin carga compartida, none/bodyweight es trabajo descargado\n"
    "    // normal (ILC accesorio/giant) → NEUTRAL, no evidencia de cadena.\n"
    "    var own=0, nload=0;\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var lm=(comps[i]||{}).load_metric;\n"
    "      if (lm==='percent_1rm' && comps[i].load_pct_1rm!=null){ own++; }\n"
    "      if (lm==='percent_1rm' || lm==='none' || lm==='bodyweight'){ nload++; }\n"
    "    }\n"
    "    if (nload>0){\n"
    "      s.independent_load_chain += 2*(own/nload);\n"
    "      if (shared) s.single_load_chain += 2*((nload-own)/nload);\n"
    "      W+=2;\n"
    "    }\n"
    "    // (3) implemento homogéneo entre comps → confirma SLC, pero SOLO si ya hay\n"
    "    // señal de carga compartida (peso 1). Implemento homogéneo POR SÍ SOLO no es\n"
    "    // evidencia de cadena: dos accesorios de máquina (ILC) comparten implemento sin\n"
    "    // ser un single_load_chain. La firma decisiva de SLC es la CARGA compartida.\n"
    "    if (shared){\n"
    "      var imps={}, nimp=0;\n"
    "      for (var k=0;k<comps.length;k++){ var im=this._cat(comps[k]).implement; if(im!=null){ imps[im]=1; nimp++; } }\n"
    "      if (nimp>=2){ if (Object.keys(imps).length===1) s.single_load_chain+=1; W+=1; }\n"
    "    }\n"
    "    // (4) params de TIEMPO (no total_rounds: los giant_set ILC también lo usan)\n"
    "    // → circuit (peso 2). El discriminante real de circuit es el cap de tiempo /\n"
    "    // duración objetivo, no el conteo de rondas.\n"
    "    var circuitish = (p.time_cap_min!=null)\n"
    "                  || (p.target_total_duration_min!=null);\n"
    "    if (circuitish && !shared){ s.circuit+=2; W+=2; }\n"
    "    if (W<=0) return null;\n"
    "    var best=null, bestV=-1, second=-1;\n"
    "    for (var f in s){\n"
    "      if (s[f]>bestV+1e-9){ second=bestV; bestV=s[f]; best=f; }\n"
    "      else if (s[f]>second+1e-9){ second=s[f]; }\n"
    "    }\n"
    "    return { family: best, score: bestV/W, runnerScore: (second<0?0:second/W), raw: s, total: W };\n"
    "  },\n"
    "  // Familia que el bloque MÁS parece (argmax) si el score supera el umbral 0.60\n"
    "  // (mayoría del peso) y la ganadora supera al runner-up por margen (0.20) — sin\n"
    "  // margen, dos familias empatadas no justifican reclasificar. null si no concluyente.\n"
    "  family_resembles: function(b){\n"
    "    var r=this._familyScores(b);\n"
    "    if (!r) return null;\n"
    "    if (r.score < 0.60) return null;\n"
    "    if (r.score - r.runnerScore < 0.20) return null;\n"
    "    return r.family;\n"
    "  },\n"
    "  // true si la familia inferida (argmax concluyente) DIFIERE de la declarada.\n"
    "  // Sin family declarada o sin inferencia concluyente → false (nada que contradecir).\n"
    "  family_misclassified: function(b){\n"
    "    var decl=(b&&b.family!=null)?b.family:this.variant_family(b);\n"
    "    var inf=this.family_resembles(b);\n"
    "    return (inf!=null && decl!=null && inf!==decl);\n"
    "  },\n"
    "  // Accesor del binding {suggested_family} (la inferida) — null si no aplica.\n"
    "  family_suggested: function(b){ return this.family_misclassified(b) ? this.family_resembles(b) : null; },\n"
    "  // Accesor del binding {current_family} (la declarada o canónica de la variante).\n"
    "  family_current: function(b){ return (b&&b.family!=null)?b.family:this.variant_family(b); },\n"
    "  // P6.3 — multi_exercise_pyramid: ejercicios por ronda consistentes. round_exercises\n"
    "  // = [[ids ronda1],[ids ronda2],...] (lo pueblan v3/import; el editor usa lista\n"
    "  // compartida bajo el modelo-invariante → vacío → consistente). true si 2+ rondas\n"
    "  // y los CONJUNTOS de ejercicios difieren entre rondas.\n"
    "  mep_rounds_inconsistent: function(b){\n"
    "    var R=(b&&b.round_exercises)||[];\n"
    "    if(R.length<2)return false;\n"
    "    function key(a){ return ((a||[]).slice().sort()).join('|'); }\n"
    "    var k0=key(R[0]);\n"
    "    for(var i=1;i<R.length;i++){ if(key(R[i])!==k0)return true; }\n"
    "    return false;\n"
    "  },\n"
    "  // ---- P7.2 — MOTOR DE FUERZA RELATIVA (engine fn:, no declarativo).\n"
    "  // _rel1rm(ex): multiplicador del 1RM de ex relativo a global_hub, por BFS sobre\n"
    "  // el grafo de fuerza. rel(node)=factor*rel(reference). Aristas: strength_ratio_vs\n"
    "  // (node->reference, factor=expected_ratio, NO-hub) e inter_hub_ratios (A<->B,\n"
    "  // factor r / 1/r, HUB). Devuelve {mult,conf,jumps}: conf=min nivel de arista\n"
    "  // (high/canonical=2, medium=1, low=0); jumps=nº de aristas inter-hub; 2+ saltos\n"
    "  // fuerzan low (calibración Martin #2, sesión 15). null si no hay ruta a goal.\n"
    "  _STR_CONF: {canonical:2, high:2, medium:1, low:0},\n"
    "  _str_adj: null,\n"
    "  _str_build: function(){\n"
    "    if (this._str_adj) return this._str_adj;\n"
    "    var D=(typeof DATA!=='undefined')?DATA:null; var adj={};\n"
    "    function add(f,t,fac,conf,hub){ (adj[f]=adj[f]||[]).push({to:t,fac:fac,conf:conf,hub:hub}); }\n"
    "    if (D && D.exercises){\n"
    "      for (var e in D.exercises){\n"
    "        var srv=(D.exercises[e]||{}).strength_ratio_vs||[];\n"
    "        for (var i=0;i<srv.length;i++){ add(e, srv[i].reference, Number(srv[i].expected_ratio), srv[i].confidence, false); }\n"
    "      }\n"
    "    }\n"
    "    if (D && D.inter_hub_ratios){\n"
    "      for (var k=0;k<D.inter_hub_ratios.length;k++){\n"
    "        var ih=D.inter_hub_ratios[k]; var a=ih.pair[0], bb=ih.pair[1], r=Number(ih.ratio);\n"
    "        add(a, bb, r, ih.confidence, true); add(bb, a, 1/r, ih.confidence, true);\n"
    "      }\n"
    "    }\n"
    "    this._str_adj=adj; return adj;\n"
    "  },\n"
    "  _rel1rm: function(ex){\n"
    "    var D=(typeof DATA!=='undefined')?DATA:null;\n"
    "    if (!D || !D.strength_hubs) return null;\n"
    "    var goal=D.strength_hubs.global_hub;\n"
    "    if (ex==null) return null;\n"
    "    if (ex===goal) return {mult:1, conf:2, jumps:0};\n"
    "    var adj=this._str_build();\n"
    "    var q=[{node:ex, mult:1, conf:2, jumps:0}], seen={}; seen[ex]=1;\n"
    "    while (q.length){\n"
    "      var cur=q.shift(); var es=adj[cur.node]||[];\n"
    "      for (var i=0;i<es.length;i++){\n"
    "        var ed=es[i]; if (seen[ed.to]) continue; seen[ed.to]=1;\n"
    "        var lvl=this._STR_CONF[ed.conf]; if (lvl==null) lvl=0;\n"
    "        var nx={node:ed.to, mult:cur.mult*ed.fac, conf:Math.min(cur.conf,lvl), jumps:cur.jumps+(ed.hub?1:0)};\n"
    "        if (ed.to===goal){ var cf=(nx.jumps>=2)?0:nx.conf; return {mult:nx.mult, conf:cf, jumps:nx.jumps}; }\n"
    "        q.push(nx);\n"
    "      }\n"
    "    }\n"
    "    return null;\n"
    "  },\n"
    "  // _weakest(b): eslabón más débil = componente con MENOR 1RM relativo (una carga\n"
    "  // absoluta compartida es el mayor % de su 1RM). {ref, conf, jumps}: ref=exercise\n"
    "  // del más débil; conf=peor confianza de identificación (min sobre componentes);\n"
    "  // jumps=max saltos inter-hub. null si <2 componentes ubicables en el grafo.\n"
    "  _weakest: function(b){\n"
    "    var comps=(b&&b.components)||[]; var best=null, bestMult=Infinity, minConf=2, maxJ=0, ok=0;\n"
    "    for (var i=0;i<comps.length;i++){\n"
    "      var ex=comps[i]&&comps[i].exercise; var r=this._rel1rm(ex);\n"
    "      if (!r) continue; ok++;\n"
    "      minConf=Math.min(minConf, r.conf); maxJ=Math.max(maxJ, r.jumps);\n"
    "      if (r.mult < bestMult){ bestMult=r.mult; best=ex; }\n"
    "    }\n"
    "    if (ok<2) return null;\n"
    "    return {ref:best, conf:minConf, jumps:maxJ};\n"
    "  },\n"
    "  // Públicos para bindings/condiciones de los 3 flags T5 (P7.4). _has_anchor:\n"
    "  // ancla declarada (laxo: null/undefined/'' = no declarada). Los flags se gatean\n"
    "  // aquí dentro (no en el when) porque el compilador emite !== null estricto y el\n"
    "  // fixture default no trae el campo (undefined). Patrón: igual que misidentified.\n"
    "  _has_anchor: function(b){ var d=(b&&b.params||{}).weakest_link_ref; return d!=null && d!==''; },\n"
    "  slc_weakest_computed: function(b){ var w=this._weakest(b); return w?w.ref:null; },\n"
    "  slc_weakest_conf_low: function(b){ if(!this._has_anchor(b)) return false; var w=this._weakest(b); return w?(w.conf===0):false; },\n"
    "  slc_ratio_max_jumps: function(b){ if(!this._has_anchor(b)) return 0; var w=this._weakest(b); return w?w.jumps:0; },\n"
    "  slc_weakest_misidentified: function(b){\n"
    "    if (!this._has_anchor(b)) return false;\n"
    "    var w=this._weakest(b); if (!w || w.conf===0) return false;\n"
    "    return (b.params.weakest_link_ref)!==w.ref;\n"
    "  }\n"
    "};"
)

# Accesores read-only al schema del bloque (rango declarado de un param en su variante).
# canonical_max(total_rounds) → DATA.methods[..].variants[..].params_schema.total_rounds.range_canonical.max
_SCHEMA_FN = {"canonical_max": ("range_canonical", "max"), "canonical_min": ("range_canonical", "min"),
              "extended_max": ("range_extended", "max"), "extended_min": ("range_extended", "min")}
_SCHEMA_CALL_RE = re.compile(
    r"\b(canonical_max|canonical_min|extended_max|extended_min)\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)")
_COMPONENT_ROLE_RE = re.compile(
    r"component_role\(\s*['\"]([a-z_]+)['\"]\s*\)\.([a-zA-Z_][a-zA-Z0-9_]*)")
# P3.4 — accesor escalar de catálogo del ejercicio del bloque: exercise_tpr,
# exercise_mdi, exercise_implement. Análogo a component_role (lectura de UN
# escalar ya embebido en DATA.exercises: tpr/mdi/implement), NO iteración.
_EXERCISE_FIELD = {"exercise_tpr": "tpr", "exercise_mdi": "mdi",
                   "exercise_implement": "implement"}
_EXERCISE_ACCESS_RE = re.compile(r"\b(exercise_tpr|exercise_mdi|exercise_implement)\b")


def _schema_path(param: str, range_key: str, bound: str) -> str:
    s = "DATA.methods[b.method]"
    s = f"({s}||{{}}).variants"
    s = f"({s}||{{}})[b.variant]"
    s = f"({s}||{{}}).params_schema"
    s = f"({s}||{{}})[{json.dumps(param)}]"
    s = f"({s}||{{}}).{range_key}"
    s = f"({s}||{{}}).{bound}"
    return f"({s})"


def _preprocess_schema_calls(clause: str) -> str:
    def sub(m):
        rk, bound = _SCHEMA_FN[m.group(1)]
        return "⟦" + _schema_path(m.group(2), rk, bound) + "⟧"
    clause = _SCHEMA_CALL_RE.sub(sub, clause)

    # component_role('heavy').load_pct_1rm → primer componente con ese rol, campo escalar.
    # Única concesión a components[] en P3 (Q2): lectura de UN escalar, no iteración de patrones.
    def sub_role(m):
        role, field = m.group(1), m.group(2)
        path = (f"(((b.components||[]).find(c=>c.role==={json.dumps(role)}))||{{}})"
                f".{field}")
        return "⟦" + path + "⟧"
    clause = _COMPONENT_ROLE_RE.sub(sub_role, clause)

    # P3.4 — exercise_tpr/mdi/implement → DATA.exercises[b.exercise].<field>.
    # tpr/mdi/implement YA están embebidos (contrato §3 los lista como accesibles).
    # Escalar puro: lectura de un campo del ejercicio del bloque, sin iteración.
    def sub_ex(m):
        field = _EXERCISE_FIELD[m.group(1)]
        path = f"((DATA.exercises||{{}})[b.exercise]||{{}}).{field}"
        return "⟦" + path + "⟧"
    return _EXERCISE_ACCESS_RE.sub(sub_ex, clause)


# ================================================================ P4.1 — T4 / F3
# Agregaciones de array (contrato P4.0 §2-4). Se preprocesan a un átomo ⟦…⟧ ANTES
# del tokenizador escalar, igual que component_role/exercise_*; el tokenizador NO
# cambia. El predicado interno reusa _when_clause_to_js con item_ctx=True (refs de
# campo → c.<campo> en vez de b.params.<campo>).
#
# P4.1 implementa SOLO la familia F3 (EXISTS): any(...) / all(...) y los accesores
# del primer item ofensor (first_index / first(...).<campo>) que alimentan los
# bindings del message_template. count/distinct_count/sum quedan para P4.2-P4.4.
_AGG_ARRAYS = {"components", "work_per_interval", "set_ramp", "round_plan", "mechanical_progression",
               "exercises_rotation"}   # P5.4 — EMOM alternating rotation list
# Arrays cuyos items son work_units CANÓNICOS (work_metric/work_value): las métricas
# de trabajo (reps/duration_sec/distance_m) viven en work_value condicionadas a
# work_metric, NO como campo plano (el sincronizador c.reps fue retirado en P4.1).
# set_ramp/round_plan son specs de rampa PLANOS (decisión P5 nº2: estructura de
# prescripción declarada explícita) → sus campos son directos.
_WU_CANONICAL_ARRAYS = {"components", "work_per_interval"}
_CANONICAL_METRIC_FIELDS = {"reps", "duration_sec", "distance_m"}
# Campos del work_unit legibles en <pred> y accesores (forma canónica v0.2.0 +
# espejo de compat reps). load_pct_1rm/load_value: lectura escalar del item.
_ITEM_FIELDS = {"exercise", "role", "work_metric", "work_value", "reps",
                "load_metric", "load_pct_1rm", "load_value",
                # P5.3 — AGS: estructura de pareo declarada explícita (decisión P5
                # nº2). pair_index (entero 0-based) + role_in_pair (agonist/antagonist).
                "pair_index", "role_in_pair"}
# catalog(c).<campo> → accesor de catálogo POR ITEM (distinto del exercise_* de
# P3.4 que lee b.exercise). Q2 confirmada: nombre explícito catalog(c).
# P5.5 — segment/pattern/tci añadidos (catálogo-derivados: body_segment,
# movement_pattern, technical_complexity_index ya embebidos en DATA.exercises).
_CATALOG_ITEM_RE = re.compile(r"catalog\(\s*c\s*\)\.([a-zA-Z_][a-zA-Z0-9_]*)")
_CATALOG_ITEM_FIELDS = {"mdi", "tpr", "implement", "name", "segment", "pattern", "tci"}

# any/all/first sobre <array> [where <pred>]; first_index(<array> where <pred>).
# first(<array> where <pred>).<field> → campo del primer item que cumple (para
# bindings de mensaje: reps_actual, mdi_value, component_name). Se capturan con un
# parser de balanceo de paréntesis (no regex anidada), abajo.
_AGG_NAMES_F3 = {"any", "all", "first_index", "first"}
# P4.2 — F1 COUNT (count(<array>)), F2 COUNT-WHERE (count(<array> where <pred>)),
# F5 DISTINCT (distinct_count(<array>.<field>)). Misma mecánica ⟦…⟧ que F3; el
# predicado de COUNT-WHERE reusa item_ctx. DISTINCT extrae un campo del item o de
# catálogo (cat_* vía _FIRST_FIELD_CATALOG, convención de P4.1) — valores no-nulos.
_AGG_NAMES_F2F5 = {"count", "distinct_count"}
# P4.3 — F6 REDUCE/AGG: helpers que RECIBEN EL ARRAY (salto conceptual de P4 — los
# helpers de P3 recibían escalares). `<helper>(<array>)` → __H.<helper>((b.<array>||[])).
# El helper itera el array en el motor (estimate_work_duration suma el tiempo de
# trabajo por intervalo). Registro extensible (P4.4 añade los estimate_*_duration).
_ARRAY_HELPERS = {"estimate_work_duration": "__H.estimate_work_duration"}
# P4.4 — F6 estimación de duración: block-helpers de forma SIN argumentos
# `<helper>()` → __H.<helper>(b). Reciben el bloque completo (leen components +
# params: total_rounds/rest/time_cap) para estimar duración/rondas según el modelo
# de tiempo del spec (Grupo 7). Heurístico; la regla autora el umbral/comparación.
_BLOCK_HELPERS = {"estimate_total_duration": "__H.estimate_total_duration",
                  "estimate_rounds": "__H.estimate_rounds",
                  # P5.3 — AGS group-by (pareo). Reciben el bloque (params + components).
                  "ags_first_bad_pair_index": "__H.ags_first_bad_pair_index",
                  "ags_bad_pair_index_value": "__H.ags_bad_pair_index_value",
                  "ags_pairs_unbalanced": "__H.ags_pairs_unbalanced",
                  "ags_first_shared_pattern_pair": "__H.ags_first_shared_pattern_pair",
                  # P5.5b — PHA alternation (proxy del fn: v3). 4 públicos sobre _pha_scan.
                  "pha_first_alternation_break": "__H.pha_first_alternation_break",
                  "pha_break_actual": "__H.pha_break_actual",
                  "pha_break_expected": "__H.pha_break_expected",
                  "pha_break_name": "__H.pha_break_name",
                  # P5.5c — zona inferida por componente (demanda heterogénea).
                  "zone_spread": "__H.zone_spread",
                  # P5.6/P5.7 — french_contrast role order + SLC TCI ordering.
                  "fc_roles_wrong": "__H.fc_roles_wrong",
                  "slc_first_tci": "__H.slc_first_tci",
                  "slc_avg_rest_tci": "__H.slc_avg_rest_tci",
                  # V3.6.2 — superset que parece par de contraste (mismo patrón + heavy/light + PAP).
                  "superset_resembles_contrast": "__H.superset_resembles_contrast",
                  # V3.6.3 — complex con 4 roles canónicos de french_contrast (mal etiquetado).
                  "resembles_french_contrast": "__H.resembles_french_contrast",
                  # V3.6.4 — clasificador difuso de familia (argmax): misclassified + bindings.
                  "family_misclassified": "__H.family_misclassified",
                  "family_suggested": "__H.family_suggested",
                  "family_current": "__H.family_current",
                  # P6.1 — family canónica de la variante (mismatch declarado vs canónica).
                  "variant_family": "__H.variant_family",
                  # P6.3 — consistencia de ejercicios por-ronda en multi_exercise_pyramid.
                  "mep_rounds_inconsistent": "__H.mep_rounds_inconsistent",
                  # P7.2 — motor de fuerza relativa (weakest-link computado + confianza).
                  "slc_weakest_computed": "__H.slc_weakest_computed",
                  "slc_weakest_conf_low": "__H.slc_weakest_conf_low",
                  "slc_ratio_max_jumps": "__H.slc_ratio_max_jumps",
                  "slc_weakest_misidentified": "__H.slc_weakest_misidentified"}# campos accesibles vía first(...).field: item fields + catálogo del item.
_FIRST_FIELD_ITEM = _ITEM_FIELDS
_FIRST_FIELD_CATALOG = {"cat_mdi": "mdi", "cat_tpr": "tpr",
                        "cat_implement": "implement", "cat_name": "name",
                        # P5.5 — catálogo-derivados para distinct/first/monotonic.
                        "cat_segment": "segment", "cat_pattern": "pattern",
                        "cat_tci": "tci"}


def _item_pred_to_js(pred: str, tier: str) -> str:
    """Traduce el <pred> de un where con el item `c` como contexto.
    Reusa el tokenizador escalar vía item_ctx=True. catalog(c).x se preprocesa
    DENTRO de _when_clause_to_js (tras el guard _FORBIDDEN_RE), porque su path
    expandido contiene `[c.exercise]` que el guard rechazaría si se metiera antes."""
    return _when_clause_to_js(pred, tier, item_ctx=True)


def _split_agg_args(inner: str):
    """Divide `<array> where <pred>` o `<array>.<field>` o `<array>`.
    Devuelve (array, mode, payload): mode ∈ {'where','field','bare'}."""
    # `where` como palabra delimitadora (minúsculas, rodeada de espacios).
    m = re.match(r"\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*", inner)
    if not m:
        raise BuildError(f"agregación malformada: `{inner}`")
    array = m.group(1)
    rest = inner[m.end():]
    if rest.strip().startswith("where "):
        return array, "where", rest.strip()[len("where "):].strip()
    if rest.startswith("."):
        field = rest[1:].strip()
        if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", field):
            raise BuildError(f"campo de agregación inválido: `{field}`")
        return array, "field", field
    if rest.strip() == "":
        return array, "bare", None
    raise BuildError(f"agregación malformada tras `{array}`: `{rest.strip()}`")


def _preprocess_array_aggs(clause: str, tier: str) -> str:
    """Reemplaza any/all/first_index(<array> [where <pred>]) por átomos ⟦…⟧.
    Solo permitido en T4 (frontera de tier). Parser de balanceo de paréntesis
    para soportar predicados con funciones puras (floor(...) etc.) dentro."""
    out, i, n = [], 0, len(clause)
    # Nombres reconocidos = operadores fijos + helpers registrados (array + block).
    # Data-driven: añadir un block-helper a _BLOCK_HELPERS basta (no tocar el regex).
    _agg_names = (["distinct_count", "count", "any", "all", "first_index", "first",
                   "monotonic_increasing", "monotonic_decreasing",
                   "monotonic_break_increasing", "monotonic_break_decreasing"]
                  + sorted(_ARRAY_HELPERS) + sorted(_BLOCK_HELPERS))
    _agg_re = re.compile(r"\b(" + "|".join(re.escape(x) for x in _agg_names) + r")\s*\(")
    while i < n:
        # distinct_count antes que count en la alternación (orden de evaluación).
        m = _agg_re.match(clause[i:])
        if not m:
            out.append(clause[i])
            i += 1
            continue
        name = m.group(1)
        if tier != "T4":
            raise BuildError(
                f"agregación `{name}(...)` solo permitida en tier T4 (no {tier}).")
        # localizar el ( de apertura y su ) balanceado
        open_at = i + m.end() - 1
        depth, j = 0, open_at
        while j < n:
            if clause[j] == "(":
                depth += 1
            elif clause[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if depth != 0:
            raise BuildError(f"paréntesis sin cerrar en `{name}(...)`")
        inner = clause[open_at + 1:j]
        # P4.4 — block-helper: forma sin argumentos `helper()` → __H.helper(b).
        # Recibe el bloque completo (no un array); se resuelve ANTES de _split_agg_args
        # (que exige un nombre de array y fallaría con paréntesis vacíos).
        if name in _BLOCK_HELPERS:
            if inner.strip() != "":
                raise BuildError(
                    f"`{name}()` no recibe argumentos (opera sobre el bloque completo).")
            out.append("⟦" + f"{_BLOCK_HELPERS[name]}(b)" + "⟧")
            i = j + 1
            continue
        array, mode, payload = _split_agg_args(inner)
        if array not in _AGG_ARRAYS:
            raise BuildError(
                f"array no whitelisteado en agregación: `{array}` "
                f"(permitidos: {', '.join(sorted(_AGG_ARRAYS))}).")
        arr_js = f"(b.{array}||[])"
        consumed_to = j + 1
        if name in _ARRAY_HELPERS:
            # F6 REDUCE/AGG: helper que recibe el array completo y lo itera.
            if mode != "bare":
                raise BuildError(
                    f"`{name}(...)` recibe el array completo, sin `where`/`.field`.")
            js = f"{_ARRAY_HELPERS[name]}({arr_js})"
        elif name == "count":
            # F1 COUNT: count(<array>) → .length ; F2 COUNT-WHERE: + .filter(pred).
            if mode == "bare":
                js = f"{arr_js}.length"
            elif mode == "where":
                pred_js = _item_pred_to_js(payload, tier)
                js = f"{arr_js}.filter(c=>({pred_js})).length"
            else:  # field
                raise BuildError(
                    "`count(...)` no acepta `.<field>` (¿querías distinct_count?).")
        elif name == "distinct_count":
            # F5 DISTINCT: cardinalidad de valores únicos no-nulos de un campo.
            # El campo puede ser del item (exercise, role, …) o de catálogo
            # (cat_implement/cat_mdi/cat_tpr/cat_name → DATA.exercises[c.exercise].*).
            if mode != "field":
                raise BuildError(
                    "`distinct_count(...)` requiere `<array>.<field>`.")
            field = payload
            if field in _FIRST_FIELD_CATALOG:
                cf = _FIRST_FIELD_CATALOG[field]
                mapper = f"c=>((DATA.exercises||{{}})[c.exercise]||{{}}).{cf}"
            elif field in _ITEM_FIELDS:
                mapper = f"c=>c.{field}"
            else:
                raise BuildError(
                    f"distinct_count(...).{field} no permitido (campos: "
                    f"{', '.join(sorted(_ITEM_FIELDS))}, "
                    f"{', '.join(sorted(_FIRST_FIELD_CATALOG))}).")
            js = f"new Set({arr_js}.map({mapper}).filter(x=>x!=null)).size"
        elif name in ("monotonic_increasing", "monotonic_decreasing",
                      "monotonic_break_increasing", "monotonic_break_decreasing"):
            # P5.1 — F6 monotonía: monotonic_{increasing,decreasing}(<array>.<field>)
            # → bool (__H.is_monotonic); monotonic_break_{...} → índice 1-based del
            # primer quiebre, 0 si monótono (__H.monotonic_break, para {component_index}).
            # Campo (item canónico/plano o catálogo, misma convención que distinct_count).
            # NO estricto. El helper coacciona vía Number() y descarta no-finitos.
            if mode != "field":
                raise BuildError(
                    f"`{name}(...)` requiere `<array>.<field>`.")
            field = payload
            if field in _FIRST_FIELD_CATALOG:
                cf = _FIRST_FIELD_CATALOG[field]
                mapper = f"c=>((DATA.exercises||{{}})[c.exercise]||{{}}).{cf}"
            elif field == "effective_demand" and array == "mechanical_progression":
                # P5.2 — demanda mecánica efectiva del paso: difficulty_index_override
                # declarado, o el MDI del catálogo del ejercicio si no se declara.
                mapper = ("c=>(c.difficulty_index_override!=null?c.difficulty_index_override"
                          ":((DATA.exercises||{})[c.exercise]||{}).mdi)")
            elif field in _CANONICAL_METRIC_FIELDS and array in _WU_CANONICAL_ARRAYS:
                mapper = f"c=>(c.work_metric==='{field}'?c.work_value:null)"
            elif field in _ITEM_FIELDS:
                mapper = f"c=>c.{field}"
            else:
                raise BuildError(
                    f"{name}(...).{field} no permitido (campos: "
                    f"{', '.join(sorted(_ITEM_FIELDS | _CANONICAL_METRIC_FIELDS))}, "
                    f"{', '.join(sorted(_FIRST_FIELD_CATALOG))}).")
            direction = "inc" if name.endswith("increasing") else "dec"
            helper = "monotonic_break" if "break" in name else "is_monotonic"
            js = f"__H.{helper}({arr_js}.map({mapper}), '{direction}')"
        elif name in ("any", "all"):
            if mode != "where":
                raise BuildError(f"`{name}(...)` requiere `where <pred>`.")
            pred_js = _item_pred_to_js(payload, tier)
            js = (f"{arr_js}.some(c=>({pred_js}))" if name == "any"
                  else f"{arr_js}.every(c=>({pred_js}))")
        elif name == "first_index":
            if mode != "where":
                raise BuildError("`first_index(...)` requiere `where <pred>`.")
            pred_js = _item_pred_to_js(payload, tier)
            js = f"{arr_js}.findIndex(c=>({pred_js}))"
        else:  # first(<array> where <pred>).<field>  → campo del item ofensor
            if mode != "where":
                raise BuildError("`first(...)` requiere `where <pred>`.")
            # debe seguir .<field>
            fm = re.match(r"\.([a-zA-Z_][a-zA-Z0-9_]*)", clause[j + 1:])
            if not fm:
                raise BuildError("`first(...)` requiere acceso `.<field>` "
                                 "(p.ej. first(...).work_value).")
            field = fm.group(1)
            pred_js = _item_pred_to_js(payload, tier)
            found = f"({arr_js}.find(c=>({pred_js}))||{{}})"
            if field in _FIRST_FIELD_CATALOG:
                cf = _FIRST_FIELD_CATALOG[field]
                # catálogo del item ofensor: cat_name/cat_mdi/cat_tpr/cat_implement
                js = (f"((DATA.exercises||{{}})[{found}.exercise]||{{}}).{cf}")
            elif field in _FIRST_FIELD_ITEM:
                js = f"{found}.{field}"
            else:
                raise BuildError(
                    f"first(...).{field} no permitido (campos: "
                    f"{', '.join(sorted(_FIRST_FIELD_ITEM))}, "
                    f"{', '.join(sorted(_FIRST_FIELD_CATALOG))}).")
            consumed_to = j + 1 + fm.end()
        out.append("⟦" + js + "⟧")
        i = consumed_to
    return "".join(out)


_TOKEN_RE = re.compile(r"""
    \s+
  | (?P<raw>⟦[^⟧]*⟧)
  | (?P<str>'[^']*')
  | (?P<num>\d+(?:\.\d+)?)
  | (?P<op><=|>=|==|!=|<|>)
  | (?P<arith>[+\-*/])
  | (?P<logic>\bAND\b|\bOR\b|\bNOT\b)
  | (?P<paren>[()])
  | (?P<comma>,)
  | (?P<ident>[a-zA-Z_][a-zA-Z0-9_]*)
""", re.VERBOSE)

_LOGIC = {"AND": "&&", "OR": "||", "NOT": "!"}
_LITERALS = {"null", "true", "false"}


def _when_clause_to_js(clause: str, tier: str, bindings: set = frozenset(),
                       item_ctx: bool = False) -> str:
    if _FORBIDDEN_RE.search(clause):       # corre sobre el clause ORIGINAL del usuario
        raise BuildError(
            f"TIER no compilable: la cláusula `{clause}` usa array selector / fn:* "
            f"(reservado a T4/T5), prohibido en {tier}.")
    if not item_ctx:
        # P4.1: agregaciones de array (F3) → átomos ⟦…⟧. Solo a nivel de bloque,
        # NO dentro de un predicado de item (no se anidan agregaciones en P4.1).
        clause = _preprocess_array_aggs(clause, tier)
    else:
        # P4.1: catalog(c).<campo> → path sobre c (DESPUÉS del guard _FORBIDDEN_RE,
        # porque el path expandido contiene `[c.exercise]`).
        def _sub_cat(m):
            field = m.group(1)
            if field not in _CATALOG_ITEM_FIELDS:
                raise BuildError(
                    f"catalog(c).{field} no permitido (campos: "
                    f"{', '.join(sorted(_CATALOG_ITEM_FIELDS))}).")
            return "⟦" + f"(((DATA.exercises||{{}})[c.exercise]||{{}}).{field} ?? null)" + "⟧"
        clause = _CATALOG_ITEM_RE.sub(_sub_cat, clause)
    clause = _preprocess_schema_calls(clause)   # canonical_max(x) → ⟦<jspath>⟧
    # tokenizar
    toks, pos = [], 0
    while pos < len(clause):
        m = _TOKEN_RE.match(clause, pos)
        if not m or m.end() == pos:
            raise BuildError(f"Token no reconocido en `when`: ...{clause[pos:pos+20]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind:
            toks.append((kind, m.group()))
    # emitir (con lookahead para llamadas a función ident '(' )
    out = []
    for i, (kind, val) in enumerate(toks):
        if kind == "raw":
            out.append(val[1:-1])            # quita ⟦ ⟧, emite JS verbatim
        elif kind == "str":                  # 'literal' → string JS verbatim
            out.append(val)
        elif kind == "op":
            # equidad estricta (coherente con _scope_to_js); resto verbatim.
            out.append({"==": "===", "!=": "!=="}.get(val, val))
        elif kind in ("num", "arith", "paren", "comma"):
            out.append(val)
        elif kind == "logic":
            out.append(_LOGIC[val])
        elif kind == "ident":
            nxt = toks[i + 1][1] if i + 1 < len(toks) else None
            if nxt == "(":                       # llamada a función
                if val in _PURE_FN:
                    out.append(_PURE_FN[val])
                elif val in _HELPER_FN:          # helper de estimación T2/T3
                    out.append(_HELPER_FN[val])
                else:
                    raise BuildError(f"Función no permitida en {tier}: {val}() (whitelist: "
                                     f"{', '.join(sorted(_PURE_FN))}, "
                                     f"{', '.join(sorted(_HELPER_FN))} + accesores de rango).")
            elif val in _LITERALS:               # null / true / false → verbatim
                out.append(val)
            elif val in bindings:                # binding local precomputado
                out.append(val)
            elif item_ctx:                       # P4.1 — predicado de item: ref → c.<campo>
                if val not in _ITEM_FIELDS:
                    raise BuildError(
                        f"campo de item no permitido en predicado: `{val}` "
                        f"(campos: {', '.join(sorted(_ITEM_FIELDS))}).")
                # Sin Number(): JS coacciona en >/< ("8">6 → true) y preserva la
                # semántica de == null (Number(null)===0 rompería el chequeo de
                # nulidad). Equivalente al hardcode en magnitud, correcto en nulidad.
                out.append(f"c.{val}")
            elif val in _DIRECT_PATHS:
                out.append(f"b.{val}")
            else:
                out.append(f"b.params.{val}")
    return " ".join(out)


def _when_to_js(when, tier: str, bindings: set = frozenset()) -> str:
    clauses = when if isinstance(when, list) else [when]
    return " && ".join(f"({_when_clause_to_js(str(c), tier, bindings)})" for c in clauses)


# ---------------------------------------------------------------- scope → JS
def _scope_to_js(scope: dict) -> str:
    # P3.4 — scope universal: method declarado como null = aplica a cualquier
    # método (la precondición real vive en `when`, p.ej. un gate por intent). El
    # compilador acepta scope sin method SOLO si la clave existe y es null
    # explícito (no un olvido). applies(b) => true en ese caso.
    if scope and "method" in scope and scope["method"] is None:
        parts = []
        if scope.get("variant"):
            parts.append(f"b.variant==={json.dumps(scope['variant'])}")
        if scope.get("variant_in"):
            vs = json.dumps(list(scope["variant_in"]))
            parts.append(f"{vs}.includes(b.variant)")
        if scope.get("variant_not_in"):
            vs = json.dumps(list(scope["variant_not_in"]))
            parts.append(f"!{vs}.includes(b.variant)")
        return " && ".join(parts) if parts else "true"
    if not scope or ("method" not in scope and "method_in" not in scope):
        raise BuildError("scope.method o scope.method_in requerido (precondición barata applies(b)).")
    parts = []
    if scope.get("method_in"):
        # P4.1 — scope multi-método (p.ej. contrast+complex). Análogo a variant_in.
        ms = json.dumps(list(scope["method_in"]))
        parts.append(f"{ms}.includes(b.method)")
    else:
        parts.append(f"b.method==={json.dumps(scope['method'])}")
    if scope.get("variant"):
        parts.append(f"b.variant==={json.dumps(scope['variant'])}")
    if scope.get("variant_in"):
        vs = json.dumps(list(scope["variant_in"]))
        parts.append(f"{vs}.includes(b.variant)")
    if scope.get("variant_not_in"):
        vs = json.dumps(list(scope["variant_not_in"]))
        parts.append(f"!{vs}.includes(b.variant)")
    return " && ".join(parts)


# ------------------------------------------------------ message/suggestion → JS
def _tpl_to_js(tpl: str, prefix: str = "", bind_names: set = frozenset()) -> str:
    """Closure b=>... que sustituye {nombre} por su valor: binding → param → campo
    directo del bloque (variant/method/exercise) → literal sin resolver."""
    lit = json.dumps(tpl or "", ensure_ascii=False)
    repl = (r".replace(/\{(\w+)\}/g,(_,k)=>"
            r"(__m[k]!==undefined?__m[k]:(b[k]!==undefined?b[k]:'{'+k+'}')))")
    if prefix or bind_names:
        binds = ",".join(sorted(bind_names))
        return (f"b=>{{{prefix}const __m=Object.assign({{}},b.params,{{{binds}}});"
                f"return {lit}{repl};}}")
    return (f"b=>{{const __m=b.params;return {lit}{repl};}}")


# ---------------------------------------------------------------- compile
def compile_rules(root: Path) -> dict:
    """Compila la fuente. Escribe compiled/compiled_rules.yaml.
    Devuelve {'js': <str inyectable>, 'compiled': <ruta>, 'rules': n_emitted,
              'reserved': n_t4t5, 'digest': sha}."""
    root = Path(root)
    src_path = root / "rules" / "prescriptor_rules.yaml"
    flags_path = root / "flag_catalog.yaml"
    src_bytes = src_path.read_bytes()
    flags_bytes = flags_path.read_bytes()

    src = yaml.safe_load(src_bytes)
    flags = yaml.safe_load(flags_bytes)["flags"]

    digest = hashlib.sha256(src_bytes + flags_bytes).hexdigest()

    compiled_rules, js_rules, reserved = [], [], 0
    seen_ids = set()

    for rule in src.get("rules", []):
        rid = rule.get("id")
        if not rid:
            raise BuildError("Regla sin `id`.")
        if rid in seen_ids:
            raise BuildError(f"id duplicado en la fuente: {rid}")
        seen_ids.add(rid)

        tier = rule.get("tier")
        if tier not in COMPILABLE_TIERS and tier not in ("T4", "T5"):
            raise BuildError(f"{rid}: tier inválido {tier!r} (T1–T5).")

        # E1 — `emits` obligatorio (mapping embebido; imposible que falte).
        emits = rule.get("emits")
        if not emits:
            raise BuildError(f"E1: regla {rid} sin `emits`.")
        emit_ids = emits if isinstance(emits, list) else [emits]

        # E2/E3 — validados contra flag_catalog en compile-time.
        for fid in emit_ids:
            if fid not in flags:
                raise BuildError(f"E2: {rid} → emits '{fid}' inexistente en flag_catalog.")
            scope_at = flags[fid].get("applies_at")
            if scope_at not in PRESCRIPTOR_SCOPES:
                raise BuildError(
                    f"E3: {rid} → '{fid}' applies_at={scope_at} ∉ {{block, session}}.")

        # Ficha autoridad: el flag manda. Forma normalizada 1:1 ⇒ id == emit.
        primary = flags[emit_ids[0]]
        norm = {
            "id": rid,
            "tier": tier,
            "origin": rule.get("origin", "rules/prescriptor_rules.yaml"),
            "applies_at": primary.get("applies_at"),
            "severity": primary.get("severity"),
            "level": primary.get("level"),
            "scope": rule.get("scope", {}),
            "when": rule.get("when", []),
            "detail_schema": primary.get("detail_schema"),
            "message_template": primary.get("message_template"),
            "suggestion_template": primary.get("suggestion_template"),
            "emits": emits,
            "fidelity": rule.get("fidelity", "implemented"),
        }
        if rule.get("bindings"):
            norm["bindings"] = rule["bindings"]
        compiled_rules.append(norm)

        # T5: declarada pero INERTE — el compilador no genera test() (strength
        # data / loaded_regions no embebidos). T4 YA compila desde P4.1 (F3).
        if tier == "T5":
            reserved += 1
            continue

        # bindings: locales computados (ref. solo a params) usados por when + plantillas.
        bindings = rule.get("bindings") or {}
        bind_names = set(bindings)
        prefix = "".join(
            f"const {n}=({_when_clause_to_js(str(expr), tier)});"
            for n, expr in bindings.items())

        applies_js = _scope_to_js(norm["scope"])
        when_body = _when_to_js(norm["when"], tier, bind_names)
        test_js = (f"b=>{{{prefix}return ({when_body});}}" if prefix
                   else f"b=>({when_body})")
        msg_js = _tpl_to_js(norm["message_template"], prefix, bind_names)
        sugg_js = _tpl_to_js(norm["suggestion_template"], prefix, bind_names)
        sev = _SEV_TO_ENGINE.get(norm["severity"], "informational")
        level = norm["level"]
        js_rules.append(
            f"{{ id:{json.dumps(rid)}, sev:{json.dumps(sev)}, "
            f"level:{json.dumps(level)}, "
            f"applies:b=>({applies_js}), test:{test_js}, "
            f"msg:{msg_js}, sugg:{sugg_js} }}")

    # --- P3.4: engine_rules (mapping-only del motor de rangos genérico). NO se
    # compilan a closure (el motor itera params_schema en código). Solo se validan
    # sus `emits` (E2/E3) y se copian a compiled_rules.yaml para que
    # coverage_report.py derive la cobertura sin regex sobre el template. ---
    engine_rules = []
    for er in src.get("engine_rules", []):
        eid = er.get("id")
        if not eid:
            raise BuildError("engine_rule sin `id`.")
        emits = er.get("emits")
        emit_ids = [] if emits is None else (emits if isinstance(emits, list) else [emits])
        for fid in emit_ids:
            if fid not in flags:
                raise BuildError(f"E2: engine_rule {eid} → emits '{fid}' inexistente en flag_catalog.")
            scope_at = flags[fid].get("applies_at")
            if scope_at not in PRESCRIPTOR_SCOPES:
                raise BuildError(
                    f"E3: engine_rule {eid} → '{fid}' applies_at={scope_at} ∉ {{block, session}}.")
        engine_rules.append({
            "id": eid,
            "emits": emits,
            "fidelity": er.get("fidelity", "implemented"),
        })

    # --- emit compiled/compiled_rules.yaml (derivado, NO editar) ---
    out_doc = {
        "version": "1.0",
        "generated_by": "tools/rule_compiler.py::compile_rules",
        "source_digest": digest,
        "rules": compiled_rules,
        "engine_rules": engine_rules,
    }
    compiled_dir = root / "compiled"
    compiled_dir.mkdir(exist_ok=True)
    compiled_path = compiled_dir / "compiled_rules.yaml"
    header = ("# compiled_rules.yaml — ARTEFACTO DERIVADO. NO EDITAR A MANO.\n"
              "# Regenerar: python3 tools/build_prescriptor.py "
              "(corre rule_compiler.compile_rules).\n"
              "# Fuente: rules/prescriptor_rules.yaml + flag_catalog.yaml "
              "(ver source_digest).\n")
    compiled_path.write_text(
        header + yaml.safe_dump(out_doc, sort_keys=False, allow_unicode=True))

    js_array = "const COMPILED_RULES = [\n  " + ",\n  ".join(js_rules) + "\n];"
    return {"js": js_array, "helpers_js": HELPER_DEFS_JS, "compiled": compiled_path,
            "rules": len(js_rules), "reserved": reserved, "digest": digest}
