#!/usr/bin/env python3
"""
Catalog integrity validator — implements B.2 (P1-P3) and B.3 (R1-R2)
against the seed catalog. This is the dogfooding of validate_catalog_integrity.
"""
import yaml, sys
from collections import defaultdict

def load_catalog(paths):
    exercises, edges_addenda, hubs, inter_hub = {}, [], {}, []
    for p in paths:
        with open(p) as f:
            data = yaml.safe_load(f)
        exercises.update(data.get('exercises', {}))
        edges_addenda += data.get('edges_addenda', [])
        hubs.update(data.get('strength_hubs', {}))
        inter_hub += data.get('inter_hub_ratios', [])
    return exercises, edges_addenda, hubs, inter_hub

def node_key(exercise_id, variation_id=None):
    return (exercise_id, variation_id)

def demand(ex_db, exercise_id, variation_id=None):
    ex = ex_db[exercise_id]
    base = ex['mechanical_demand_index']
    if variation_id:
        for v in ex.get('variations', []):
            if v['id'] == variation_id:
                return base + v.get('mechanical_demand_delta', 0)
        return None  # variation missing
    return base

def collect_all_edges(ex_db, addenda):
    """Return list of (source_node, target_node, mechanism, origin) tuples."""
    edges = []
    for ex_id, ex in ex_db.items():
        for e in ex.get('progressions', []):
            t = e['target']
            edges.append((node_key(ex_id), node_key(t['exercise'], t.get('variation')),
                          e['mechanism'], f"{ex_id}.progressions"))
    for e in addenda:
        s, t = e['source'], e['target']
        edges.append((node_key(s['exercise'], s.get('variation')),
                      node_key(t['exercise'], t.get('variation')),
                      e['mechanism'], "edges_addenda"))
    return edges

def main():
    paths = sys.argv[1:] or ['catalog_seed_part1.yaml', 'catalog_seed_part2.yaml']
    ex_db, addenda, hubs, inter_hub = load_catalog(paths)
    errors, warnings = [], []

    print(f"Loaded {len(ex_db)} exercises from {len(paths)} files")
    n_vars = sum(len(e.get('variations', [])) for e in ex_db.values())
    print(f"Total variations: {n_vars} → total nodes: {len(ex_db) + n_vars}")

    edges = collect_all_edges(ex_db, addenda)
    print(f"Total explicit progression edges: {len(edges)}\n")

    # ---- P3: references resolvable ----
    valid_mechanisms = {'load','leverage','angle','assistance','range_of_motion',
                        'stability','complexity','tempo'}
    for (s, t, mech, origin) in edges:
        for node, role in [(s,'source'),(t,'target')]:
            ex_id, var_id = node
            if ex_id not in ex_db:
                errors.append(f"[P3] catalog_edge_target_missing: {role} exercise '{ex_id}' "
                              f"not found (edge at {origin})")
            elif var_id is not None:
                if not any(v['id']==var_id for v in ex_db[ex_id].get('variations',[])):
                    errors.append(f"[P3] catalog_edge_target_missing: variation '{var_id}' "
                                  f"of '{ex_id}' not found (edge at {origin})")
        if mech not in valid_mechanisms:
            errors.append(f"[P3] invalid mechanism '{mech}' (edge at {origin})")

    # ---- Equivalence + ratio references ----
    for ex_id, ex in ex_db.items():
        for eq in ex.get('equivalences', []):
            if eq['target'] not in ex_db:
                errors.append(f"[P3] equivalence target '{eq['target']}' missing (in {ex_id})")
        for r in ex.get('strength_ratio_vs', []):
            if r['reference'] not in ex_db:
                errors.append(f"[B.4] catalog_ratio_reference_missing: '{r['reference']}' (in {ex_id})")
    for h_name, h_ex in hubs.items():
        if h_name != 'global_hub' and h_ex not in ex_db:
            errors.append(f"[B.4] hub '{h_name}' → '{h_ex}' not in catalog")

    # ---- R1: ranges ----
    for ex_id, ex in ex_db.items():
        for field in ('mechanical_demand_index','technical_complexity_index'):
            v = ex.get(field)
            if v is None or not (0 <= v <= 10):
                errors.append(f"[R1] {ex_id}.{field}={v} outside [0,10]")
        for var in ex.get('variations', []):
            for dfield in ('mechanical_demand_delta','technical_complexity_delta'):
                d = var.get(dfield, 0)
                if not (-3 <= d <= 3):
                    errors.append(f"[R1] {ex_id}+{var['id']}.{dfield}={d} outside [-3,+3]")

    # ---- R2: effective demand in range ----
    for ex_id, ex in ex_db.items():
        for var in ex.get('variations', []):
            for base_f, delta_f in [('mechanical_demand_index','mechanical_demand_delta'),
                                     ('technical_complexity_index','technical_complexity_delta')]:
                eff = ex[base_f] + var.get(delta_f, 0)
                if not (0 <= eff <= 10):
                    errors.append(f"[R2] catalog_effective_demand_out_of_range: "
                                  f"{ex_id}+{var['id']} effective {base_f}={eff:.1f}")

    # ---- P1: edge demand monotonic ----
    for (s, t, mech, origin) in edges:
        ds, dt = demand(ex_db, *s) if s[0] in ex_db else None, \
                 demand(ex_db, *t) if t[0] in ex_db else None
        if ds is None or dt is None:
            continue  # already flagged by P3
        if dt <= ds:
            errors.append(f"[P1] catalog_edge_demand_inverted: {s} ({ds:.1f}) → {t} ({dt:.1f}) "
                          f"mechanism={mech} (at {origin})")

    # ---- P2: acyclicity (DFS over explicit edges) ----
    graph = defaultdict(list)
    for (s, t, _, _) in edges:
        graph[s].append(t)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = defaultdict(int)
    def dfs(u, path):
        color[u] = GRAY
        for v in graph[u]:
            if color[v] == GRAY:
                errors.append(f"[P2] catalog_progression_cycle_detected: {' → '.join(map(str,path+[v]))}")
                return
            if color[v] == WHITE:
                dfs(v, path+[v])
        color[u] = BLACK
    for n in list(graph.keys()):
        if color[n] == WHITE:
            dfs(n, [n])

    # ---- Equivalence symmetry conflicts ----
    eq_seen = {}
    for ex_id, ex in ex_db.items():
        for eq in ex.get('equivalences', []):
            key = tuple(sorted([ex_id, eq['target']]))
            if key in eq_seen and eq_seen[key] != eq.get('similarity'):
                errors.append(f"[B.2] catalog_equivalence_asymmetry_conflict: {key}")
            eq_seen[key] = eq.get('similarity')

    # ---- Informational: pattern/segment cross-check (flag, not error) ----
    pattern_segment = {'squat':'lower','hinge':'lower','lunge':'lower','push_h':'upper',
                       'push_v':'upper','pull_h':'upper','pull_v':'upper'}
    for ex_id, ex in ex_db.items():
        exp = pattern_segment.get(ex['movement_pattern'])
        if exp and ex['body_segment'] not in (exp, 'full'):
            warnings.append(f"[info] exercise_pattern_segment_mismatch: {ex_id} "
                            f"pattern={ex['movement_pattern']} segment={ex['body_segment']}")

    # ---- Report ----
    print("="*70)
    if errors:
        print(f"INTEGRITY ERRORS: {len(errors)} (catalog would NOT load)\n")
        for e in errors: print("  ✗", e)
    else:
        print("✓ ALL INTEGRITY CHECKS PASSED (P1, P2, P3, R1, R2, eq-symmetry)")
    if warnings:
        print(f"\nInformational flags: {len(warnings)}")
        for w in warnings: print("  ⚠", w)
    print("="*70)
    sys.exit(1 if errors else 0)

if __name__ == '__main__':
    main()
