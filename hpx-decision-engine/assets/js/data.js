/* ============================================================================
   HPX · Motor de decisión — Modelo de contenido
   Toda la sustancia de los tres documentos fuente, codificada como:
     · DAGS   — grafos causales dirigidos (nodos con posición curada + aristas)
     · TESTS  — tests intuitivos cortos (mecanismo enseñado al revelar)
     · SECTIONS — hilo narrativo mínimo (la explicación vive en las visualizaciones)
   Fuentes: documento-maestro-v3.md · concepto-decision-intelligence-HPX.md · taxonomy-v2
   ========================================================================== */

/* --- Grafos causales ------------------------------------------------------ *
 * Coordenadas normalizadas: x,y en un lienzo 100 × (h). y crece hacia abajo.
 * kind → familia cromática (ver dag.js): asset · decision · ink · blue · red ·
 *        muted · field · frame · value
 * Aristas: kind solid|feedback|converge ; curve = curvatura lateral (± / 0).  */

const DAGS = {

  /* 1 · UN ACTIVO, TRES DECISIONES — el reencuadre central ------------------ */
  engine: {
    h: 72,
    caption: "Un solo activo de datos —el atleta medido en su contexto— alimenta las tres decisiones que mueven el valor de un club. Cada decisión, a su vez, enriquece la misma ficha: el activo se revaloriza con el uso.",
    nodes: [
      { id: "ctx",  x: 50, y: 8,  kind: "frame",    label: "Medido en contexto", sub: "no en un lab aislado" },
      { id: "asset",x: 50, y: 27, kind: "asset",    label: "Ficha del atleta · 360°", sub: "físico · médico · nutrición · visión · carga · desarrollo" },
      { id: "d1",   x: 17, y: 52, kind: "decision", label: "1 · Rendimiento", sub: "entrenar · prevenir · rehabilitar · desarrollar" },
      { id: "d2",   x: 50, y: 52, kind: "decision", label: "2 · Táctica", sub: "minutaje · rotación · lectura del rival" },
      { id: "d3",   x: 83, y: 52, kind: "decision", label: "3 · Adquisición", sub: "a quién fichar · con qué riesgo" },
      { id: "val",  x: 50, y: 68, kind: "value",    label: "Valor del club", sub: "activo patrimonial que compone" },
    ],
    edges: [
      { from: "ctx",  to: "asset" },
      { from: "asset",to: "d1" }, { from: "asset", to: "d2" }, { from: "asset", to: "d3" },
      { from: "d1", to: "val" }, { from: "d2", to: "val" }, { from: "d3", to: "val" },
      { from: "d1", to: "asset", kind: "feedback", curve: -34 },
      { from: "d3", to: "asset", kind: "feedback", curve:  34 },
    ],
    feedbackNote: "genera dato propietario → enriquece la ficha",
  },

  /* 2 · LA TESIS COMPUESTA — el volante (la única ciclicidad intencional) ---- */
  flywheel: {
    h: 62, radial: true,
    caption: "La ventaja de «tener datos» se erosiona cuando todos los tienen. La sostenible es un volante: dato propietario → mejor decisión → más valor → más equipos que medir. El único ciclo que buscamos.",
    nodes: [
      { id: "acq",  x: 50, y: 9,  kind: "ink",   label: "Adquirir equipo", sub: "Atlas · Pericos · golf · futuros" },
      { id: "inst", x: 84, y: 31, kind: "ink",   label: "Instalar HPX", sub: "línea base + integración" },
      { id: "meas", x: 71, y: 54, kind: "asset", label: "Medir en contexto", sub: "dato propietario in-house" },
      { id: "dec",  x: 29, y: 54, kind: "decision", label: "Mejor decisión", sub: "rendimiento · táctica · fichajes" },
      { id: "value",x: 16, y: 31, kind: "value", label: "Más valor", sub: "costo marginal decreciente" },
    ],
    edges: [
      { from: "acq", to: "inst", curve: 14 }, { from: "inst", to: "meas", curve: 14 },
      { from: "meas", to: "dec", curve: 14 }, { from: "dec", to: "value", curve: 14 },
      { from: "value", to: "acq", curve: 14 },
    ],
  },

  /* 3 · EL ATLETA EN CONTEXTO — el cimiento científico --------------------- */
  context: {
    h: 74,
    caption: "El rendimiento no es un rasgo que el atleta «tiene»: emerge de la relación atleta–entorno. Tres marcos convergentes lo sustentan y se operan en dos capas complementarias, no rivales.",
    nodes: [
      { id: "eco",  x: 15, y: 9,  kind: "frame", label: "Psicología ecológica", sub: "Gibson · affordances" },
      { id: "dyn",  x: 50, y: 7,  kind: "frame", label: "Sistemas dinámicos", sub: "auto-organización" },
      { id: "new",  x: 85, y: 9,  kind: "frame", label: "Constraints · Newell", sub: "organismo · tarea · entorno" },
      { id: "emerge",x: 50, y: 28, kind: "asset", label: "El rendimiento emerge", sub: "de la relación atleta–entorno" },
      { id: "measure",x: 50, y: 44, kind: "ink", label: "Medir en el contexto real de juego", sub: "" },
      { id: "org",  x: 24, y: 62, kind: "decision", label: "Capa · Organismo", sub: "Taxonomía v2 — fuerza, potencia, recuperación" },
      { id: "task", x: 76, y: 62, kind: "decision", label: "Capa · Tarea–entorno", sub: "Constraint-Led Approach · diseño representativo" },
    ],
    edges: [
      { from: "eco", to: "emerge", curve: 8 }, { from: "dyn", to: "emerge" }, { from: "new", to: "emerge", curve: -8 },
      { from: "emerge", to: "measure" },
      { from: "measure", to: "org", curve: -10 }, { from: "measure", to: "task", curve: 10 },
    ],
  },

  /* 4 · HONESTIDAD — qué señal de proceso es medible en campo --------------- */
  measurable: {
    h: 66,
    caption: "No todo lo del laboratorio transfiere al campo. HPX declara qué señales de proceso son hoy viables con sensores de campo y cuáles siguen siendo solo-laboratorio. No prometemos medir en cancha lo que solo el lab resuelve.",
    nodes: [
      { id: "sig",  x: 50, y: 9,  kind: "ink",   label: "Señal de proceso", sub: "variabilidad, coordinación, fatiga" },
      { id: "ent",  x: 18, y: 34, kind: "field", label: "Entropía", sub: "1–2 IMU · sitio L5" },
      { id: "vec",  x: 41, y: 34, kind: "field", label: "Vector coding sagital", sub: "carrera · RTP" },
      { id: "mark", x: 64, y: 34, kind: "field", label: "Coordinación markerless", sub: "inter-atleta" },
      { id: "ucm",  x: 84, y: 30, kind: "muted", label: "UCM / sinergias", sub: "solo laboratorio" },
      { id: "rot",  x: 84, y: 44, kind: "muted", label: "Rotacional · distal", sub: "solo laboratorio" },
      { id: "auto", x: 41, y: 58, kind: "asset", label: "Autorregulación de la Taxonomía", sub: "señal objetiva → ajuste de carga" },
    ],
    edges: [
      { from: "sig", to: "ent", curve: -6 }, { from: "sig", to: "vec" }, { from: "sig", to: "mark", curve: 6 },
      { from: "ent", to: "auto" }, { from: "vec", to: "auto" }, { from: "mark", to: "auto" },
    ],
  },

  /* 5 · EL CORAZÓN — pipeline de advanced analytics ------------------------ */
  pipeline: {
    h: 60, columns: true,
    caption: "El componente que convierte un buen centro de rendimiento en el activo estratégico que PRODI busca. Cuatro etapas: la captura se integra en una sola ficha, sobre la que corren modelos que producen decisiones legibles.",
    nodes: [
      { id: "cap",  x: 12, y: 12, kind: "ink",   label: "CAPTURA", sub: "" , head: true },
      { id: "c1",   x: 12, y: 28, kind: "frame", label: "GPS · wearables", sub: "" },
      { id: "c2",   x: 12, y: 40, kind: "frame", label: "Plataformas de fuerza", sub: "" },
      { id: "c3",   x: 12, y: 52, kind: "frame", label: "Visión · clínico · sueño", sub: "" },

      { id: "intg", x: 38, y: 12, kind: "ink",   label: "INTEGRACIÓN", sub: "", head: true },
      { id: "i1",   x: 38, y: 34, kind: "asset", label: "Ficha única del atleta", sub: "perfil 360° · el dato se queda en casa" },

      { id: "mod",  x: 64, y: 12, kind: "ink",   label: "MODELOS", sub: "", head: true },
      { id: "m1",   x: 64, y: 26, kind: "frame", label: "Riesgo de lesión", sub: "" },
      { id: "m2",   x: 64, y: 37, kind: "frame", label: "Carga / recuperación", sub: "" },
      { id: "m3",   x: 64, y: 48, kind: "frame", label: "Disponibilidad · desarrollo", sub: "" },

      { id: "dec",  x: 88, y: 12, kind: "ink",   label: "DECISIÓN", sub: "", head: true },
      { id: "d1",   x: 88, y: 34, kind: "decision", label: "Tableros", sub: "cuerpo técnico + dirección deportiva" },
    ],
    edges: [
      { from: "c1", to: "i1", curve: 4 }, { from: "c2", to: "i1" }, { from: "c3", to: "i1", curve: -4 },
      { from: "i1", to: "m1", curve: 4 }, { from: "i1", to: "m2" }, { from: "i1", to: "m3", curve: -4 },
      { from: "m1", to: "d1", curve: 4 }, { from: "m2", to: "d1" }, { from: "m3", to: "d1", curve: -4 },
    ],
  },

  /* 6 · HPX × JAMESTOWN — la decisión de adquisición ----------------------- */
  acquisition: {
    h: 68,
    caption: "El grupo ya contrató a Jamestown Analytics (offshoot de Starlizard) para fichajes. Jamestown trabaja desde datos externos de partido y mercado; por diseño, no tiene acceso al cuerpo del atleta. HPX aporta esa capa —y solo HPX puede.",
    nodes: [
      { id: "jm",   x: 22, y: 12, kind: "blue",  label: "Jamestown", sub: "datos de partido + mercado · externos, rentados" },
      { id: "hpx",  x: 78, y: 12, kind: "asset", label: "HPX", sub: "cuerpo del atleta · propietario, in-house" },
      { id: "qj",   x: 22, y: 34, kind: "frame", label: "¿Es bueno / infravalorado?", sub: "maximiza el acierto deportivo" },
      { id: "qh",   x: 78, y: 34, kind: "frame", label: "¿Aguanta, se desarrolla, encaja?", sub: "de-riesga la inversión" },
      { id: "join", x: 50, y: 52, kind: "value", label: "Atacan el mayor riesgo del fichaje", sub: "pagar por talento que se lesiona, no aguanta o no se desarrolla" },
    ],
    edges: [
      { from: "jm", to: "qj" }, { from: "hpx", to: "qh" },
      { from: "qj", to: "join", curve: 10 }, { from: "qh", to: "join", curve: -10 },
    ],
  },

  /* 7 · LA ECONOMÍA DE LA LESIÓN — el idioma del dueño --------------------- */
  injury: {
    h: 64,
    caption: "El KPI ancla del piloto Atlas traduce el valor de HPX al idioma del dueño. No prometemos predecir lesiones como certeza: ofrecemos reducir el riesgo y mejorar la disponibilidad con monitoreo multi-lente e individualizado.",
    nodes: [
      { id: "inj",  x: 20, y: 12, kind: "red",   label: "Lesión", sub: "" },
      { id: "days", x: 20, y: 34, kind: "ink",   label: "Días de baja", sub: "" },
      { id: "cost", x: 20, y: 56, kind: "red",   label: "Costo", sub: "nómina parada + minutos de inversión fuera de la cancha" },
      { id: "mon",  x: 62, y: 12, kind: "asset", label: "Monitoreo HPX", sub: "multi-lente · individualizado · en contexto" },
      { id: "risk", x: 62, y: 34, kind: "ink",   label: "Reduce el riesgo", sub: "" },
      { id: "avail",x: 62, y: 56, kind: "value", label: "Costo de lesión evitada", sub: "mejora de disponibilidad → valor protegido" },
    ],
    edges: [
      { from: "inj", to: "days" }, { from: "days", to: "cost" },
      { from: "mon", to: "risk" }, { from: "risk", to: "avail" },
      { from: "risk", to: "days", kind: "feedback", curve: 0, dashLabel: "reduce" },
    ],
  },

  /* 8 · EL MOTOR TAXONOMÍA v2 — la IP del pilar físico --------------------- */
  taxonomy: {
    h: 70,
    caption: "El motor de prescripción del pilar físico: una especificación formal donde cada método deja de ser una etiqueta y se vuelve un ciudadano de primera clase, ejecutable. Cuatro capas cerradas apuntan a un generador automático (v3).",
    nodes: [
      { id: "a",    x: 14, y: 14, kind: "ink",   label: "A · Métodos", sub: "9 métodos · 40 variantes" },
      { id: "b",    x: 38, y: 14, kind: "ink",   label: "B · Catálogo", sub: "98 ejercicios · grafo de progresión" },
      { id: "c",    x: 62, y: 14, kind: "ink",   label: "C · Autorregulación", sub: "29 reglas · fatiga · deload" },
      { id: "d",    x: 86, y: 14, kind: "ink",   label: "D · Periodización", sub: "5 modelos · macro · taper" },
      { id: "zone", x: 26, y: 40, kind: "frame", label: "Clasificación de zona", sub: "6 estrategias → Z1–Z6" },
      { id: "drift",x: 62, y: 40, kind: "frame", label: "Detección de drift", sub: "método declarado ≠ intención real" },
      { id: "sugg", x: 62, y: 56, kind: "decision", label: "Sugerencia contextual", sub: "inspecciona params → propone método/variante" },
      { id: "gen",  x: 50, y: 70, kind: "asset", label: "Generador v3", sub: "prescripción y progresión con mínimo input" },
    ],
    edges: [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" },
      { from: "a", to: "zone", curve: 6 }, { from: "a", to: "drift", curve: -6 },
      { from: "drift", to: "sugg" },
      { from: "zone", to: "gen", curve: -14 }, { from: "sugg", to: "gen", curve: 8 }, { from: "d", to: "gen", curve: 20 },
      { from: "c", to: "gen", kind: "feedback", curve: -6 },
    ],
  },

  /* 9 · ESCALA MULTI-CLUB — el multiplicador ------------------------------- */
  scale: {
    h: 46,
    caption: "El valor compuesto del lab está en su replicabilidad. Lo construido para Atlas se conecta al resto del portafolio con costo marginal decreciente, y cada equipo nuevo enriquece el activo de datos del grupo.",
    nodes: [
      { id: "atlas",x: 12, y: 22, kind: "decision", label: "Atlas · fútbol", sub: "vitrina del modelo" },
      { id: "peri", x: 37, y: 22, kind: "decision", label: "Pericos · béisbol", sub: "vision training — quick win" },
      { id: "golf", x: 62, y: 22, kind: "decision", label: "Golf", sub: "visión · biomecánica · mente" },
      { id: "fut",  x: 87, y: 22, kind: "asset", label: "Futuras adquisiciones", sub: "costo marginal decreciente" },
    ],
    edges: [
      { from: "atlas", to: "peri" }, { from: "peri", to: "golf" }, { from: "golf", to: "fut" },
    ],
  },
};

/* --- Tests intuitivos ----------------------------------------------------- *
 * Cada test enseña un mecanismo al revelar. type:
 *   choice   — una opción correcta, explicación al elegir
 *   classify — clasificar ítems en cubetas (arrastre por clic)              */

const TESTS = {

  /* Adquisición — quién responde qué */
  whoAnswers: {
    kind: "choice",
    prompt: "Un club considera fichar a un extremo brillante pero con historial de molestias musculares. ¿Quién responde mejor «¿su cuerpo aguantará nuestra liga y calendario?»",
    options: [
      { t: "Jamestown", why: "Jamestown modela desde datos externos de partido y mercado. Por construcción, no tiene acceso al cuerpo del atleta." , ok: false },
      { t: "HPX", why: "Correcto. HPX es la capa física-médica-de-desarrollo sobre el propio atleta: due diligence de durabilidad, proyección física y economía de disponibilidad. Jamestown responde «¿es bueno / infravalorado?»; HPX «¿aguanta, se desarrolla, encaja?».", ok: true },
      { t: "El scouting tradicional", why: "El scouting aporta lectura cualitativa, pero no la capa física-médica objetiva y propietaria que reduce el riesgo del fichaje.", ok: false },
    ],
  },

  /* Atleta en contexto — diseño representativo */
  validTest: {
    kind: "choice",
    prompt: "Para evaluar la anticipación de un bateador, un lab lo sienta frente a una pantalla a pulsar un botón cuando aparece la bola. ¿Diagnostica lo que dice medir?",
    options: [
      { t: "Sí — mide tiempo de reacción", why: "Mide reacción a un estímulo en pantalla (PAC 0), no la interceptación con el cuerpo entero in-situ que exige el juego. La información perceptiva no se reproduce.", ok: false },
      { t: "No — no reproduce la información del juego", why: "Correcto. El diseño representativo aplica también a la EVALUACIÓN: un test debe reproducir la información del juego real o no diagnostica lo que dice medir. La rúbrica PAC 0–6 lo hace explícito (0 = pantalla → 6 = interceptación real de cuerpo entero).", ok: true },
      { t: "Depende del tamaño de muestra", why: "El problema no es estadístico sino de validez representativa: la tarea de laboratorio no contiene las affordances del juego.", ok: false },
    ],
  },

  /* Honestidad — campo vs laboratorio */
  fieldOrLab: {
    kind: "classify",
    prompt: "Clasifica cada señal según dónde es medible hoy. HPX no promete en cancha lo que solo el lab resuelve.",
    buckets: [ { id: "field", t: "Viable en campo" }, { id: "lab", t: "Solo laboratorio" } ],
    items: [
      { t: "Entropía (IMU en L5)", bucket: "field" },
      { t: "Vector coding sagital", bucket: "field" },
      { t: "Coordinación markerless entre atletas", bucket: "field" },
      { t: "Análisis UCM / sinergias", bucket: "lab" },
      { t: "Cinemática rotacional / distal fina", bucket: "lab" },
    ],
    done: "Las tres señales de campo alimentan la capa de autorregulación de la Taxonomía; las de laboratorio se declaran como tales para no sobre-prometer.",
  },

  /* Analytics — copiar vs evitar */
  copyAvoid: {
    kind: "classify",
    prompt: "De la historia del analytics deportivo: ¿qué copiar y qué evitar?",
    buckets: [ { id: "copy", t: "Copiar" }, { id: "avoid", t: "Evitar" } ],
    items: [
      { t: "Dato propietario in-house (Liverpool / I. Graham)", bucket: "copy" },
      { t: "Valor patrimonial vía desarrollo (Brentford)", bucket: "copy" },
      { t: "Igualar presupuestos con datos (Moneyball)", bucket: "copy" },
      { t: "Confiar en una métrica única (ACWR)", bucket: "avoid" },
      { t: "«Predecir» lesiones como certeza", bucket: "avoid" },
      { t: "Medir descontextualizado", bucket: "avoid" },
    ],
    done: "La ventaja de tener datos se erosiona cuando todos los tienen. La sostenible: dato propietario + mejor interpretación + renovación constante. Nunca una sola métrica.",
  },

  /* Taxonomía — drift, qué método es */
  whichMethod: {
    kind: "choice",
    prompt: "Un bloque declara «cluster», pero cada mini-tanda llega al fallo (RIR ≤ 1) y descansa apenas 10–15 s antes de la siguiente. ¿Qué detecta el sistema?",
    options: [
      { t: "Nada — es un cluster válido", why: "El cluster PRE-declara reps y clusters preservando calidad; no va al fallo. Ir al fallo con descansos cortos es la firma de otro método.", ok: false },
      { t: "Drift hacia rest_pause", why: "Correcto. El drift detecta que, aunque el esquema de cluster se satisface, la intención real está mejor capturada por rest_pause (activación al fallo + mini-tandas). Emite una sugerencia contextual — el germen del generador v3.", ok: true },
      { t: "Un error estructural que bloquea", why: "El drift es semántico, no estructural: el bloque es válido de esquema. Es informativo y sugiere, no bloquea.", ok: false },
    ],
  },

  /* Autorregulación — asimetría frena/acelera */
  brakeAccelerate: {
    kind: "choice",
    prompt: "Un atleta reporta RIR muy por debajo del objetivo en una sola sesión (señal de fatiga). ¿Qué hace el motor de autorregulación?",
    options: [
      { t: "Sube la carga — va sobrado", why: "Al revés: una señal aislada de menor esfuerzo disponible indica fatiga, no margen. El sistema nunca acelera con una sola señal.", ok: false },
      { t: "Frena la carga de inmediato", why: "Correcto. La asimetría con dientes: FRENA con una sola señal, pero solo ACELERA con dos consecutivas. El sistema se protege solo; nunca acelera solo.", ok: true },
      { t: "Espera dos sesiones para decidir", why: "Para frenar no espera: reducir riesgo pesa más que optimizar. Solo la aceleración exige confirmación (dos señales).", ok: false },
    ],
  },

  /* Qué es y qué no es HPX */
  isIsnt: {
    kind: "classify",
    prompt: "Deslinde de identidad: ¿qué ES y qué NO ES HPX?",
    buckets: [ { id: "is", t: "Es" }, { id: "isnt", t: "No es" } ],
    items: [
      { t: "Plataforma de datos propietaria del grupo", bucket: "is" },
      { t: "Integrador salud + entrenamiento + nutrición + visión + datos", bucket: "is" },
      { t: "Activo patrimonial que escala con cada adquisición", bucket: "is" },
      { t: "Un gimnasio o centro de alto rendimiento genérico", bucket: "isnt" },
      { t: "Un proveedor externo de software que renta tu ventaja", bucket: "isnt" },
      { t: "Un costo operativo atado a un solo equipo", bucket: "isnt" },
    ],
    done: "HPX complementa —no reemplaza— a Jamestown, al cuerpo técnico y al scouting. Su ventaja no es «tener datos»: es la capa propietaria del cuerpo del atleta que nadie externo puede darle al grupo.",
  },
};

/* --- Hilo narrativo ------------------------------------------------------- *
 * Prosa mínima; la explicación vive en las visualizaciones.                  */

const SECTIONS = [
  {
    id: "portada", kind: "hero",
    eyebrow: "Grupo PRODI · Fase 1 · piloto Atlas",
    title: "HPX",
    lede: "El motor de inteligencia de decisión propietario del grupo. La ciencia detrás del rendimiento, leída como un tablero.",
    thesis: "De «un grupo que compra equipos y usa datos» a «un grupo construido sobre una plataforma propietaria de ciencia del rendimiento y advanced analytics» — un activo que se revaloriza con cada equipo que adquiere.",
  },
  {
    id: "motor", kind: "dag", dag: "engine",
    eyebrow: "El reencuadre",
    title: "Un activo, tres decisiones",
    body: "El performance lab es, en realidad, el motor de datos que informa las tres decisiones que mueven el valor de un club. El mismo atleta —medido en contexto— alimenta rendimiento, táctica y adquisición.",
  },
  {
    id: "volante", kind: "dag", dag: "flywheel",
    eyebrow: "La tesis compuesta",
    title: "El dato se queda en casa",
    body: "Lo que distingue a HPX de un proveedor de tracking o una consultora externa: posee la capa física-médica-de-desarrollo de los propios atletas del grupo. Ese dato compone valor con cada temporada y cada club.",
  },
  {
    id: "contexto", kind: "dag", dag: "context", test: "validTest",
    eyebrow: "El cimiento científico",
    title: "El atleta en contexto",
    body: "El principio que distingue a HPX de un centro convencional: no medimos piezas sueltas en un lab aislado, sino al atleta en su relación con la tarea y el entorno. La variabilidad del movimiento es señal, no error.",
  },
  {
    id: "honestidad", kind: "dag", dag: "measurable", test: "fieldOrLab",
    eyebrow: "Honestidad intelectual",
    title: "Qué es medible en campo",
    body: "Lo que nos hace creíbles ante un cuerpo técnico escéptico: distinguir las señales de proceso hoy viables en cancha de las que siguen siendo solo-laboratorio, sin sobre-prometer ninguna.",
  },
  {
    id: "corazon", kind: "dag", dag: "pipeline", test: "copyAvoid",
    eyebrow: "El corazón",
    title: "Advanced analytics",
    body: "Cuatro etapas convierten la captura dispersa en decisión legible. Una sola ficha del atleta, modelos encima, tableros que el experto adopta. El dato complementa al experto; no lo reemplaza.",
  },
  {
    id: "adquisicion", kind: "dag", dag: "acquisition", test: "whoAnswers",
    eyebrow: "La decisión de adquisición",
    title: "HPX × Jamestown",
    body: "El reencuadre más importante. Jamestown maximiza el acierto deportivo desde datos externos; HPX de-riesga la inversión desde el cuerpo del atleta. PRODI no elige entre uno u otro: HPX aporta la única capa que un externo no puede tener.",
  },
  {
    id: "lesion", kind: "dag", dag: "injury",
    eyebrow: "El idioma del dueño",
    title: "La economía de la lesión",
    body: "Traduce el valor de HPX a pesos: días de baja = nómina parada + minutos de inversión fuera de la cancha. La métrica ancla del piloto: costo de lesión evitada y mejora de disponibilidad del plantel.",
  },
  {
    id: "taxonomia", kind: "dag", dag: "taxonomy", test: "whichMethod", test2: "brakeAccelerate",
    eyebrow: "La IP del pilar físico",
    title: "El motor Taxonomía v2",
    body: "El activo que hace ejecutable la prescripción: métodos como ciudadanos de primera clase, clasificación de zona por estrategia, detección de drift que sugiere el método correcto. Todo apunta a un generador que prescribe y progresa solo.",
  },
  {
    id: "escala", kind: "dag", dag: "scale",
    eyebrow: "El multiplicador",
    title: "Escala multi-club",
    body: "Un modelo de centro de excelencia: servicios compartidos que cada club consume, con metodología común y datos centralizados en el grupo. Cada nuevo equipo se conecta con costo marginal decreciente.",
    roadmap: [
      { p: "0", t: "Concepto", h: "Ahora", d: "Maestro + propuesta a PRODI" },
      { p: "1", t: "Piloto Atlas", h: "Post 1-jul-2026", d: "Línea base · integración · tableros" },
      { p: "2", t: "Plataforma", h: "+6 meses", d: "Motor de analytics · modelos de riesgo" },
      { p: "3", t: "Replicación", h: "+12 meses", d: "Pericos · golf · capacidad portátil" },
      { p: "4", t: "Comercial", h: "+18 meses", d: "B2B · corporativo · licenciamiento" },
    ],
  },
  {
    id: "limites", kind: "close", test: "isIsnt",
    eyebrow: "Lo que nos hace creíbles",
    title: "Límites y honestidad",
    body: "No prometemos predecir lesiones ni aciertos de fichaje como certeza. Ofrecemos reducir el riesgo y mejorar la calidad de la decisión con dato propietario, multi-lente y en contexto.",
    close: "La ventaja no es tener datos. Es tener la capa propietaria del cuerpo del atleta —integrada a rendimiento, táctica y adquisición— que nadie externo puede darle al grupo.",
  },
];

/* Benchmarks (principios rectores) — tira de referencia en la sección corazón */
const BENCHMARKS = [
  { n: "Red Bull APC", p: "Centro multi-deporte · el dato se queda en casa" },
  { n: "Hintsa", p: "Método con nombre propio, holístico, licenciable" },
  { n: "Thinking Basketball", p: "Métricas propias multi-lente, nunca una sola" },
  { n: "Duke Biomechanics", p: "Rigor científico + alianza académica" },
  { n: "Progressive", p: "Lab fijo + campo portátil + ingreso B2B" },
];

const ASSETS_ROW = [
  { n: "Human Paradox", p: "Fisioterapia de rendimiento · RTP" },
  { n: "LATIMED", p: "Red hospitalaria · trauma/ortopedia" },
  { n: "Team Máximo Esfuerzo", p: "Nutrición deportiva" },
  { n: "Jerónimo de la Peza", p: "S&C + alcance de marca" },
  { n: "Taxonomía v2", p: "IP de prescripción/autorregulación" },
  { n: "La Liga de los Gainz", p: "Contenido y divulgación" },
];

window.HPX = { DAGS, TESTS, SECTIONS, BENCHMARKS, ASSETS_ROW };
