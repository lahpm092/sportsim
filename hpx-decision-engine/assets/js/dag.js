/* ============================================================================
   Renderizador de grafos causales dirigidos.
   Composición curada (posiciones a mano, no force-layout): editorial, no caótica.
   Nodos = tarjetas low-poly facetadas · aristas = trazos de tinta con punta.
   ========================================================================== */

let uid = 0;
const VW = 100;                     // ancho del viewBox
const FS_LABEL = 2.05, FS_SUB = 1.34, LH = 1.15;
const PAD_X = 1.7, PAD_Y = 1.35, MAXW = 30;

/* familia cromática por kind → {fill, facet, stroke, text, dash, op} */
function palette(kind) {
  const P = {
    asset:    { fill: "#e6cd93", facet: "#d8bd7e", stroke: "#a97b17", text: "#2a2109" },
    value:    { fill: "#efe6d0", facet: "#ecdcbb", stroke: "#a97b17", text: "#7a570f", strokeW: 0.42 },
    decision: { fill: "#efe6d0", facet: "#e7dcc2", stroke: "#1c1712", text: "#1c1712", accent: "#a97b17" },
    ink:      { fill: "#f3ecd9", facet: "#e9e0c9", stroke: "#33291d", text: "#1c1712" },
    frame:    { fill: "none",    facet: "none",    stroke: "#6b5c48", text: "#3a2f22", dash: "1.1 1.1" },
    blue:     { fill: "#d3ddee", facet: "#c3d1e7", stroke: "#2e64b0", text: "#1d3a63" },
    red:      { fill: "#e8ccc2", facet: "#dfc7bb", stroke: "#a13a24", text: "#5f2015" },
    muted:    { fill: "#eae1cb", facet: "#eae1cb", stroke: "#8a7c66", text: "#6b5c48", dash: "0.9 0.9", op: 0.62, italic: true },
    field:    { fill: "#f3ecd9", facet: "#e9e0c9", stroke: "#33291d", text: "#1c1712", corner: "#a97b17" },
  };
  return P[kind] || P.ink;
}

/* Corta la línea centro→dir contra la caja (hw,hh) del nodo */
function boxEdge(cx, cy, hw, hh, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

/* Envuelve texto en varias líneas ≤ maxW (unidades de viewBox).
   Mide con un tspan sonda, luego escribe los tspans reales (uno por línea). */
function wrapWords(textSel, words, maxW, fs) {
  const lines = [];
  let cur = [];
  textSel.text(null);
  const probe = textSel.append("tspan").attr("x", 0).attr("y", 0).style("visibility", "hidden");
  for (const w of words) {
    cur.push(w);
    probe.text(cur.join(" "));
    if (probe.node().getComputedTextLength() > maxW && cur.length > 1) {
      cur.pop();
      lines.push(cur.join(" "));
      cur = [w];
    }
  }
  if (cur.length) lines.push(cur.join(" "));
  probe.remove();
  lines.forEach(line => textSel.append("tspan").attr("x", 0).text(line));
  return lines;
}

function renderDAG(container, spec) {
  container.innerHTML = "";
  const H = spec.h;
  const svg = d3.select(container).append("svg")
    .attr("viewBox", `0 0 ${VW} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .attr("class", "dag-svg");

  const defs = svg.append("defs");
  defs.html(`
    <radialGradient id="figGlow"><stop offset="0" stop-color="#00000022"/><stop offset="1" stop-color="#00000000"/></radialGradient>
    <marker id="ah-${uid}" markerWidth="7" markerHeight="7" refX="5.4" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0.4,0.6 L5.6,3 L0.4,5.4 L1.8,3 Z" fill="#2a2016"/>
    </marker>
    <marker id="ahg-${uid}" markerWidth="7" markerHeight="7" refX="5.4" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0.4,0.6 L5.6,3 L0.4,5.4 L1.8,3 Z" fill="#a97b17"/>
    </marker>
    <marker id="ahf-${uid}" markerWidth="6.5" markerHeight="6.5" refX="5" refY="2.8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0.6,0.8 L5.2,2.8 L0.6,4.8 L1.8,2.8 Z" fill="#8a7c66"/>
    </marker>`);
  const AH = `url(#ah-${uid})`, AHG = `url(#ahg-${uid})`, AHF = `url(#ahf-${uid})`;
  uid++;

  // Decoración radial (volante): anillo tenue punteado
  if (spec.radial) {
    const cx = 50, cy = H / 2 + 1;
    svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", Math.min(cx, cy) * 0.82)
      .attr("fill", "none").attr("stroke", "#8a7c66").attr("stroke-width", 0.15)
      .attr("stroke-dasharray", "0.6 1.4").attr("opacity", 0.5).attr("class", "reveal-fade");
  }

  const edgeLayer = svg.append("g").attr("class", "edges");
  const nodeLayer = svg.append("g").attr("class", "nodes");

  // --- Nodos: medir texto, luego dibujar tarjeta facetada detrás ----------
  const geo = {};
  const nodeOrder = [];
  spec.nodes.forEach((n, i) => {
    const g = nodeLayer.append("g")
      .attr("class", "node reveal-node")
      .style("--i", i)
      .attr("transform", `translate(${n.x},${n.y})`);

    // encabezados de columna (pipeline): etiqueta suelta, sin caja
    if (n.head) {
      g.append("text").attr("class", "col-head").attr("text-anchor", "middle")
        .attr("y", 0).attr("font-size", 1.5).text(n.label);
      geo[n.id] = { x: n.x, y: n.y, hw: 0, hh: 0, head: true };
      nodeOrder.push(g);
      return;
    }

    const p = palette(n.kind);
    const label = g.append("text").attr("class", "node-label").attr("text-anchor", "middle")
      .attr("font-size", FS_LABEL).attr("fill", p.text);
    if (p.italic) label.attr("font-style", "italic");
    const labelLines = wrapWords(label, n.label.split(" "), MAXW, FS_LABEL);

    let subLines = [];
    let sub = null;
    if (n.sub) {
      sub = g.append("text").attr("class", "node-sub").attr("text-anchor", "middle")
        .attr("font-size", FS_SUB).attr("fill", p.text);
      subLines = wrapWords(sub, n.sub.split(" "), MAXW + 3, FS_SUB);
    }

    // ancho de la tarjeta = texto más largo + padding
    let maxLen = 0;
    label.selectAll("tspan").each(function () { maxLen = Math.max(maxLen, this.getComputedTextLength()); });
    if (sub) sub.selectAll("tspan").each(function () { maxLen = Math.max(maxLen, this.getComputedTextLength()); });
    const w = maxLen + PAD_X * 2;
    const nLab = labelLines.length, nSub = subLines.length;
    const textH = nLab * FS_LABEL * LH + (nSub ? 0.5 + nSub * FS_SUB * LH : 0);
    const h = textH + PAD_Y * 2;
    const hw = w / 2, hh = h / 2;

    // posicionar líneas verticalmente centradas
    let ty = -textH / 2 + FS_LABEL * 0.82;
    label.attr("y", 0).selectAll("tspan").attr("x", 0)
      .attr("y", (d, k) => ty + k * FS_LABEL * LH);
    if (sub) {
      const sy = -textH / 2 + nLab * FS_LABEL * LH + 0.5 + FS_SUB * 0.82;
      sub.attr("y", 0).selectAll("tspan").attr("x", 0)
        .attr("y", (d, k) => sy + k * FS_SUB * LH);
    }

    // tarjeta facetada low-poly (octágono biselado, dividido en dos facetas)
    const bev = Math.min(1.4, hh * 0.7);
    const outline = [
      [-hw + bev, -hh], [hw - bev, -hh], [hw, -hh + bev], [hw, hh - bev],
      [hw - bev, hh], [-hw + bev, hh], [-hw, hh - bev], [-hw, -hh + bev],
    ];
    const dPath = "M" + outline.map(pt => pt.join(",")).join("L") + "Z";
    const card = g.insert("g", ":first-child").attr("class", "card").style("opacity", p.op ?? 1);
    if (p.fill !== "none") {
      // faceta base
      card.append("path").attr("d", dPath).attr("fill", p.fill);
      // faceta diagonal (media inferior más oscura) → sensación low-poly
      card.append("path")
        .attr("d", `M${-hw},${-hh + bev}L${hw},${hh - bev}L${hw - bev},${hh}L${-hw + bev},${hh}L${-hw},${hh - bev}Z`)
        .attr("fill", p.facet).attr("opacity", 0.85);
    }
    card.append("path").attr("d", dPath).attr("fill", "none")
      .attr("stroke", p.stroke).attr("stroke-width", p.strokeW || 0.3)
      .attr("stroke-dasharray", p.dash || null);

    // barra de acento (decisiones) / esquina dorada (field) / doble borde (value)
    if (p.accent) card.append("rect").attr("x", -hw).attr("y", -hh * 0.55).attr("width", 0.55)
      .attr("height", hh * 1.1).attr("fill", p.accent);
    if (p.corner) card.append("path").attr("d", `M${hw - 2.4},${-hh}L${hw},${-hh}L${hw},${-hh + 2.4}Z`).attr("fill", p.corner);
    if (n.kind === "value") card.append("path").attr("d",
      "M" + outline.map(pt => [pt[0] * 0.9, pt[1] * 0.78].join(",")).join("L") + "Z")
      .attr("fill", "none").attr("stroke", p.stroke).attr("stroke-width", 0.15).attr("opacity", 0.7);

    geo[n.id] = { x: n.x, y: n.y, hw, hh };
    nodeOrder.push(g);
  });

  // --- Aristas -------------------------------------------------------------
  const edgePaths = [];
  (spec.edges || []).forEach((e, i) => {
    const A = geo[e.from], B = geo[e.to];
    if (!A || !B) return;
    const feedback = e.kind === "feedback";
    const [ax, ay] = boxEdge(A.x, A.y, A.hw + 0.3, A.hh + 0.3, B.x, B.y);
    const [bx, by] = boxEdge(B.x, B.y, B.hw + 0.3, B.hh + 0.3, A.x, A.y);
    // punto de control: punto medio + normal * curvatura
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let cxv = mx, cyv = my;
    const curve = e.curve || 0;
    if (curve) {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      cxv = mx + (-dy / len) * curve * 0.5;
      cyv = my + (dx / len) * curve * 0.5;
    }
    const d = `M${ax},${ay} Q${cxv},${cyv} ${bx},${by}`;
    const path = edgeLayer.append("path")
      .attr("class", "edge reveal-edge" + (feedback ? " edge-feedback" : ""))
      .attr("d", d)
      .attr("fill", "none")
      .attr("stroke", feedback ? "#8a7c66" : "#2a2016")
      .attr("stroke-width", feedback ? 0.18 : 0.26)
      .attr("stroke-dasharray", feedback ? "0.9 0.8" : null)
      .attr("marker-end", feedback ? AHF : (e.gold ? AHG : AH))
      .style("--i", i);
    const L = path.node().getTotalLength();
    // guardar longitud real para animación (respetando dash de feedback)
    path.attr("data-len", L);
    edgePaths.push({ path, L, feedback });

    if (e.dashLabel || e.label) {
      edgeLayer.append("text").attr("class", "edge-label reveal-fade")
        .attr("x", cxv).attr("y", cyv - 0.4).attr("text-anchor", "middle")
        .attr("font-size", 1.15).text(e.dashLabel || e.label);
    }
  });

  // nota de retroalimentación (activo que se revaloriza)
  if (spec.feedbackNote) {
    svg.append("text").attr("class", "edge-label feedback-note reveal-fade")
      .attr("x", 50).attr("y", H - 0.6).attr("text-anchor", "middle")
      .attr("font-size", 1.2).attr("fill", "#8a6212")
      .text("↺  " + spec.feedbackNote);
  }

  // Estado inicial oculto para animar al entrar en viewport
  edgePaths.forEach(({ path, L, feedback }) => {
    if (feedback) { path.style("opacity", 0); }
    else { path.style("stroke-dasharray", L).style("stroke-dashoffset", L); }
  });

  return {
    play() {
      nodeOrder.forEach((g, i) => setTimeout(() => g.classed("in", true), 60 + i * 55));
      const base = 60 + nodeOrder.length * 55;
      edgePaths.forEach(({ path, L, feedback }, i) => {
        setTimeout(() => {
          if (feedback) {
            path.style("opacity", 1).style("transition", "opacity .7s ease");
          } else {
            path.style("transition", "stroke-dashoffset 0.85s cubic-bezier(.4,.0,.2,1)")
              .style("stroke-dashoffset", 0);
          }
        }, base + i * 70);
      });
      svg.selectAll(".reveal-fade").each(function (d, i) {
        const el = this; setTimeout(() => d3.select(el).classed("in", true), base + 250 + i * 60);
      });
    },
  };
}

window.DAG = { renderDAG };
