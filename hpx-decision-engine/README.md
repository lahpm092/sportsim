# HPX · El motor de decisión

Webapp de una sola página que **resume visualmente** el concepto HPX para Grupo PRODI,
a partir de tres fuentes (en `../source-material/`):

- `documento-maestro-v3.md` — el performance lab (ciencia, benchmarks, modelo de negocio).
- `concepto-decision-intelligence-HPX.md` — un activo de datos, tres decisiones · HPX × Jamestown.
- `taxonomy-v2/` — el motor de prescripción del pilar físico (Taxonomía v2).

La explicación se conduce por las **visualizaciones**, no por el texto:

- **9 grafos causales dirigidos** (DAGs) que resumen los mecanismos de cada idea.
- **7 tests intuitivos** que enseñan el mecanismo al revelar la respuesta.
- Estética **sepia low-poly**: papel `#efe6d0`, tinta `#1c1712`, un solo acento oro
  `#a97b17`, tipografía serif, escultura low-poly (peón de ajedrez), grano de película y viñeta.
  El azul `#2e64b0` / rojo `#a13a24` aparecen sólo como acentos validados en los grafos.

## Ver

```bash
python3 -m http.server -d hpx-decision-engine 8778
# → http://localhost:8778/index.html
```

Parámetros útiles: `?all=1` revela todo sin scroll (revisión/impresión);
`#<sección>` enlaza a una sección (p. ej. `#adquisicion`).

## Estructura

```
index.html            cascarón + orden de scripts
assets/css/style.css  sistema visual (papel · tinta · oro · grano · viñeta)
assets/js/
  d3.v7.min.js        D3 vendorizado (offline, sin CDN)
  data.js             modelo de contenido: DAGS · TESTS · SECTIONS (toda la sustancia)
  lowpoly.js          grano, viñeta y escultura low-poly generativa (Delaunay)
  dag.js              renderizador de grafos causales (composición curada)
  tests.js            widgets de tests intuitivos (choice · classify)
  app.js              orquestación, scroll-reveal y navegación
```

Todo es estático y funciona offline (D3 vendorizado, tipografías del sistema).
