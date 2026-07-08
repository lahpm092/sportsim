/* ============================================================================
   Orquestación — construye el documento desde el modelo de contenido,
   monta grafos y tests, y dispara revelaciones al hacer scroll.
   ========================================================================== */

/* DAGS · TESTS · SECTIONS · BENCHMARKS · ASSETS_ROW son bindings globales
   declarados en data.js (scripts clásicos comparten el ámbito léxico global);
   se usan directamente — redeclararlos aquí sería un SyntaxError. */
const mk = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

document.addEventListener("DOMContentLoaded", () => {
  LP.installGrainAndVignette();
  const main = document.getElementById("main");
  const rail = document.getElementById("rail");
  const dagControllers = {};

  SECTIONS.forEach((s, idx) => {
    const sec = mk("section", "chapter chapter-" + s.kind);
    sec.id = s.id;
    sec.dataset.idx = idx;
    const inner = mk("div", "chapter-inner");
    sec.appendChild(inner);

    if (s.kind === "hero") {
      buildHero(inner, s);
    } else {
      const head = mk("header", "chap-head");
      head.appendChild(mk("div", "eyebrow reveal", s.eyebrow));
      head.appendChild(mk("h2", "chap-title reveal", s.title));
      if (s.body) head.appendChild(mk("p", "chap-body reveal", s.body));
      inner.appendChild(head);
    }

    // Grafo causal
    if (s.dag) {
      const wrap = mk("figure", "dag-wrap reveal");
      const mount = mk("div", "dag-mount");
      wrap.appendChild(mount);
      if (DAGS[s.dag].caption) {
        const cap = mk("figcaption", "dag-caption");
        cap.appendChild(mk("span", "cap-mark", "▸ "));
        cap.appendChild(document.createTextNode(DAGS[s.dag].caption));
        wrap.appendChild(cap);
      }
      inner.appendChild(wrap);
      dagControllers[s.id] = DAG.renderDAG(mount, DAGS[s.dag]);
    }

    // Tiras editoriales por sección
    if (s.id === "volante") inner.appendChild(buildRow("Activos que HPX productiza e integra", ASSETS_ROW));
    if (s.id === "corazon") inner.appendChild(buildRow("Benchmarks · un principio rector de cada uno", BENCHMARKS));
    if (s.roadmap) inner.appendChild(buildRoadmap(s.roadmap));

    // Tests intuitivos
    if (s.test) { const m = mk("div", "test-mount reveal"); inner.appendChild(m); TEST.renderTest(m, TESTS[s.test]); }
    if (s.test2) { const m = mk("div", "test-mount reveal"); inner.appendChild(m); TEST.renderTest(m, TESTS[s.test2]); }

    // Cierre
    if (s.close) {
      const c = mk("blockquote", "closing reveal");
      c.appendChild(mk("span", "close-mark", ""));
      c.appendChild(document.createTextNode(s.close));
      inner.appendChild(c);
    }

    main.appendChild(sec);

    // Punto de navegación
    const dot = mk("a", "dot");
    dot.href = "#" + s.id;
    dot.setAttribute("aria-label", s.title || "Portada");
    dot.appendChild(mk("span", "dot-label", s.title || "Portada"));
    dot.addEventListener("click", e => { e.preventDefault(); document.getElementById(s.id).scrollIntoView({ behavior: "smooth" }); });
    rail.appendChild(dot);
  });

  buildFooter(main);

  // --- Revelaciones y navegación por scroll --------------------------------
  const dots = [...rail.querySelectorAll(".dot")];
  const chapters = [...main.querySelectorAll(".chapter")];

  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        en.target.classList.add("visible");
        const id = en.target.id;
        if (dagControllers[id] && !dagControllers[id]._played) {
          dagControllers[id]._played = true;
          dagControllers[id].play();
        }
      }
    });
  }, { threshold: 0.22 });
  chapters.forEach(c => io.observe(c));

  // punto activo = capítulo más centrado
  const spy = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const i = +en.target.dataset.idx;
        dots.forEach((d, k) => d.classList.toggle("active", k === i));
      }
    });
  }, { threshold: 0.5, rootMargin: "-20% 0px -20% 0px" });
  chapters.forEach(c => spy.observe(c));

  // barra de progreso de lectura
  const bar = document.getElementById("progress");
  const onScroll = () => {
    const h = document.documentElement;
    const p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
    bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Modo revelar-todo (?all=1) — para revisión/impresión sin depender del scroll
  if (new URLSearchParams(location.search).has("all")) {
    document.body.classList.add("show-all");
    Object.values(dagControllers).forEach(c => { if (!c._played) { c._played = true; c.play(); } });
  }

  // Enlaces profundos: las secciones se construyen en JS, así que el scroll al
  // hash inicial hay que dispararlo una vez montado el documento.
  if (location.hash) {
    const t = document.getElementById(location.hash.slice(1));
    if (t) requestAnimationFrame(() => t.scrollIntoView());
  }
});

/* --- Portada -------------------------------------------------------------- */
function buildHero(inner, s) {
  inner.classList.add("hero-inner");
  const left = mk("div", "hero-copy");
  left.appendChild(mk("div", "eyebrow reveal", s.eyebrow));
  left.appendChild(mk("h1", "hero-title reveal", s.title));
  left.appendChild(mk("p", "hero-lede reveal", s.lede));
  const thesis = mk("p", "hero-thesis reveal");
  thesis.appendChild(mk("span", "thesis-mark", "La tesis  "));
  thesis.appendChild(document.createTextNode(s.thesis));
  left.appendChild(thesis);
  const cue = mk("div", "scroll-cue reveal");
  cue.appendChild(mk("span", null, "Desliza para leer el tablero"));
  cue.appendChild(mk("span", "cue-line", ""));
  left.appendChild(cue);

  const right = mk("div", "hero-figure reveal");
  const svg = d3.select(right).append("svg")
    .attr("viewBox", "-0.62 -0.06 1.24 1.30")
    .attr("class", "figure-svg")
    .attr("preserveAspectRatio", "xMidYMid meet");
  const defs = svg.append("defs");
  defs.html(`<radialGradient id="figGlow"><stop offset="0" stop-color="#1c171238"/><stop offset="0.7" stop-color="#1c171210"/><stop offset="1" stop-color="#1c171200"/></radialGradient>`);
  LP.lowPolyFigure(svg, { cx: 0, cy: 0, scale: 1, seed: 5 });

  inner.appendChild(left);
  inner.appendChild(right);
}

/* --- Tira de tarjetas (activos / benchmarks) ------------------------------ */
function buildRow(title, items) {
  const box = mk("div", "strip reveal");
  box.appendChild(mk("div", "strip-title", title));
  const row = mk("div", "strip-row");
  items.forEach(it => {
    const c = mk("div", "strip-card");
    c.appendChild(mk("div", "strip-n", it.n));
    c.appendChild(mk("div", "strip-p", it.p));
    row.appendChild(c);
  });
  box.appendChild(row);
  return box;
}

/* --- Línea de tiempo del roadmap ------------------------------------------ */
function buildRoadmap(phases) {
  const box = mk("div", "roadmap reveal");
  box.appendChild(mk("div", "strip-title", "Roadmap de implementación"));
  const line = mk("div", "rm-line");
  phases.forEach(ph => {
    const c = mk("div", "rm-phase");
    const num = mk("div", "rm-num");
    num.appendChild(mk("span", null, ph.p));
    c.appendChild(num);
    c.appendChild(mk("div", "rm-t", ph.t));
    c.appendChild(mk("div", "rm-h", ph.h));
    c.appendChild(mk("div", "rm-d", ph.d));
    line.appendChild(c);
  });
  box.appendChild(line);
  return box;
}

/* --- Pie ------------------------------------------------------------------ */
function buildFooter(main) {
  const f = mk("footer", "site-foot");
  const inner = mk("div", "foot-inner");
  inner.appendChild(mk("div", "foot-mark", "HPX"));
  const p = mk("p", "foot-p");
  p.innerHTML = "Síntesis visual de <em>documento-maestro-v3</em>, <em>concepto-decision-intelligence-HPX</em> y el motor <em>Taxonomía v2</em>. " +
    "Documento de trabajo · Fase 1 · piloto Atlas. Los grafos resumen los mecanismos causales; no reemplazan los documentos fuente.";
  inner.appendChild(p);
  inner.appendChild(mk("div", "foot-tag", "La ciencia detrás del rendimiento."));
  f.appendChild(inner);
  main.appendChild(f);
}
