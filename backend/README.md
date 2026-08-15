# Hannah — backend

Servidor del pipeline de Hannah: recibe voz (o texto, o un frame de cámara), decide qué hacer,
y devuelve al avatar **audio + visemas + gestos + emoción**, en streaming por oración. También
es quien **actúa sobre la máquina**: abre y cierra ventanas, corre comandos en una terminal
real, busca en internet.

Node.js (ESM) + Express + `ws`, con **sidecars Python** para el trabajo de GPU (Whisper, Kokoro,
YOLO/VLM, EMAGE). Todo el stack por defecto corre **local**: Ollama para el LLM y los
embeddings, y los sidecars en localhost.

> Este documento describe el backend **tal como está**. Para el mapa del workspace completo
> (frontend, app de escritorio, motion-lab, launcher) mirá `../CLAUDE.md`; para levantar todo en
> una máquina nueva, `../SETUP.md`.

---

## Arrancar

```bash
npm install
cp .env.example .env        # el default ya apunta al stack local (Ollama + sidecars)
npm run dev                 # nodemon en :3001   (npm start = node src/server.js)
```

El backend **solo** hace falta que esté vivo; los sidecars se levantan según lo que quieras usar:

```bash
npm run sidecar:tts         # Kokoro en :8002  ← imprescindible para que hable
npm run sidecar:asr         # faster-whisper en :8001 (si ASR_PROVIDER=local)
npm run sidecar:vision      # YOLOv8 en :8003 (solo si VISION_PROVIDER=yolo)
npm run sidecar:motion      # EMAGE en :8004 (solo si MOTION_PROVIDER=emage)
```

El proveedor de movimiento por defecto (`lab`, :8005) vive en el otro repo:

```bash
cd ../hannah-motion-lab && .venv/bin/python -m uvicorn serve.main:app --port 8005
```

### Puertos

| Servicio | Puerto | |
|---|---|---|
| Backend (REST + WS) | 3001 | escucha en **127.0.0.1** por defecto (`HOST`) |
| ASR · TTS · Visión | 8001 · 8002 · 8003 | sidecars de este repo |
| Motion | 8005 (`lab`) · 8004 (`emage`) | cada provider con su URL propia |
| Ollama | 11434 | LLM, VLM y embeddings |
| Vite (frontend) | 5173 | proxea `/api` y `/ws` hacia acá |

---

## El turno de voz, de punta a punta

Es el recorrido central del proyecto. Todo lo demás orbita alrededor.

**0. Handshake.** El cliente hace `POST /api/v1/session` y abre `ws://host/ws?sessionId=<uuid>`.
El handler de `upgrade` valida la sesión y escribe un **401** crudo al socket si no existe o
expiró (`gateway/websocket.js`). Crear la sesión ya **precarga la ventana de contexto** desde
SQLite, así que Hannah arranca recordando.

**1. Audio.** `SPEECH_START` aborta el turno en curso (barge-in) y vacía el buffer. Llegan los
frames binarios, que se acumulan con un **tope duro de 5MB**. `SPEECH_END` los concatena, crea
un `AbortController` nuevo y llama a `processVoiceTurn`.

**2. ASR.** `pipeline/asr.js` transcribe con el sidecar faster-whisper (`local`) o con OpenAI
Whisper (`cloud`). Al volver se comprueba `signal.aborted`: si el usuario ya interrumpió, el
turno se abandona en silencio.

**3. Capa determinista — antes del modelo.** `runDeterministicLayer()` parsea *las palabras del
usuario* y ejecuta lo que reconozca, en este orden:

1. `parseMoveIntent()` — mover el overlay (ES/EN) → `moveWindow()` + `window_move`.
2. `handleOpenIntent()` / `handleCloseIntent()` — abrir apps y sitios, cerrar ventanas.
3. `resolveSkillPhrase()` — skills con `phrases` declaradas.
4. `resolveDataAction()` — limpiar la terminal, `cat`, crear archivo, borrar (con confirmación),
   `ls`, "corré `<cmd>`", "leé `<url>`", "buscá X".

Lo que se ejecute devuelve su **salida real**, que se inyecta en el turno junto con una coletilla
explícita de *no inventes esto*. Es lo que impide que un modelo de 7B **diga** que hizo algo sin
haberlo hecho — el problema que motivó toda esta capa.

**4. Historial.** El turno se guarda **con el resultado inyectado**: ventana en RAM + SQLite +
embedding en segundo plano para el recall. Recién ahí se emite `user_transcript` al cliente, con
la transcripción **original** (no la enriquecida).

**5. LLM.** Se arma el system prompt: persona + resumen de memoria + recall vectorial + protocolo
de emoción + índice de skills + cheat-sheets de `reference/`. Dos caminos:

- **Con tools y sin acción determinista previa**: hasta 3 pasadas sin streaming, ejecutando los
  tags que el modelo escriba y realimentando los resultados reales.
- **Si la capa determinista ya actuó** (`noActions`): streaming directo, token a token, y el
  prompt **ni siquiera incluye el índice de skills** — para no tentar al modelo a repetir un
  `ssh` o un comando que ya se ejecutó.

**6. Streaming por oración.** Los tokens se acumulan en un buffer que corta en `.!?` (con más de
10 caracteres). Cada oración completa dispara **en paralelo** TTS, visemas y motion, y sale como
un único `audio_chunk`. Los segmentos se serializan en una cadena de promesas, así que **llegan
en orden hablado** y `turn_complete` solo se emite después del último.

**7. Fin.** `turn_complete` con la emoción parseada del tag `[EMOTION:...]` y las métricas. Si el
turno fue abortado, **no se emite**.

---

## Acciones: por qué hay cuatro capas

Conviven a propósito. La motivación es la fiabilidad con modelos locales chicos.

| Capa | Qué es | Fiabilidad |
|---|---|---|
| **Intents deterministas** | Se parsean las palabras del usuario y se ejecuta | 100%, no depende del modelo |
| **Tags de acción** | El modelo escribe `[RUN:]`, `[SKILL:]`, `[SEARCH:]`, `[OPEN:]`… y el backend ejecuta | depende del modelo |
| **Skills** (`skills/<n>/SKILL.md`) | Markdown con frontmatter: una acción (`run`/`terminal`/`open`/`search`), variantes por SO y `phrases` opcionales | el modelo elige, el **backend** construye el comando |
| **Reference** (`reference/*.md`) | Cheat-sheets inyectados en el prompt | no ejecutable: es conocimiento |

El vocabulario de tags tiene **una sola fuente**: `ACTION_TOOL` en `llm.js`. Tanto `ACTION_RE`
como `stripActionTags` derivan de ahí — si se agrega un tag en otro lado, el TTS termina leyendo
la etiqueta en voz alta.

Las skills son **agnósticas del modelo**: el modelo dice *qué* skill quiere, no *cómo* se ejecuta.
Detalle en `../SKILLS.md`.

---

## Contrato WebSocket

`ws://localhost:3001/ws?sessionId=<uuid>`. Se acepta indistintamente el campo `command` o `type`.
Un JSON inválido se ignora en silencio (se loguea solo el tamaño, nunca el contenido).

### Cliente → servidor

| Comando | Payload | Efecto |
|---|---|---|
| `SPEECH_START` | — | Barge-in: aborta el turno en curso y vacía el buffer de audio |
| *(binario)* | frames de audio | Se acumulan hasta **5MB**; lo que exceda se descarta con un warning |
| `SPEECH_END` | — | Concatena el audio y procesa el turno. Sin audio → `error` |
| `TEXT_INPUT` | `text` | Mismo pipeline sin ASR. El texto **sí** se guarda en el historial |
| `INTERRUPT` | — | Aborta el turno: corta el LLM y la reproducción a mitad de frase |
| `GAZE_ON` / `GAZE_OFF` | — | Arranca/para el sondeo de mirada (80 ms) |
| `VISION_START` | — | Loop de visión cada 4 s. Responde `vision_started` |
| `VISION_FRAME` | `frame` (JPEG base64) | Guarda **solo el último** frame de la sesión |
| `VISION_STOP` | — | Para el loop y borra el frame |
| `TRIGGER_YOLO` | — | Analiza el último frame y genera un turno hablado |
| `TERMINAL_START` | — | Adjunta el pty de la sesión. **Requiere `TOOLS_SYSTEM_CONTROL`** |
| `TERMINAL_IN` | `data` | Escribe en el pty. Sin el flag, no hace nada |
| `TERMINAL_RESIZE` | `cols`, `rows` | Redimensiona el pty |
| `CONFIRM_COMMAND` | `id`, `approved` | Responde al diálogo de comando destructivo |

### Servidor → cliente

| Tipo | Campos | Cuándo |
|---|---|---|
| `user_transcript` | `text` | Tras el ASR (solo en turnos de voz) |
| `audio_chunk` | `text`, `visemes[]`, `audioBase64`, `format`, `sample_rate`, `motion?`, `action?` | **Uno por oración** |
| `turn_complete` | `emotion`, `metrics` | Al final. No se emite si el turno se abortó |
| `error` | `message` | Fallo por etapa; nunca tumba el servidor |
| `gaze` | `x`, `y` | Cada 80 ms con `GAZE_ON`; normalizado a `[-1,1]` |
| `vision_started` | — | Confirmación de `VISION_START` |
| `window_move` / `window_close` | `spec` / — | La ventana se movió o se cerraron ventanas |
| `confirm_command` | `id`, `command` | Comando destructivo esperando confirmación (**40 s**) |
| `command_run` | — | Aviso de que se ejecutó un comando |
| `terminal_out` / `terminal_clear` | `data` / — | Stream del pty y limpieza de pantalla |
| `open_terminal` | — | Pedido de abrir el panel de terminal en la UI |

**El WAV viaja completo en base64**, no troceado: el navegador decodifica con `decodeAudioData`,
que necesita el archivo entero. Con Kokoro es `wav`/24000; con ElevenLabs, `mp3`/44100.

**`motion`** lleva `poses` (T×165, ejes-ángulo de 55 joints SMPL-X) y `trans` (T×3) como float32
en base64, a 30fps. Si el sidecar está caído, el chunk simplemente viaja sin ese campo.

---

## API REST

Todo bajo `/api/v1`. Cada ruta va envuelta en `handler(slug, fn)` (`api/handler.js`), que
centraliza el sobre de error 500 — nunca en `server.js`.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Estado, versión, proveedores activos y URLs de sidecars |
| `POST` | `/session` | Crea sesión → `{sessionId, expiresIn}`. **Obligatorio antes del WS** |
| `DELETE` | `/session/:id` | Borra el estado en memoria (el historial en SQLite queda) |
| `GET` | `/settings` | Config de proveedores, **con las API keys redactadas** |
| `POST` | `/settings` | Aplica un patch whitelisteado y lo persiste en `data/settings.json` |
| `GET` | `/shortcuts` | Atajos de voz: `{sites, apps}` |
| `POST` | `/shortcuts` | Reemplaza el set completo y persiste |
| `GET` | `/skills` | Lista las skills con su markdown crudo |
| `POST` | `/skills` | Crea o edita una skill en `data/skills/<n>/SKILL.md` y recarga |
| `DELETE` | `/skills/:name` | Borra la skill del usuario |
| `GET` | `/tts/voices` | Proxy al sidecar Kokoro para poblar el selector de voces |
| `POST` | `/text` | Turno de texto **sin sesión ni WS**. Ruta de pruebas |

**Middleware**: `helmet` (con CSP desactivada a propósito para pruebas locales), CORS por lista
de orígenes (`CORS_ORIGIN`), y rate limit **que exime a localhost** — si no, el propio uso normal
agotaba la cuota y todo devolvía 429.

**Archivos estáticos: uno solo, deliberadamente.** El servidor expone `test-client.html` en `/` y
`/test-client.html`, y nada más. Nunca reintroducir `express.static('.')`: exponía
`data/settings.json` (API keys) y `data/memory.db`.

---

## Mapa de módulos

```
src/
├── server.js               Express + montaje del gateway. Antes de servir aplica el estado
│                           persistido: settings, shortcuts, skills y reference
├── config.js               ÚNICA lectura de process.env. Todo lo demás lee `config`
├── gateway/websocket.js    Protocolo WS, auth en el upgrade, barge-in, buffer de audio
├── pipeline/
│   ├── orchestrator.js     El turno: capa determinista, LLM, buffer de oraciones, emisión
│   ├── asr.js              Transcripción (sidecar local u OpenAI)
│   ├── llm.js              SDK OpenAI-compatible; prompt, tags de acción, parseo de emoción
│   ├── tts.js              Kokoro (sidecar) o ElevenLabs
│   ├── lipsync.js          Visemas DESDE EL TEXTO, no del audio
│   ├── motion.js           Los dos providers de gestos, con protocolos incompatibles
│   ├── tools.js            Catálogo de tools + capa determinista + guard de destructivos
│   ├── terminal.js         Pty real por sesión (node-pty)
│   ├── windowControl.js    Lógica agnóstica de mover el overlay y de la mirada
│   ├── vision.js / vlm.js  Los dos proveedores de visión (YOLO / modelo local)
│   ├── visionLoop.js       Awareness continua: reacciona solo si la escena cambió
│   └── desktop/            Adaptadores por escritorio: hyprland → kde → x11, más env.js
│                           (detección única) y sh.js (ejecutar comandos del compositor)
├── state/
│   ├── conversationManager.js  Sesiones en RAM; precarga contexto desde SQLite
│   ├── memoryStore.js      SQLite (WAL): turnos, resumen rodante, embeddings
│   ├── embeddings.js       Embeddings locales vía Ollama
│   ├── settings.js         Config mutable en caliente, con whitelist
│   ├── skills.js           Parser de SKILL.md, ejecución y disparo por frase
│   ├── reference.js        Carga de los cheat-sheets
│   ├── shortcuts.js        Atajos de voz (sitios y apps)
│   ├── frameStore.js       Último frame de cámara por sesión
│   └── dataDir.js          Única fuente de verdad de data/
├── api/                    Rutas REST (router.js las registra todas)
└── utils/                  logger (winston) y timer (métricas de latencia)
```

---

## Configuración

Todo el acceso a variables de entorno pasa por **`src/config.js`**. Nunca leer `process.env` en
otro módulo — las dos excepciones están documentadas en su lugar: el shell del pty
(`terminal.js`) y la detección de compositor (`desktop/*.js`).

### Lo que vas a tocar

| Variable | Default | Para qué |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3001` | **Local a propósito.** El acceso LAN entra por Vite |
| `LLM_BASE_URL` | `null` | Endpoint OpenAI-compatible (Ollama, Groq, OpenRouter…) |
| `LLM_MODEL` | `llama-3.1-8b-instant` | El dev local usa `qwen2.5:7b` |
| `LLM_API_KEY` | — | Obligatoria solo si el proveedor la pide |
| `ASR_PROVIDER` | `cloud` | `local` = sidecar faster-whisper |
| `ASR_LANGUAGE` | *(vacío)* | Vacío = autodetección |
| `TTS_PROVIDER` | `kokoro` | Sidecar local; cualquier otro valor = ElevenLabs |
| `ELEVENLABS_VOICE_ID` | `af_heart` | Nombre heredado: es la voz para **ambos** proveedores. El prefijo elige idioma (`af_`/`am_` inglés, `ef_`/`em_` español) |
| `VISION_PROVIDER` | `vlm` | `vlm` describe la escena; `yolo` da etiquetas de objetos |
| `MOTION_PROVIDER` | `lab` | `lab` (texto→movimiento, :8005) o `emage` (audio→movimiento, :8004) |
| `MOTION_ENABLED` | `true` | Solo el string exacto `false` lo apaga |
| `TOOLS_ENABLED` | `false` | Deja que el modelo actúe por tags |
| `TOOLS_SYSTEM_CONTROL` | `false` | **Master flag de la terminal real** |
| `CORS_ORIGIN` | localhost:5173 | Lista separada por comas |
| `SESSION_TTL_MINUTES` | `30` | Vida de la sesión |
| `CONTEXT_TURNS` | `10` | Turnos de historia en la ventana de contexto |
| `MEMORY_RECALL` | `true` | Recall vectorial de largo plazo |
| `MEMORY_DB_PATH` | `data/memory.db` | Los tests lo fuerzan a `:memory:` |

La lista completa está en `.env.example`, con las de los sidecars Python (que el backend **no**
lee: `ASR_DEVICE`, `TTS_DEVICE`, `PANTOMATRIX_DIR`).

### Configuración en caliente

El panel ⚙ escribe `data/settings.json`, que **pisa al `.env`** y se aplica **sin reiniciar**
(muta `config` en memoria y todo el pipeline lo lee en cada llamada). Solo se aceptan los campos
de la whitelist de `state/settings.js`, y **las API keys nunca se devuelven al navegador**: la
vista de `GET /settings` va redactada.

---

## Sidecars Python

Cuatro apps FastAPI en `sidecar/`. **ASR, TTS y visión comparten el venv `sidecar/.venv`**; el de
**motion (EMAGE) usa el venv de la raíz del workspace** (`../.venv`), porque la RTX 5070 Ti
(Blackwell, sm_120) necesita torch ≥ 2.7 con CUDA 12.8. `sidecar/common.py` centraliza la
precarga de las librerías CUDA.

Los scripts invocan `<venv>/bin/python -m uvicorn` y **no** el console script `uvicorn`: su
shebang quedó roto cuando el repo cambió de ruta. Mantenerlo así.

**Los pesos no están en git** (gitignorados, ~700MB). Un clon nuevo necesita bajarlos:

| Pesos | Para qué | ¿Imprescindible? |
|---|---|---|
| `sidecar/tts/kokoro-v1.0.onnx` + `voices-v1.0.bin` | Voz | **Sí**, sin eso no habla |
| `sidecar/vision/yolov8n.pt` | Visión por objetos | Solo con `VISION_PROVIDER=yolo` |
| `../hannah-motion-lab/runs/*/latest.pt` | Gestos co-speech | Sí, para que gesticule |
| faster-whisper | ASR local | Se baja solo en el primer arranque |

---

## Seguridad

- **La terminal está apagada por defecto.** `run_command`, las skills de tipo `terminal` y los
  comandos `TERMINAL_*` requieren `TOOLS_SYSTEM_CONTROL=true`.
- **No hay allowlist de comandos.** Con el flag activo corre cualquier cosa en un pty real. La
  única red es `confirmIfDangerous()`: la regex `DANGER` (`rm`, `dd`, `mkfs`, `shutdown`,
  `git --force`…) manda un `confirm_command` y espera respuesta, con timeout de 40 s que resuelve
  *no*. Es **best-effort, no una barrera de seguridad** — está cubierta por
  `tests/unit/danger.test.js`.
- **El backend escucha en 127.0.0.1.** Desde el celular se entra por Vite (`:5173`, que sí escucha
  en `0.0.0.0`) y proxea. Así la terminal, las API keys y la memoria nunca quedan expuestas.
  `HOST=0.0.0.0` solo a conciencia.
- **Nunca se loguea contenido del usuario**: transcripciones, respuestas del modelo ni payloads.
  Solo tiempos, errores y metadata.
- **El audio nunca toca el disco**: se procesa en memoria y se descarta al terminar el turno.

---

## Decisiones de diseño (el porqué)

**Streaming por oración, no por token ni por respuesta completa.** El objetivo es <500 ms hasta
el primer sonido. Por token no se puede sintetizar (hace falta prosodia); por respuesta completa
se esperaría segundos. La oración es la unidad natural.

**Visemas desde el texto, no del audio.** Analizar el WAV costaría más latencia que sintetizarlo.
Con el texto los visemas salen gratis y en paralelo al TTS.

**Los `audio_chunk` se serializan en una cadena de promesas.** Sin eso, una oración corta puede
sintetizarse antes que una larga anterior y Hannah hablaría desordenada.

**Un `AbortController` por turno.** Es lo que hace posible el barge-in real: interrumpirla a
mitad de frase, no al final.

**Sin retargeting de movimiento a rigs ajenos.** Un intento previo de mapear SMPL-X sobre nombres
de huesos mixamo/VRM produjo la "pose zombie". El mapeo SMPL-X→VRoid se **calcula desde la
geometría**, en el frontend.

**Fallo por etapa.** Cada etapa manda su `{type:'error'}` y sigue. Una excepción no capturada
nunca debe tumbar el servidor: `await` y `.catch` en todo lo que se dispare en segundo plano.

---

## Tests y lint

```bash
npm test              # jest en modo ESM
npm run lint          # eslint sobre src y tests
```

`tests/setup.js` **aísla los tests de tus datos reales** (`MEMORY_DB_PATH=':memory:'`,
`MEMORY_RECALL=false`). Sin eso, la suite escribía en la memoria real y llamaba a Ollama —
mantenerlo así.

Las suites cubren lo que decide comportamiento: el guard de comandos destructivos, los parsers
(intents de movimiento, limpieza de tags, frontmatter de SKILL.md, argumentos de ssh), más `llm`,
`lipsync` y `conversationManager`. `parseLlmResponse`, `parseFrontmatter` y `sshArg` se exportan
como helpers puros justamente para poder testearlos; `conversationManager.dispose()` existe para
que las corridas terminen limpias.

---

## Límites conocidos

Cosas que **no** son como uno esperaría, verificadas en el código:

- **`/health` no hace ping a los sidecars.** Refleja la configuración en memoria, así que un `ok`
  no significa que ASR/TTS/visión/motion estén vivos.
- **Las rutas REST no tienen autenticación.** Es una app self-hosted de un usuario escuchando en
  localhost; quien llegue al puerto puede borrar una sesión o cambiar los settings. Si algún día
  se expone a la red, esto hay que resolverlo primero.
- **`POST /settings` no valida los valores** (no comprueba que el proveedor exista ni que la URL
  sea válida).
- **El turno de `TRIGGER_YOLO` no es abortable**: se lanza sin `signal`, así que `INTERRUPT` no
  lo corta.
- **`VISION_STOP` no confirma nada** al cliente (no existe un `vision_stopped`).
- **La lista de apps permitidas está horneada en `config.js`** (`appAllowlist`): no se configura
  por entorno ni por el panel.
