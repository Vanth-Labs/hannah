# Hannah — backend

Hannah's pipeline server: it takes voice (or text, or a camera frame), decides what to do,
and returns **audio + visemes + gestures + emotion** to the avatar, streamed sentence by sentence.
It is also the piece that **acts on the machine**: it opens and closes windows, runs commands in a
real terminal, searches the web.

Node.js (ESM) + Express + `ws`, with **Python sidecars** for the GPU work (Whisper, Kokoro,
YOLO/VLM, EMAGE). The whole default stack runs **locally**: Ollama for the LLM and the
embeddings, and the sidecars on localhost.

> This document describes the backend **as it is**. For the map of the whole workspace
> (frontend, desktop app, motion-lab, launcher) see `../CLAUDE.md`; to bring everything up on
> a fresh machine, `../SETUP.md`.

---

## Getting started

```bash
npm install
cp .env.example .env        # the default already points at the local stack (Ollama + sidecars)
npm run dev                 # nodemon on :3001   (npm start = node src/server.js)
```

**Only** the backend has to be alive; you start the sidecars depending on what you want to use:

```bash
npm run sidecar:tts         # Kokoro on :8002  ← required for her to speak
npm run sidecar:asr         # faster-whisper on :8001 (if ASR_PROVIDER=local)
npm run sidecar:vision      # YOLOv8 on :8003 — ONLY with VISION_PROVIDER=yolo (see below)
npm run sidecar:motion      # EMAGE on :8004 (only if MOTION_PROVIDER=emage)
```

**Two of those you will probably never start**, because the defaults do not use them:

- **Vision** defaults to `vlm`: a local vision model (`moondream`) that runs **inside Ollama**
  (`:11434`), not in a sidecar — it *describes* the scene in words. The `:8003` sidecar is the
  other provider, `yolo`, which returns object *labels* instead. Faster and dumber.
- **Motion** defaults to `lab` (`:8005`), which lives in the other repo. The `:8004` sidecar is
  EMAGE, the fallback provider.

So the one you do have to start by hand is the motion lab:

```bash
cd ../hannah-motion-lab && .venv/bin/python -m uvicorn serve.main:app --port 8005
```

### Ports

| Service | Port | |
|---|---|---|
| Backend (REST + WS) | 3001 | listens on **127.0.0.1** by default (`HOST`) |
| ASR · TTS · Vision | 8001 · 8002 · 8003 | this repo's sidecars |
| Motion | 8005 (`lab`) · 8004 (`emage`) | each provider with its own URL |
| Ollama | 11434 | LLM, VLM and embeddings |
| Vite (frontend) | 5173 | proxies `/api` and `/ws` over to the backend |

---

## The voice turn, end to end

It is the project's central path. Everything else orbits around it.

**0. Handshake.** The client does `POST /api/v1/session` and opens `ws://host/ws?sessionId=<uuid>`.
The `upgrade` handler validates the session and writes a raw **401** to the socket if it does not
exist or expired (`gateway/websocket.js`). Creating the session already **preloads the context
window** from SQLite, so Hannah starts out remembering.

**1. Audio.** `SPEECH_START` aborts the turn in progress (barge-in) and empties the buffer. The
binary frames arrive and accumulate with a **hard 5MB cap**. `SPEECH_END` concatenates them, creates
a new `AbortController` and calls `processVoiceTurn`.

**2. ASR.** `pipeline/asr.js` transcribes with the faster-whisper sidecar (`local`) or with OpenAI
Whisper (`cloud`). On the way back `signal.aborted` is checked: if the user already interrupted, the
turn is abandoned silently.

**3. Deterministic layer — before the model.** `runDeterministicLayer()` parses *the user's own
words* and executes whatever it recognizes, in this order:

1. `parseMoveIntent()` — move the overlay (ES/EN) → `moveWindow()` + `window_move`.
2. `handleOpenIntent()` / `handleCloseIntent()` — open apps and sites, close windows.
3. `resolveSkillPhrase()` — skills with declared `phrases`.
4. `resolveDataAction()` — clear the terminal, `cat`, create a file, delete (with confirmation),
   `ls`, "corré `<cmd>`", "leé `<url>`", "buscá X".

Whatever runs returns its **real output**, which is injected into the turn along with an explicit
*don't make this up* reminder. That is what stops a 7B model from **saying** it did something without
having done it — the problem that motivated this whole layer.

**4. History.** The turn is stored **with the injected result**: RAM window + SQLite + a background
embedding for recall. Only then is `user_transcript` emitted to the client, with the **original**
transcription (not the enriched one).

**5. LLM.** The system prompt is assembled: persona + memory summary + vector recall + emotion
protocol + skills index + cheat-sheets from `reference/`. Two paths:

- **With tools and no prior deterministic action**: up to 3 non-streaming passes, executing the
  tags the model writes and feeding the real results back.
- **If the deterministic layer already acted** (`noActions`): straight streaming, token by token, and
  the prompt **does not even include the skills index** — so the model is not tempted to repeat an
  `ssh` or a command that already ran.

**6. Sentence-by-sentence streaming.** Tokens accumulate in a buffer that cuts on `.!?` (with more
than 10 characters). Each complete sentence fires TTS, visemes and motion **in parallel**, and goes
out as a single `audio_chunk`. The segments are serialized in a promise chain, so they **arrive
in spoken order** and `turn_complete` is only emitted after the last one.

**7. End.** `turn_complete` with the emotion parsed from the `[EMOTION:...]` tag and the metrics. If
the turn was aborted, it **is not emitted**.

---

## Actions: why there are four layers

They coexist on purpose. The motivation is reliability with small local models.

| Layer | What it is | Reliability |
|---|---|---|
| **Deterministic intents** | The user's words are parsed and executed | 100%, does not depend on the model |
| **Action tags** | The model writes `[RUN:]`, `[SKILL:]`, `[SEARCH:]`, `[OPEN:]`… and the backend executes | depends on the model |
| **Skills** (`skills/<n>/SKILL.md`) | Markdown with frontmatter: one action (`run`/`terminal`/`open`/`search`), per-OS variants and optional `phrases` | the model picks, the **backend** builds the command |
| **Reference** (`reference/*.md`) | Cheat-sheets injected into the prompt | not executable: it is knowledge |

The tag vocabulary has **one single source**: `ACTION_TOOL` in `llm.js`. Both `ACTION_RE` and
`stripActionTags` derive from it — if a tag is added somewhere else, the TTS ends up reading the
label out loud.

Skills are **model-agnostic**: the model says *which* skill it wants, not *how* it runs.
Details in `../SKILLS.md`.

---

## WebSocket contract

`ws://localhost:3001/ws?sessionId=<uuid>`. Either the `command` or the `type` field is accepted.
Invalid JSON is ignored silently (only the size is logged, never the content).

### Client → server

| Command | Payload | Effect |
|---|---|---|
| `SPEECH_START` | — | Barge-in: aborts the turn in progress and empties the audio buffer |
| *(binary)* | audio frames | Accumulated up to **5MB**; anything beyond is dropped with a warning |
| `SPEECH_END` | — | Concatenates the audio and processes the turn. No audio → `error` |
| `TEXT_INPUT` | `text` | Same pipeline without ASR. The text **is** stored in the history |
| `INTERRUPT` | — | Aborts the turn: cuts the LLM and playback mid-sentence |
| `GAZE_ON` / `GAZE_OFF` | — | Starts/stops the gaze polling (80 ms) |
| `VISION_START` | — | Vision loop every 4 s. Replies `vision_started` |
| `VISION_FRAME` | `frame` (base64 JPEG) | Stores **only the last** frame of the session |
| `VISION_STOP` | — | Stops the loop and clears the frame |
| `TRIGGER_YOLO` | — | Analyzes the last frame and generates a spoken turn |
| `TERMINAL_START` | — | Attaches the session's pty. **Requires `TOOLS_SYSTEM_CONTROL`** |
| `TERMINAL_IN` | `data` | Writes to the pty. Without the flag, it does nothing |
| `TERMINAL_RESIZE` | `cols`, `rows` | Resizes the pty |
| `CONFIRM_COMMAND` | `id`, `approved` | Answers the destructive-command dialog |

### Server → client

| Type | Fields | When |
|---|---|---|
| `user_transcript` | `text` | After the ASR (voice turns only) |
| `audio_chunk` | `text`, `visemes[]`, `audioBase64`, `format`, `sample_rate`, `motion?`, `action?` | **One per sentence** |
| `turn_complete` | `emotion`, `metrics` | At the end. Not emitted if the turn was aborted |
| `error` | `message` | Per-stage failure; never takes the server down |
| `gaze` | `x`, `y` | Every 80 ms with `GAZE_ON`; normalized to `[-1,1]` |
| `vision_started` | — | Confirmation of `VISION_START` |
| `window_move` / `window_close` | `spec` / — | The window moved or windows were closed |
| `confirm_command` | `id`, `command` | Destructive command waiting for confirmation (**40 s**) |
| `command_run` | — | Notice that a command was executed |
| `terminal_out` / `terminal_clear` | `data` / — | Pty stream and screen clear |
| `open_terminal` | — | Request to open the terminal panel in the UI |

**The WAV travels whole in base64**, not chunked: the browser decodes with `decodeAudioData`,
which needs the entire file. With Kokoro it is `wav`/24000; with ElevenLabs, `mp3`/44100.

**`motion`** carries `poses` (T×165, axis-angle for 55 SMPL-X joints) and `trans` (T×3) as float32
in base64, at 30fps. If the sidecar is down, the chunk simply travels without that field.

---

## REST API

Everything under `/api/v1`. Each route is wrapped in `handler(slug, fn)` (`api/handler.js`), which
centralizes the 500 envelope — never in `server.js`.

| Method | Route | What it does |
|---|---|---|
| `GET` | `/health` | Status, version, active providers and sidecar URLs |
| `POST` | `/session` | Creates a session → `{sessionId, expiresIn}`. **Mandatory before the WS** |
| `DELETE` | `/session/:id` | Deletes the in-memory state (the SQLite history stays) |
| `GET` | `/settings` | Provider config, **with the API keys redacted** |
| `POST` | `/settings` | Applies a whitelisted patch and persists it in `data/settings.json` |
| `GET` | `/shortcuts` | Voice shortcuts: `{sites, apps}` |
| `POST` | `/shortcuts` | Replaces the whole set and persists |
| `GET` | `/skills` | Lists the skills with their raw markdown |
| `POST` | `/skills` | Creates or edits a skill in `data/skills/<n>/SKILL.md` and reloads |
| `DELETE` | `/skills/:name` | Deletes the user's skill |
| `GET` | `/tts/voices` | Proxy to the Kokoro sidecar to populate the voice selector |
| `POST` | `/text` | Text turn **without session or WS**. A testing route |

**Middleware**: `helmet` (with CSP disabled on purpose for local testing), CORS by origin list
(`CORS_ORIGIN`), and a rate limit **that exempts localhost** — otherwise normal usage itself
exhausted the quota and everything returned 429.

**Static files: exactly one, deliberately.** The server exposes `test-client.html` at `/` and
`/test-client.html`, and nothing else. Never reintroduce `express.static('.')`: it exposed
`data/settings.json` (API keys) and `data/memory.db`.

---

## Module map

```
src/
├── server.js               Express + gateway mounting. Before serving it applies the persisted
│                           state: settings, shortcuts, skills and reference
├── config.js               THE ONLY read of process.env. Everything else reads `config`
├── gateway/websocket.js    WS protocol, auth on the upgrade, barge-in, audio buffer
├── pipeline/
│   ├── orchestrator.js     The turn: deterministic layer, LLM, sentence buffer, emission
│   ├── asr.js              Transcription (local sidecar or OpenAI)
│   ├── llm.js              OpenAI-compatible SDK; prompt, action tags, emotion parsing
│   ├── tts.js              Kokoro (sidecar) or ElevenLabs
│   ├── lipsync.js          Visemes FROM THE TEXT, not from the audio
│   ├── motion.js           The two gesture providers, with incompatible protocols
│   ├── tools.js            Tool catalog + deterministic layer + destructive-command guard
│   ├── terminal.js         A real pty per session (node-pty)
│   ├── windowControl.js    Agnostic logic for moving the overlay and for the gaze
│   ├── vision.js / vlm.js  The two vision providers (YOLO / local model)
│   ├── visionLoop.js       Continuous awareness: reacts only if the scene changed
│   └── desktop/            Per-desktop adapters: hyprland → kde → x11, plus env.js
│                           (single detection) and sh.js (running compositor commands)
├── state/
│   ├── conversationManager.js  Sessions in RAM; preloads context from SQLite
│   ├── memoryStore.js      SQLite (WAL): turns, rolling summary, embeddings
│   ├── embeddings.js       Local embeddings via Ollama
│   ├── settings.js         Hot-mutable config, with a whitelist
│   ├── skills.js           SKILL.md parser, execution and phrase triggering
│   ├── reference.js        Loading of the cheat-sheets
│   ├── shortcuts.js        Voice shortcuts (sites and apps)
│   ├── frameStore.js       Last camera frame per session
│   └── dataDir.js          Single source of truth for data/
├── api/                    REST routes (router.js registers them all)
└── utils/                  logger (winston) and timer (latency metrics)
```

---

## Configuration

All environment variable access goes through **`src/config.js`**. Never read `process.env` in
another module — the two exceptions are documented in place: the pty shell
(`terminal.js`) and the compositor detection (`desktop/*.js`).

### What you'll actually touch

| Variable | Default | What for |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3001` | **Local on purpose.** LAN access comes in through Vite |
| `LLM_BASE_URL` | `null` | OpenAI-compatible endpoint (Ollama, Groq, OpenRouter…) |
| `LLM_MODEL` | `llama-3.1-8b-instant` | Local dev uses `qwen2.5:7b` |
| `LLM_API_KEY` | — | Required only if the provider asks for it |
| `ASR_PROVIDER` | `cloud` | `local` = faster-whisper sidecar |
| `ASR_LANGUAGE` | *(empty)* | Empty = autodetection |
| `TTS_PROVIDER` | `kokoro` | Local sidecar; any other value = ElevenLabs |
| `ELEVENLABS_VOICE_ID` | `af_heart` | Legacy name: it is the voice for **both** providers. The prefix picks the language (`af_`/`am_` English, `ef_`/`em_` Spanish) |
| `VISION_PROVIDER` | `vlm` | `vlm` describes the scene; `yolo` gives object labels |
| `MOTION_PROVIDER` | `lab` | `lab` (text→motion, :8005) or `emage` (audio→motion, :8004) |
| `MOTION_ENABLED` | `true` | Only the exact string `false` turns it off |
| `TOOLS_ENABLED` | `false` | Lets the model act through tags |
| `TOOLS_SYSTEM_CONTROL` | `false` | **Master flag for the real terminal** |
| `CORS_ORIGIN` | localhost:5173 | Comma-separated list |
| `SESSION_TTL_MINUTES` | `30` | Session lifetime |
| `CONTEXT_TURNS` | `10` | History turns in the context window |
| `MEMORY_RECALL` | `true` | Long-term vector recall |
| `MEMORY_DB_PATH` | `data/memory.db` | The tests force it to `:memory:` |

The complete list is in `.env.example`, together with the Python sidecars' own variables (which the
backend does **not** read: `ASR_DEVICE`, `TTS_DEVICE`, `PANTOMATRIX_DIR`).

### Why she answers in English

`llm.protocol` pins the reply language to English. That is **not an arbitrary lock and not an
architecture limit**: it is a TTS quality decision. `af_heart` is the only Kokoro voice that
sounds good — English ships 28 voices, Spanish ships 3 and they sound bad enough that answering
in English is the better outcome.

Input is already multilingual: `ASR_LANGUAGE` is empty (auto-detect) and the sidecar returns the
detected language plus a confidence score, which `pipeline/asr.js` already receives — **nothing
downstream consumes it**. Making the output multilingual is three small changes: thread that
language through the turn, relax the protocol to "reply in the user's language", and pick the
voice by language. Worth doing the day a better multilingual TTS is plugged in; not before, or
you trade good audio for bad.

### Runtime configuration

The ⚙ panel writes `data/settings.json`, which **overrides `.env`** and is applied **without a
restart** (it mutates `config` in memory and the whole pipeline reads it on every call). Only the
fields in the whitelist of `state/settings.js` are accepted, and **the API keys are never returned
to the browser**: the `GET /settings` view is redacted.

---

## Python sidecars

Four FastAPI apps in `sidecar/`. **ASR, TTS and vision share the `sidecar/.venv` venv**; the
**motion (EMAGE) one uses the venv at the workspace root** (`../.venv`), because the RTX 5070 Ti
(Blackwell, sm_120) needs torch ≥ 2.7 with CUDA 12.8. `sidecar/common.py` centralizes the
preload of the CUDA libraries.

The scripts invoke `<venv>/bin/python -m uvicorn` and **not** the `uvicorn` console script: its
shebang broke when the repo changed paths. Keep it that way.

**The weights are not in git** (gitignored, ~700MB). A fresh clone needs to download them:

| Weights | What for | Required? |
|---|---|---|
| `sidecar/tts/kokoro-v1.0.onnx` + `voices-v1.0.bin` | Voice | **Yes**, without them she does not speak |
| `sidecar/vision/yolov8n.pt` | Object detection | Only with `VISION_PROVIDER=yolo` |
| `../hannah-motion-lab/runs/*/latest.pt` | Co-speech gestures | Yes, for her to gesture |
| faster-whisper | Local ASR | Downloads itself on first start |

---

## Security

- **The terminal is off by default.** `run_command`, skills of type `terminal` and the
  `TERMINAL_*` commands require `TOOLS_SYSTEM_CONTROL=true`.
- **There is no command allowlist.** With the flag on, anything runs in a real pty. The
  only safety net is `confirmIfDangerous()`: the `DANGER` regex (`rm`, `dd`, `mkfs`, `shutdown`,
  `git --force`…) sends a `confirm_command` and waits for an answer, with a 40 s timeout that resolves
  to *no*. It is **best-effort, not a security barrier** — it is covered by
  `tests/unit/danger.test.js`.
- **The backend listens on 127.0.0.1.** From a phone you come in through Vite (`:5173`, which does
  listen on `0.0.0.0`) and it proxies. That way the terminal, the API keys and the memory are never
  exposed. Only set `HOST=0.0.0.0` deliberately.
- **User content is never logged**: transcriptions, model responses or payloads.
  Only timings, errors and metadata.
- **The audio never touches disk**: it is processed in memory and discarded when the turn ends.

---

## Design decisions (the why)

**Sentence-by-sentence streaming, not per token and not per complete response.** The target is
<500 ms to the first sound. You cannot synthesize token by token (you need prosody); waiting for the
complete response would cost seconds. The sentence is the natural unit.

**Visemes from the text, not from the audio.** Analyzing the WAV would cost more latency than
synthesizing it. With the text the visemes come for free and in parallel with the TTS.

**The `audio_chunk`s are serialized in a promise chain.** Without that, a short sentence can be
synthesized before a longer earlier one and Hannah would speak out of order.

**One `AbortController` per turn.** That is what makes real barge-in possible: interrupting her
mid-sentence, not at the end.

**No motion retargeting onto foreign rigs.** A previous attempt to map SMPL-X onto mixamo/VRM bone
names produced the "zombie pose". The SMPL-X→VRoid mapping is **computed from the
geometry**, in the frontend.

**Per-stage failure.** Each stage sends its `{type:'error'}` and carries on. An uncaught exception
must never take the server down: `await` and `.catch` on everything fired in the background.

---

## Tests and lint

```bash
npm test              # jest in ESM mode
npm run lint          # eslint over src and tests
```

`tests/setup.js` **isolates the tests from your real data** (`MEMORY_DB_PATH=':memory:'`,
`MEMORY_RECALL=false`). Without that, the suite wrote into the real memory and called Ollama —
keep it that way.

The suites cover what decides behavior: the destructive-command guard, the parsers
(move intents, tag stripping, SKILL.md frontmatter, ssh arguments), plus `llm`,
`lipsync` and `conversationManager`. `parseLlmResponse`, `parseFrontmatter` and `sshArg` are exported
as pure helpers precisely so they can be tested; `conversationManager.dispose()` exists so that
runs finish cleanly.

---

## Known limits

Things that are **not** what you would expect, verified in the code:

- **`/health` does not ping the sidecars.** It reflects the in-memory configuration, so an `ok`
  does not mean ASR/TTS/vision/motion are alive.
- **The REST routes have no authentication.** It is a self-hosted single-user app listening on
  localhost; whoever reaches the port can delete a session or change the settings. If it is ever
  exposed to the network, this has to be solved first.
- **`POST /settings` does not validate the values** (it does not check that the provider exists or
  that the URL is valid).
- **The `TRIGGER_YOLO` turn is not abortable**: it is fired without `signal`, so `INTERRUPT` does not
  cut it.
- **`VISION_STOP` confirms nothing** to the client (there is no `vision_stopped`).
- **The allowed-apps list is baked into `config.js`** (`appAllowlist`): it is not configured
  by environment nor by the panel.
