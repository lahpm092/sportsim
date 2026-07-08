#!/usr/bin/env python3
"""
validate_macro.py — partial reference implementation of Group 13:
validate_macrocycle + cross-file template resolution + taper checks.
Usage: python3 validate_macro.py macrocycle_hyrox_sample.yaml template_examples.yaml
"""
import sys, yaml
from datetime import date, timedelta

def load_all(paths):
    st, mc, mt, macro = {}, {}, {}, None
    for p in paths:
        with open(p) as f:
            d = yaml.safe_load(f)
        st.update(d.get('session_templates') or {})
        mc.update(d.get('microcycle_templates') or {})
        mt.update(d.get('mesocycle_templates') or {})
        if 'macrocycle' in d:
            macro = d['macrocycle']
    return st, mc, mt, macro

def main():
    st, mc, mt, M = load_all(sys.argv[1:])
    errors, warnings, infos = [], [], []

    # --- Resolución de referencias (composición completa) ---
    for mt_id, m in mt.items():
        for w in m['weeks']:
            if w.get('microcycle') and w['microcycle'] not in mc:
                errors.append(f"[ref] {mt_id} semana {w['week']} → microciclo '{w['microcycle']}' no existe")
    for mc_id, m in mc.items():
        for s in m['slots']:
            ref = s.get('session_template')
            if ref and ref not in st:
                errors.append(f"[ref] {mc_id} slot '{s['slot_id']}' → session_template '{ref}' no existe")
    for ph in M['phases']:
        ref = ph.get('mesocycle')
        if ref and ref not in mt:
            errors.append(f"[ref] fase {ph['order']} → mesociclo '{ref}' no existe")

    # --- Timeline: continuidad, gaps, overlaps (macrocycle_phase_overlap = HARD) ---
    phases = sorted(M['phases'], key=lambda p: p['order'])
    cursor = M['start_date']
    for ph in phases:
        s = ph['start_date']; e = s + timedelta(weeks=ph['weeks'])
        if s < cursor:
            errors.append(f"[overlap] fase {ph['order']} ({ph['purpose']}) empieza {s} antes del fin de la anterior {cursor} → macrocycle_phase_overlap (HARD)")
        elif s > cursor:
            warnings.append(f"[gap] {(s - cursor).days} días sin fase entre {cursor} y {s} → macrocycle_timeline_gap")
        # duración de fase vs duración del mesociclo referenciado
        ref = ph.get('mesocycle')
        if ref and ref in mt and mt[ref]['duration_weeks'] != ph['weeks']:
            warnings.append(f"[dur] fase {ph['order']}: weeks={ph['weeks']} ≠ mesociclo '{ref}' duration_weeks={mt[ref]['duration_weeks']}")
        cursor = e
    if cursor - timedelta(days=1) > M['end_date']:
        warnings.append(f"[end] fases terminan {cursor} después del end_date {M['end_date']}")

    # --- Eventos ---
    a_events = [e for e in M['events'] if e['priority'] == 'A']
    for ev in M['events']:
        if not (M['start_date'] <= ev['date'] <= M['end_date']):
            errors.append(f"[event] {ev['id']} ({ev['date']}) fuera del macro")
    # A events spacing
    a_dates = sorted(e['date'] for e in a_events)
    for d1, d2 in zip(a_dates, a_dates[1:]):
        if (d2 - d1).days < 42:
            warnings.append(f"[A-spacing] dos eventos A a {(d2-d1).days} días → multiple_a_events_too_close")

    # --- Taper ---
    taper = M.get('taper')
    for ev in a_events:
        if not taper or taper['event_ref'] != ev['id']:
            warnings.append(f"[taper] evento A '{ev['id']}' sin taper → event_a_without_taper")
    if taper:
        ev = next(e for e in M['events'] if e['id'] == taper['event_ref'])
        t_end = taper['start_date'] + timedelta(days=taper['duration_days'])
        if not (8 <= taper['duration_days'] <= 14) and ev['priority'] == 'A':
            infos.append(f"[taper] duración {taper['duration_days']}d fuera de [8,14] para A → taper_duration_atypical")
        if t_end < ev['date'] - timedelta(days=1) or taper['start_date'] >= ev['date']:
            warnings.append(f"[taper] ventana {taper['start_date']}→{t_end} no termina adyacente al evento {ev['date']}")
        if taper['deltas'].get('intensity') != 'maintained':
            warnings.append("[taper] intensidad no mantenida: el error clásico")

    # --- Deload posicionamiento por modelo (umbral concurrent 3-4, nivel advanced=4) ---
    for mt_id, m in mt.items():
        run = 0
        for w in m['weeks']:
            if w.get('type') == 'planned_deload':
                run = 0
            else:
                run += 1
                if run > 4:
                    warnings.append(f"[deload] {mt_id}: {run} semanas standard sin deload (umbral advanced/concurrent=4) → mesocycle_deload_overdue")

    # --- Test weeks: nota de medición presente ---
    for mt_id, m in mt.items():
        for w in m['weeks']:
            if w.get('type') == 'test' and 'AMRAP' not in str(w.get('note', '')) and 'SIMULACIÓN' not in str(w.get('note', '')).upper():
                infos.append(f"[test] {mt_id} semana {w['week']}: test sin bloques de medición declarados → test_week_without_amrap")

    # --- Reporte ---
    print(f"Componentes: {len(st)} session_templates | {len(mc)} microciclos | {len(mt)} mesociclos | {len(M['events'])} eventos | {len(phases)} fases")
    print(f"Macro: {M['start_date']} → {M['end_date']} ({(M['end_date'] - M['start_date']).days // 7 + 1} semanas)")
    print()
    for e in errors:   print(f"  ERROR    {e}")
    for w in warnings: print(f"  WARNING  {w}")
    for i in infos:    print(f"  INFO     {i}")
    print()
    if errors:
        print("✗ MACRO INVÁLIDO (errores duros)"); sys.exit(1)
    print(f"✓ MACRO VÁLIDO — {len(warnings)} warnings, {len(infos)} infos")

if __name__ == '__main__':
    main()
