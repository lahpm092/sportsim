/* ============================================================================
   Tests intuitivos — componentes interactivos que enseñan el mecanismo al revelar.
   Tipos: choice (una respuesta + explicación) · classify (clasificar en cubetas)
   Todo en HTML (no SVG) para texto/interacción; estilo en style.css.
   ========================================================================== */

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

function renderTest(container, spec) {
  container.innerHTML = "";
  const wrap = el("div", "test");
  wrap.appendChild(el("div", "test-tag", "Test intuitivo"));
  wrap.appendChild(el("p", "test-prompt", spec.prompt));

  if (spec.kind === "choice") renderChoice(wrap, spec);
  else if (spec.kind === "classify") renderClassify(wrap, spec);

  container.appendChild(wrap);
}

/* --- choice --------------------------------------------------------------- */
function renderChoice(wrap, spec) {
  const list = el("div", "opts");
  let answered = false;
  const why = el("div", "why");

  spec.options.forEach(opt => {
    const b = el("button", "opt");
    const row = el("span", "opt-row");
    row.appendChild(el("span", "opt-mark", ""));
    row.appendChild(el("span", "opt-t", opt.t));
    b.appendChild(row);

    b.addEventListener("click", () => {
      // permitir explorar: siempre muestra la explicación de la opción tocada,
      // y sella la correcta/incorrecta una vez elegida.
      list.querySelectorAll(".opt").forEach(o => o.classList.remove("picked"));
      b.classList.add("picked");
      if (!answered) {
        answered = true;
        list.querySelectorAll(".opt").forEach((o, k) => {
          o.classList.add("resolved");
          o.classList.toggle("correct", spec.options[k].ok);
          o.classList.toggle("wrong", !spec.options[k].ok);
        });
        wrap.classList.add("done");
      }
      why.innerHTML = "";
      const verdict = el("span", "verdict " + (opt.ok ? "ok" : "no"), opt.ok ? "Correcto — " : "No — ");
      const p = el("p", "why-p");
      p.appendChild(verdict);
      p.appendChild(document.createTextNode(opt.why));
      why.appendChild(p);
      why.classList.add("in");
    });
    list.appendChild(b);
  });

  wrap.appendChild(list);
  wrap.appendChild(why);
}

/* --- classify ------------------------------------------------------------- */
function renderClassify(wrap, spec) {
  const assign = {};                 // item index → bucket id
  const grid = el("div", "cls-grid");

  spec.items.forEach((item, i) => {
    const row = el("div", "cls-row");
    row.appendChild(el("span", "cls-item", item.t));
    const btns = el("span", "cls-btns");
    spec.buckets.forEach(bk => {
      const b = el("button", "cls-b", bk.t);
      b.addEventListener("click", () => {
        assign[i] = bk.id;
        btns.querySelectorAll(".cls-b").forEach(x => x.classList.remove("sel"));
        b.classList.add("sel");
        row.dataset.assigned = "1";
        updateCheck();
      });
      btns.appendChild(b);
    });
    row.appendChild(btns);
    grid.appendChild(row);
  });
  wrap.appendChild(grid);

  const bar = el("div", "cls-bar");
  const check = el("button", "cls-check", "Comprobar");
  check.disabled = true;
  const done = el("p", "cls-done");
  bar.appendChild(check);
  wrap.appendChild(bar);
  wrap.appendChild(done);

  function updateCheck() {
    check.disabled = Object.keys(assign).length < spec.items.length;
  }

  let revealed = false;
  check.addEventListener("click", () => {
    if (revealed) {                    // Reintentar — reinicia en el sitio
      revealed = false;
      for (const k in assign) delete assign[k];
      grid.querySelectorAll(".cls-row").forEach(row => {
        row.classList.remove("resolved", "right", "wrong");
        delete row.dataset.assigned;
        row.querySelectorAll(".cls-b").forEach(b => b.classList.remove("sel", "truth"));
      });
      done.classList.remove("in");
      wrap.classList.remove("done");
      check.textContent = "Comprobar";
      updateCheck();
      return;
    }
    grid.querySelectorAll(".cls-row").forEach((row, i) => {
      const ok = assign[i] === spec.items[i].bucket;
      row.classList.add("resolved");
      row.classList.toggle("right", ok);
      row.classList.toggle("wrong", !ok);
      const correctT = spec.buckets.find(b => b.id === spec.items[i].bucket).t;
      row.querySelectorAll(".cls-b").forEach(btn => {
        btn.classList.toggle("truth", btn.textContent === correctT);
      });
    });
    done.textContent = spec.done;
    done.classList.add("in");
    wrap.classList.add("done");
    check.textContent = "Reintentar";
    revealed = true;
  });
}

window.TEST = { renderTest };
