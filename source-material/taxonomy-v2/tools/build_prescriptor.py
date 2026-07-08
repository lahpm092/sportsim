#!/usr/bin/env python3
"""
build_prescriptor.py — generates prescriptor.html from the repo's source YAMLs.
Data is NEVER hand-copied: methods/params/catalog are extracted from ground truth.

Usage (from repo root):
  python3 tools/build_prescriptor.py [output_path]
Defaults: reads methods/ + catalog/, template at prescriptor/prescriptor_template.html,
writes prescriptor/prescriptor.html
"""
import sys, os, json, yaml
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rule_compiler import compile_rules, BuildError

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # P3: compila reglas declarativas → compiled/compiled_rules.yaml + JS inyectable.
    # E1/E2/E3/TIER abortan aquí (compile-time), antes de tocar el motor.
    try:
        comp = compile_rules(root)
    except BuildError as e:
        print(f'✗ COMPILADOR DE REGLAS — BUILD ERROR: {e}'); sys.exit(1)
    p1 = yaml.safe_load(open(os.path.join(root, 'methods/taxonomy_v2.yaml')))
    p2 = yaml.safe_load(open(os.path.join(root, 'methods/taxonomy_v2_methods_part2.yaml')))
    methods_src = {**p1['methods'], **p2['methods']}

    methods = {}
    for mid, m in methods_src.items():
        variants = {}
        for vid, v in m['variants'].items():
            variants[vid] = {
                'name': v.get('name', vid),
                'family': v.get('family'),
                'description': v.get('description', ''),
                'defaults': v.get('defaults', {}),
                'params_schema': v.get('params_schema', {}),
            }
        methods[mid] = {'name': m.get('name', mid), 'variants': variants}

    exercises = {}
    strength_hubs = {}
    inter_hub_ratios = []
    for part in ['catalog/catalog_seed_part1.yaml', 'catalog/catalog_seed_part2.yaml']:
        cat = yaml.safe_load(open(os.path.join(root, part)))
        # P7.1 — grafo de fuerza: hubs + ratios inter-hub viven SOLO en part1 (top-level).
        if cat.get('strength_hubs'):
            strength_hubs = cat['strength_hubs']
        if cat.get('inter_hub_ratios'):
            inter_hub_ratios = cat['inter_hub_ratios']
        for eid, e in cat['exercises'].items():
            exercises[eid] = {
                'name': e['name'], 'name_es': e.get('name_es', ''),
                'pattern': e['movement_pattern'], 'implement': e['implement'],
                'segment': e.get('body_segment', ''),
                'muscles': e.get('primary_muscles', []),
                # V3.3b: secundarios para el conteo fraccional de volumen (primary 1.0 / secondary 0.5).
                'secondary': e.get('secondary_muscles', []),
                'mdi': e.get('mechanical_demand_index', 0),
                'tci': e.get('technical_complexity_index', 0),
                'tpr': e.get('typical_time_per_rep_sec', 3),
                # P7.1 — ratios de fuerza relativa por ejercicio (vs referencia).
                'strength_ratio_vs': e.get('strength_ratio_vs', []),
            }

    intents = ['max_strength', 'strength', 'power', 'hypertrophy',
               'strength_endurance', 'conditioning', 'technique', 'prehab']

    # P3.3 (T3): rangos de zona Z1..Z6 para classify_zone (helper __H.classify_zone).
    # Fuente: taxonomy_v2.yaml::zones (anclas de clasificación). Solo reps/load/rir.
    zones = {}
    for zid, z in (p1.get('zones') or {}).items():
        zones[zid] = {'reps': z['reps'], 'load_pct_1rm': z['load_pct_1rm'], 'rir': z['rir']}

    # P3.4: tabla de afinidad intent↔método (helper __H.intent_off_method).
    # Fuente: rules/prescriptor_rules.yaml::intent_affinity (única fuente de verdad,
    # migrada del hardcode). Ya está dentro del source_digest del compilador.
    rules_src = yaml.safe_load(open(os.path.join(root, 'rules/prescriptor_rules.yaml')))
    intent_affinity = rules_src.get('intent_affinity', {})

    # V3.3b: motor de volumen (Capa C). Fuente: autoregulation_schema.yaml::volume_engine.
    # Embebemos landmarks RP-style por grupo, la tabla de conteo por método y los
    # factores fraccionales para que el motor de microciclo los lea (sin reimplementar la spec).
    auto_src = yaml.safe_load(open(os.path.join(root, 'autoregulation/autoregulation_schema.yaml')))
    ve = auto_src.get('volume_engine', {}) or {}
    volume_landmarks = {k: v for k, v in (ve.get('volume_landmarks') or {}).items() if k != '_meta'}
    fractional = ve.get('fractional_counting', {'primary': 1.0, 'secondary': 0.5})
    method_set_counting = ve.get('method_set_counting', {})
    effective_set = ve.get('effective_set_threshold', {'rir_max': 4})

    # V3.4: periodización (Capa D). Fuente: periodization_models.yaml + periodization_schema.yaml.
    # Embebemos los 5 modelos (axis/relación/validation/deload_positioning/variants), las 4
    # model_drift_rules y los umbrales de deload por nivel para que el motor de mesociclo
    # LEA la spec (no la reimplemente), igual que V3.3b con el volume_engine.
    perio_src = yaml.safe_load(open(os.path.join(root, 'periodization/periodization_models.yaml')))
    perio_models = {}
    for mid, m in (perio_src.get('models') or {}).items():
        perio_models[mid] = {
            'primary_axis': m.get('primary_axis'),
            'intensity_volume_relation': m.get('intensity_volume_relation'),
            'deload_positioning': m.get('deload_positioning', {}),
            'variants': list((m.get('variants') or {}).keys()),
        }
    model_drift_rules = perio_src.get('model_drift_rules', [])
    psch = yaml.safe_load(open(os.path.join(root, 'periodization/periodization_schema.yaml')))
    deload_threshold = (psch.get('deload_overdue_threshold') or {}).get('by_level',
                        {'beginner': 7, 'intermediate': 5, 'advanced': 4})

    # V3.5: motor de progresión inter-sesión (Capa C). Fuente: autoregulation_schema.yaml.
    # Embebemos la conversión RIR→carga (pct/RIR + modificadores por zona), la política
    # de asimetría (reduce con 1 señal / sube con 2 consecutivas + caps) y la derivación
    # de fatigue_state, para que GEN.progress LEA la spec (no la reimplemente).
    # rir_to_load_conversion y asymmetry_policy viven bajo la key top-level `intra_session`.
    intra = auto_src.get('intra_session', {}) or {}
    rir_to_load = intra.get('rir_to_load_conversion',
                            {'default_pct_per_rir': 2.5,
                             'context_modifiers': {'zone_z1_z2': 3.0, 'zone_z3_z4': 2.5, 'zone_z5_z6': 2.0}})
    asymmetry = intra.get('asymmetry_policy',
                          {'increase_cap_per_session_pct': 5, 'reduce_cap_per_block_pct': 10})
    fatigue_state = auto_src.get('fatigue_state', {}) or {}
    progression_engine = {
        'rir_to_load': rir_to_load,
        'asymmetry': {'increase_cap_per_session_pct': asymmetry.get('increase_cap_per_session_pct', 5),
                      'reduce_cap_per_block_pct': asymmetry.get('reduce_cap_per_block_pct', 10),
                      'increase_streak': 2, 'reduce_signal': 1},
        'fatigue_derivation': fatigue_state.get('derivation', {}),
        # umbrales inter-sesión de adjustment_rules (pattern streaks):
        'pattern_streak': {'reduce_streak': 2, 'reduce_pct': -5,
                           'accelerate_streak': 2, 'accelerate_pct': 2.5}}

    data = ('const DATA = ' + json.dumps(
        {'methods': methods, 'exercises': exercises, 'intents': intents,
         'zones': zones, 'intent_affinity': intent_affinity,
         'strength_hubs': strength_hubs, 'inter_hub_ratios': inter_hub_ratios,
         'volume_landmarks': volume_landmarks,
         'volume_fractional': {'primary': fractional.get('primary', 1.0),
                               'secondary': fractional.get('secondary', 0.5)},
         'volume_rir_max': effective_set.get('rir_max', 4),
         'method_set_counting': method_set_counting,
         'periodization_models': perio_models,
         'model_drift_rules': model_drift_rules,
         'deload_overdue_threshold': deload_threshold,
         'progression_engine': progression_engine},
        ensure_ascii=False, separators=(',', ':')) + ';')

    tpl_path = os.path.join(root, 'prescriptor/prescriptor_template.html')
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'prescriptor/prescriptor.html')
    tpl = open(tpl_path).read()
    assert '/*__DATA__*/' in tpl, 'template marker missing'
    assert '/*__COMPILED_RULES__*/' in tpl, 'template marker __COMPILED_RULES__ missing'
    assert '/*__ESTIMATION_HELPERS__*/' in tpl, 'template marker __ESTIMATION_HELPERS__ missing'
    assert '/*__GENERATOR__*/' in tpl, 'template marker __GENERATOR__ missing'
    gen_src = open(os.path.join(root, 'generator/generator.js')).read()
    html = tpl.replace('/*__DATA__*/', data)
    html = html.replace('/*__ESTIMATION_HELPERS__*/', comp['helpers_js'])
    html = html.replace('/*__COMPILED_RULES__*/', comp['js'])
    html = html.replace('/*__GENERATOR__*/', gen_src)
    open(out_path, 'w').write(html)

    n_var = sum(len(m['variants']) for m in methods.values())
    size = os.path.getsize(out_path) / 1024
    print(f'✓ prescriptor.html generado: {len(methods)} métodos / {n_var} variantes / '
          f'{len(exercises)} ejercicios embebidos · {size:.0f} KB → {out_path}')
    print(f'✓ compiled_rules: {comp["rules"]} regla(s) emitida(s), {comp["reserved"]} '
          f'T4/T5 reservada(s) · digest {comp["digest"][:12]} → {os.path.relpath(comp["compiled"], root)}')
    # Sin verde no hay entrega: la suite corre en cada build
    import subprocess
    # P3: integridad del compilador (E1/E2/E3/TIER + round-trip) — gate propio
    r = subprocess.run([sys.executable, os.path.join(root, 'tools/test_compiler.py')])
    if r.returncode != 0:
        print('✗ FAULT-INJECTION DEL COMPILADOR EN ROJO — build inválido'); sys.exit(1)
    r = subprocess.run(['node', os.path.join(root, 'tools/test_prescriptor.js')])
    if r.returncode != 0:
        print('✗ SUITE EN ROJO — build inválido'); sys.exit(1)
    # v0.2.0: FI del editor unificado de work_units (modelo canónico + shim + round-trip)
    r = subprocess.run(['node', os.path.join(root, 'tools/test_workunit_editor.js')])
    if r.returncode != 0:
        print('✗ FI DEL EDITOR DE WORK_UNITS EN ROJO — build inválido'); sys.exit(1)
    # V3.1: tests del generador (validador-es-test + caracterización + distribución)
    r = subprocess.run(['node', os.path.join(root, 'tools/test_generator.js')])
    if r.returncode != 0:
        print('✗ TESTS DEL GENERADOR V3 EN ROJO — build inválido'); sys.exit(1)
    # P2: matriz de cobertura — la INTEGRIDAD del mapping bloquea; el % es informativo
    r = subprocess.run([sys.executable, os.path.join(root, 'tools/coverage_report.py')])
    if r.returncode != 0:
        print('✗ MAPPING DE COBERTURA ROTO — build inválido'); sys.exit(1)

if __name__ == '__main__':
    main()
