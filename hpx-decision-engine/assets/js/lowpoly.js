/* ============================================================================
   Motor estético — grano de película, viñeta y escultura low-poly generativa.
   Paleta: papel #efe6d0 · tinta #1c1712 · oro #a97b17 · azul #2e64b0 · rojo #a13a24
   ========================================================================== */

const INK_SHADES = ["#1c1712", "#241d16", "#2e251b", "#3a2f22", "#463829", "#544433"];
const GOLD = "#a97b17";
const GOLD_DK = "#8a6212";

/* --- Grano + viñeta: overlays fijos a pantalla completa ------------------- */
function installGrainAndVignette() {
  if (document.getElementById("grain-overlay")) return;

  // Grano: feTurbulence renderizado una vez a un <svg> fijo, blend multiply.
  const grain = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  grain.setAttribute("id", "grain-overlay");
  grain.innerHTML = `
    <filter id="filmGrain">
      <feTurbulence type="fractalNoise" baseFrequency="0.86" numOctaves="2" stitchTiles="stitch" seed="7"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.9 0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#filmGrain)"/>`;
  document.body.appendChild(grain);

  const vig = document.createElement("div");
  vig.id = "vignette-overlay";
  document.body.appendChild(vig);
}

/* --- Utilidades geométricas ---------------------------------------------- */
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Ruido determinista [0,1) a partir de dos enteros
function hash2(a, b) {
  let h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/* Silueta de peón de ajedrez (media derecha, se refleja). x∈[0,~.36] y∈[0,1.16] */
const PAWN_HALF = [
  [0.00, 0.00], [0.15, 0.05], [0.215, 0.15], [0.17, 0.25], [0.075, 0.315],
  [0.115, 0.355], [0.185, 0.40], [0.095, 0.445], [0.072, 0.60], [0.10, 0.80],
  [0.155, 0.95], [0.29, 1.015], [0.36, 1.10], [0.36, 1.16], [0.00, 1.16],
];

function pawnOutline() {
  const right = PAWN_HALF.slice();
  const left = PAWN_HALF.slice(1, -1).reverse().map(([x, y]) => [-x, y]);
  return right.concat(left);
}

/* --- Escultura low-poly: triangulación Delaunay rellena y facetada -------- */
function lowPolyFigure(svg, opts = {}) {
  const { cx = 0, cy = 0, scale = 1, seed = 3, glow = true } = opts;
  const outline = pawnOutline();
  const g = svg.append("g").attr("class", "lowpoly-figure")
    .attr("transform", `translate(${cx},${cy}) scale(${scale})`);

  // halo suave de papel bajo la figura
  if (glow) {
    g.append("ellipse").attr("cx", 0).attr("cy", 0.58).attr("rx", 0.5).attr("ry", 0.62)
      .attr("fill", "url(#figGlow)").attr("opacity", 0.5);
  }

  // Muestreo interior en malla con jitter + puntos de contorno
  const pts = outline.map(p => p.slice());
  const step = 0.085;
  let k = 0;
  for (let y = 0.02; y < 1.16; y += step) {
    for (let x = -0.4; x < 0.4; x += step) {
      const jx = x + (hash2(k, seed) - 0.5) * step * 0.9;
      const jy = y + (hash2(k, seed + 99) - 0.5) * step * 0.9;
      k++;
      if (pointInPolygon(jx, jy, outline)) pts.push([jx, jy]);
    }
  }

  const del = d3.Delaunay.from(pts);
  const { triangles } = del;
  const centerY = 0.55;

  for (let t = 0; t < triangles.length; t += 3) {
    const a = pts[triangles[t]], b = pts[triangles[t + 1]], c = pts[triangles[t + 2]];
    const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3;
    if (!pointInPolygon(mx, my, outline)) continue;

    // "iluminación" fingida: caras arriba-izquierda más claras + jitter estable
    const light = 0.5 + (-mx * 0.6) + (-(my - centerY) * 0.55);
    const jitter = (hash2((mx * 50) | 0, (my * 50) | 0) - 0.5) * 0.9;
    let idx = Math.round((1 - Math.max(0, Math.min(1, light))) * (INK_SHADES.length - 1) + jitter);
    idx = Math.max(0, Math.min(INK_SHADES.length - 1, idx));
    let fill = INK_SHADES[idx];

    // un par de facetas doradas en la cabeza = el acento único (la "bola")
    const inHead = my < 0.24 && Math.abs(mx) < 0.2;
    if (inHead && hash2((mx * 90) | 0, (my * 90) | 0) > 0.72) fill = hash2(t, 1) > 0.5 ? GOLD : GOLD_DK;

    g.append("path")
      .attr("d", `M${a[0]},${a[1]}L${b[0]},${b[1]}L${c[0]},${c[1]}Z`)
      .attr("fill", fill)
      .attr("stroke", "#efe6d0")
      .attr("stroke-width", 0.004)
      .attr("stroke-opacity", 0.5)
      .attr("class", "facet");
  }
  return g;
}

/* Pequeña marca low-poly (rombo facetado) para divisores/acentos */
function lowPolyMark(svg, x, y, r, gold) {
  const g = svg.append("g").attr("transform", `translate(${x},${y})`);
  const pts = [[0, -r], [r * 0.86, 0], [0, r], [-r * 0.86, 0]];
  const tris = [[0, 1, 2], [0, 2, 3]];
  tris.forEach((tri, i) => {
    const p = tri.map(j => pts[j]);
    g.append("path")
      .attr("d", `M${p[0]}L${p[1]}L${p[2]}Z`)
      .attr("fill", gold ? (i ? GOLD_DK : GOLD) : (i ? INK_SHADES[3] : INK_SHADES[1]))
      .attr("stroke", "#efe6d0").attr("stroke-width", r * 0.03);
  });
  return g;
}

window.LP = { installGrainAndVignette, lowPolyFigure, lowPolyMark, INK_SHADES, GOLD, GOLD_DK };
