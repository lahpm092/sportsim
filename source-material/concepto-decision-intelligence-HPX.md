# HPX — De Performance Lab a motor de decisión del [GRUPO]
### Advanced analytics aplicado a rendimiento, táctica y adquisición de jugadores
*Documento conceptual · complementa (no repite) el documento maestro v3*

> **Propósito:** explicar el concepto **ampliado** de HPX. El maestro describe el *performance lab*; este documento muestra que ese lab es, en realidad, el **motor de datos propietario que informa las tres decisiones que mueven el valor de un club**. Para la ciencia, los benchmarks y el modelo de negocio, ver el maestro.

---

## 1. La idea en una frase

HPX no es solo un centro de rendimiento: es el **motor de inteligencia de decisión propietario e in-house** del [GRUPO]. El mismo activo de datos —el atleta medido en su contexto— alimenta **tres decisiones**:

1. **Rendimiento** — cómo entrenar, prevenir, rehabilitar y desarrollar a cada atleta.
2. **Táctica** — qué información objetiva recibe el cuerpo técnico para decidir cargas, minutaje, rotaciones y lectura del rival.
3. **Adquisición** — a qué jugadores fichar, con qué riesgo y a qué proyección física/médica.

> El maestro ya establece el *porqué* (tesis: de "grupo que usa datos" a "grupo con plataforma propietaria"). Aquí está el *para qué se usa esa plataforma*.

---

## 2. Un activo de datos, tres consumidores

```
                        ┌──────────────────────────────┐
                        │   FICHA DEL ATLETA (360°)     │
                        │  físico · médico · nutrición  │
                        │  visión · carga · desarrollo  │
                        │   — medido EN CONTEXTO —      │
                        └───────────────┬──────────────┘
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      1. RENDIMIENTO             2. TÁCTICA                3. ADQUISICIÓN
      (cuerpo del atleta)     (cuerpo técnico)         (dirección deportiva
                                                         + Jamestown Analytics)
```

Lo que distingue a HPX de un proveedor de tracking o de una consultora externa: **es el único que posee la capa física-médica-de-desarrollo de los propios atletas del grupo**, y la mide en contexto (ver maestro §5–6). Ese dato **se queda en casa** y compone valor con cada temporada y cada club.

---

## 3. Decisión de rendimiento *(el núcleo — ya desarrollado en el maestro)*

Es el pilar operativo: perfilado, fuerza y acondicionamiento (motor Taxonomía v2), prevención, RTP, nutrición, recuperación, vision training. Alimenta y se alimenta de la plataforma de analytics. **No lo repetimos aquí** — ver maestro §4–6 y `taxonomia-integracion-HPX.md`.

Punto clave para este documento: cada sesión, evaluación y ajuste genera **dato propietario** que las otras dos decisiones (táctica y adquisición) consumen.

---

## 4. Decisión táctica — qué aporta HPX al cuerpo técnico

HPX no reemplaza al entrenador ni al analista de video: le da **la capa física y contextual objetiva** que hoy no tiene integrada.

- **Disponibilidad y carga → decisiones de minutaje y rotación:** quién está en verde/amarillo/rojo, quién acumula riesgo, cuándo rotar (basado en carga vs. recuperación, readiness, fatiga).
- **Métricas contextualizadas de juego** (estado del arte 2026, ver maestro §6.4): en fútbol, *pressure metrics* off-ball y *expected possession value*; en béisbol, Statcast (bat speed, swing path, attack angle). No una cifra aislada — **multi-lente y en contexto**.
- **Lectura física del rival:** perfiles de carga/intensidad que informan el plan de partido.
- **Retorno a juego basado en criterios**, no en calendario.

Todo bajo la lente del maestro §5: medir al atleta **en contexto**, con las señales de proceso que hoy **sí** son viables en campo (entropía, vector coding sagital, coordinación inter-atleta) y sin sobre-prometer las que no (UCM, rotacional fino).

---

## 5. Decisión de adquisición — HPX × Jamestown Analytics

Aquí está el reencuadre más importante, porque **el grupo ya contrató a Jamestown Analytics** para apoyar decisiones de fichajes.

### 5.1 Qué es Jamestown (y qué hace bien)
Offshoot de **Starlizard** (la consultora de apuestas de Tony Bloom), fundada en 2017. Reutiliza infraestructura de datos *grado-apuestas* para **reclutamiento**: modela jugadores desde **datos de partido y de mercado** para encontrar **talento infravalorado** (el "Brighton model": comprar barato → desarrollar → vender caro). Bespoke, algoritmo secreto, clientes de élite (Brighton, Union SG, Como, Hearts). Responde con enorme filo a una pregunta:

> **Jamestown: "¿Este jugador es bueno y está infravalorado en el mercado?"**

### 5.2 Qué NO puede hacer Jamestown (por diseño)
Jamestown trabaja desde datos **externos** de partido y mercado. **No tiene acceso al cuerpo del atleta.** Por construcción no responde:
- ¿Este jugador es **físicamente frágil**? ¿Qué historial y riesgo de lesión trae?
- ¿Su cuerpo **aguantará** la demanda de nuestra liga/calendario?
- ¿Tiene margen de **desarrollo físico**, o ya tocó techo?
- ¿Cuánto del activo estará **realmente disponible** en la cancha?
- ¿Encaja en **nuestro modelo físico** de juego?

### 5.3 Qué aporta HPX — y solo HPX
HPX es la **capa física-médica-de-desarrollo** sobre los propios atletas del grupo y sobre los *targets*:

> **HPX: "¿Este cuerpo rendirá, aguantará, se desarrollará y encaja en nuestro modelo?"**

- **Due diligence médica y de durabilidad** (apoyada en Human Paradox + LATIMED): el chequeo físico-médico que reduce el riesgo del fichaje.
- **Proyección física y de desarrollo:** ¿puede este cuerpo mejorar con nuestro sistema (Taxonomía v2)?
- **Economía de disponibilidad:** traducir el fichaje a *minutos esperados en cancha* y *costo de riesgo de lesión* (el KPID del maestro §6.5).
- **Ajuste al modelo físico** del club.

### 5.4 Cómo se combinan (mejor que cualquiera solo)
| Pregunta | Quién responde | Fuente de dato |
|---|---|---|
| ¿Es bueno / infravalorado? | **Jamestown** | Datos de partido y mercado (externos) |
| ¿Aguantará, se desarrollará, encaja físicamente? | **HPX** | Cuerpo del atleta, medido en contexto (propietario) |
| ¿Cuánto riesgo/valor patrimonial? | **HPX + Jamestown** | Las dos capas juntas |

Juntas atacan el **mayor riesgo de un fichaje**: pagar por talento que **se lesiona, no aguanta o no se desarrolla**. Jamestown maximiza el acierto deportivo; HPX **de-riesga la inversión** y protege el valor patrimonial.

### 5.5 La diferencia estratégica que nadie más da
- **Jamestown = ventaja externa, rentada y compartida** (varios clubes; el algoritmo es secreto incluso para el club).
- **HPX = ventaja propia, in-house y exclusiva del grupo** — el dato del cuerpo del atleta **se queda en la familia** y se revaloriza con cada equipo.

→ [GRUPO] no elige entre uno u otro: **HPX complementa a Jamestown** y le da al grupo la única capa que un proveedor externo no puede tener sobre sus propios atletas.

---

## 6. Por qué el conjunto vale más que las partes

- **Dato propietario compuesto:** cada decisión (rendimiento/táctica/adquisición) enriquece la misma ficha del atleta → el activo mejora con el uso.
- **De-risk de la inversión deportiva:** la capa médica/física de HPX reduce el riesgo del mayor gasto de un club (fichajes y nómina).
- **Interoperabilidad** (maestro §6.7): el dato fluye hacia finanzas (costo de lesión), dirección deportiva (valoración con Jamestown) y comercial (marketabilidad).
- **Multi-club:** el mismo motor sirve a Atlas, Pericos, golf y futuras adquisiciones, con costo marginal decreciente.

---

## 7. Límites y honestidad *(lo que nos hace creíbles)*

- HPX **no reemplaza** a Jamestown (reclutamiento/mercado), ni al cuerpo técnico (táctica), ni al scouting tradicional. **Complementa**, aportando la capa física-médica-de-desarrollo.
- **No prometemos predecir** lesiones ni aciertos de fichaje como certeza. Ofrecemos **reducir riesgo y mejorar la calidad de decisión** con dato propietario, multi-lente y en contexto.
- La ventaja no es "tener datos" (Jamestown ya los tiene): es tener la **capa propietaria del cuerpo del atleta** que **nadie externo puede darle al grupo**, integrada a rendimiento, táctica y adquisición.

---

*Documento conceptual — se apoya en `documento-maestro-v3.md` para ciencia, benchmarks y modelo de negocio. Próximo natural: cuantificar la economía de disponibilidad (KPI del piloto) y definir el protocolo de due diligence físico-médica para fichajes (HPX × Jamestown).*
