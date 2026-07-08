# Training Taxonomy v2

Sistema formal de taxonomía de entrenamiento anaeróbico/resistencia: prescripción, validación, autorregulación y periodización — diseñado como fundación para generación automática de rutinas (v3).

**Estado: diseño completo (Capas A+B+C+D cerradas).** Ver `PROJECT_STATE.md` para el estado vivo, decisiones e índice completo.

## Estructura

- `methods/` — Capa A: 9 métodos, 40 variantes, drift rules
- `catalog/` — Capa B: 98 ejercicios, grafo de progresión, strength ratios
- `autoregulation/` — Capa C: señales, 29 reglas de ajuste, fatiga, deload
- `periodization/` — Capa D: templates, 5 modelos, macro/eventos/taper
- `flag_catalog.yaml` — 164 flags transversales
- `docs/` — manuales humanos por capa + especificación de 87 funciones
- `tools/` — validadores ejecutables (catálogo e integridad de macros)
- `examples/` — templates validados, macro HYROX de muestra, explorador interactivo

## Validación

```bash
python3 tools/validate_catalog.py catalog/catalog_seed_part1.yaml catalog/catalog_seed_part2.yaml
python3 tools/validate_macro.py examples/macrocycle_hyrox_sample.yaml examples/template_examples.yaml
```
