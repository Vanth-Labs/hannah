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
npm run sidecar:sense       # the watches on :8007 (only if SENSE_ENABLED=true)
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
| Sense (the watches) | 8007 | this repo's fifth sidecar, **off by default** (`SENSE_ENABLED`) |
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

## One voice, two hands: how the persona narrates the agent

`hannah-agent` (`:8006`, off by default) runs multi-step tasks with a capable model. The rule that
governs the integration is that **the agent never speaks**. `src/pipeline/agentBridge.js`
subscribes once to the agent's event stream and, for every event that matters (accepted, needs
permission, question, done, failed), injects a `[YOUR HANDS] …` prompt into the persona through
**`processTextTurn` — the very same path the vision loop uses for `[YOUR EYES]`**. So the
narration comes out with her voice, emotion and gestures for free, and it ends with *do not
invent: the event above is the only truth about this task*. Progress is narrated at most once
per `AGENT_NARRATE_PROGRESS_MS` per task, and never while the user is mid-turn. While tasks are
alive, `[HANDS STATUS]` lines are appended to the system prompt, so "how is it going?" is answered
from the real state.

Dispatch: the persona emits `[TASK: …]` (the boundary with `[RUN:]` is written in the protocol,
and the tag only exists in the prompt when the agent is up and healthy). The orchestrator strips
it like `[MOTION:]` and calls `agentBridge.dispatch`. It is **not** part of the synchronous
action loop in `llm.js` — a task takes minutes and reports back as events.

Approvals by voice (`routeUtterance`) enforce three rules in code: an utterance only counts if it
**started after** the question was asked (`SPEECH_START` is stamped for that); "sí/no/para" are
decided lexically, everything else by a one-word classification whose only valid outputs are
`ALLOW/DENY/CANCEL/ANSWER`; and **ambiguity never grants** — a pending approval expires into
deny, and the user is told. `high`-risk actions refuse voice entirely and point at the HUD button.
Barge-in aborts the narration, never the task. If the event stream is lost for
`AGENT_LOST_CONTACT_MS` with a task alive, it is reported as **lost, not finished**.

Verified without a model or a live agent: `tests/unit/agentBridge.test.js` feeds the bridge the
agent's own fixtures (`hannah-agent/docs/fixtures/*.jsonl`) with a spy in place of
`processTextTurn`.

## The eyes that stay open: `hannah-sense`

A watch is a **standing state of attention**: it outlives the conversation turn and keeps looking
at a process, a file's mtime, a log tail, a port or a systemd unit. It cannot be an agent task
(one-hour timebox, one lane, an approval that denies by silence in two minutes) and it cannot be a
loop in this process (the risk tiers, the path denylist and the audit trail all live on the agent's
side of the seam). So it is the fifth sidecar, `sidecar/sense/` on **127.0.0.1:8007**.

**It observes and never acts.** Every corrective action stays an ordinary agent task, so there is
one actuator and one place to look when something happened. The sidecar spawns nothing outside its
own probes, and everything it runs goes through an argv list with `shell=False` — a sensor is a
**typed spec** (`{kind, ...}` from a closed catalog), never a command string, so a pattern of
`; rm -rf ~` has nowhere to land. Every path is classified before use against the *generated*
denylist asset from `agent/docs/fixtures/policy-paths.json`, with golden cases asserting both
implementations still agree; without the asset it fails closed.

**What she says, and when.** `senseBridge.js` holds one process-wide SSE subscription (resume by
`Last-Event-ID`, per-watch `seq` dedupe) and narrates through `processTextTurn`, the same path the
camera and the hands use. Three rules are this feature's own, and each one is a bug if it is
dropped: a trip binds to the session that armed the watch and goes to a **durable inbox** if that
session is gone, instead of falling back to whoever attached last; watch narration is **ephemeral**
(no `memory.db` row, no embedding), so eight hours of watching cannot evict the real conversation;
and after `SENSE_BLIND_MS` with no sample the watch is **blind and she says so**, because a watch
that believes it is looking and is not is the worst failure this feature has. There is **no
heartbeat event**: four quiet hours produce nothing, and liveness is answered on demand from
`GET /api/v1/watches` or from `hannah doctor`'s `vigilancia:` line.

`[WATCH:]` is assembled from a **live capability probe**, like the macro catalog: a rung whose tool
is missing is absent from the ladder, so she cannot promise a watch that would fail hours later.
With `SENSE_ENABLED=false` the vocabulary is not built at all.

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
| `AGENT_APPROVAL` | `taskId`, `approvalId`, `decision` | HUD button on an agent approval (`by: hud` — the only attribution that can grant `high` risk) |
| `AGENT_ANSWER` | `taskId`, `questionId`, `answer` | HUD answer to an agent question |
| `AGENT_CANCEL` | `taskId` | Cancel the running task |
| `WATCH_DISARM` | `watchId` | Stops a watch. The **only** way the HUD can: `/api/v1/watches` refuses anything carrying an `Origin` |

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
| `agent_task_started` / `agent_task_progress` / `agent_task_done` | `taskId`, `title`, `state`, `kind`, `data` | The hands' task lifecycle, for the HUD. `kind` names the source event (`plan`, `progress`, `tool`…) |
| `agent_approval_request` / `agent_question` | + `expiresAt` | The hands need a yes/no or an answer; silence expires into **deny** |
| `agent_command_failed` | `command`, `taskId`, `reason` | A HUD/voice action could not be applied (e.g. `hud_confirmation_required`) |
| `watch_armed` | `watchId`, `label`, `rung`, `tier`, `expiresAt` | A watch started |
| `watch_state` | `watchId`, `state`, `lastSampleAt`, `samplesOk`, `fires` | Its state or counters moved (`armed`, `blind`, `suspended`…) |
| `watch_tripped` | `watchId`, `label`, `at`, `confidence` | The thing she was watching stopped |
| `watch_disarmed` | `watchId`, `reason` | `user` · `expired` · `shutdown` · `faulted` |

The watch rows carry **no sample value, no matched log line, no path and no host** — by design, and
enforced by a whitelist in `api/watches.js` rather than by trusting the sidecar's shape.

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
| `GET` | `/health` | Status, version, active providers and sidecar URLs, plus `watches: {armed, degraded, blind, suspended, lastSampleAt}` |
| `POST` | `/session` | Creates a session → `{sessionId, expiresIn}`. **Mandatory before the WS** |
| `DELETE` | `/session/:id` | Deletes the in-memory state (the SQLite history stays) |
| `GET` | `/settings` | Provider config, **with the API keys redacted** |
| `POST` | `/settings` | Applies a whitelisted patch and persists it in `data/settings.json` |
| `GET` | `/tts/preview?voice=<id>` | A short sample sentence in that voice, as `audio/wav` (Kokoro ids only; 400 on a bad id, 503 without the sidecar). Powers the "Listen" button in the ⚙ panel |
| `GET`/`HEAD` | `/avatar` | The user's uploaded VRM (`data/avatar.vrm`), `model/gltf-binary` with an `ETag`; 404 when there is none, so the frontend falls back to the bundled avatar |
| `GET` | `/avatar/info` | `{ custom, name, size, updatedAt }` for the ⚙ panel |
| `PUT` | `/avatar` | Raw body up to 256 MB. Only a glTF binary whose `extensionsUsed` lists `VRM` (0.x) or `VRMC_vrm` (1.0) is accepted (`isVrmBinary`, `api/avatar.js`); anything else is 400 `not_a_vrm`. Written atomically |
| `DELETE` | `/avatar` | Back to the bundled avatar |
| `GET` | `/shortcuts` | Voice shortcuts: `{sites, apps}` |
| `POST` | `/shortcuts` | Replaces the whole set and persists |
| `GET` | `/skills` | Lists the skills with their raw markdown |
| `POST` | `/skills` | Creates or edits a skill in `data/skills/<n>/SKILL.md` and reloads |
| `DELETE` | `/skills/:name` | Deletes the user's skill |
| `GET` | `/tts/voices` | Proxy to the Kokoro sidecar to populate the voice selector |
| `GET`/`POST` | `/watches` | List the watches, or arm one. See below: these three are the one place the backend is **stricter than its own default** |
| `DELETE` | `/watches/:id` | Disarm one |

**`/api/v1/watches` requires the UI token even on loopback, and 403s any request carrying an
`Origin`.** `authorize()` serves any loopback client with no token, and for the rest of the API
that is right — nothing moves unless a human says something. A watch is the first primitive here
that runs with **no human utterance at all**, so it does not inherit that default. The consequence
is intended: the HUD, being a browser, cannot use these routes, which is why it learns about
watches over the WebSocket and disarms with `WATCH_DISARM`. These routes are for what is not a
browser — the launcher and `hannah doctor`. They never return a command string.

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
│   ├── senseClient.js      Transport to hannah-sense (:8007). Nothing here throws: it returns
│   │                       { error, reason }, because the 403 of a denied path carries the
│   │                       exact sentence the user has to hear
│   ├── senseBridge.js      One SSE subscription per process: narration, the trip inbox and the
│   │                       blindness clock (which runs here too, since a dead sidecar emits
│   │                       nothing at all)
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
└── ../sidecar/sense/       hannah-sense, the fifth sidecar (Python, :8007): scheduler, registry,
                            the six sensors and the shared path denylist. Its OWN venv
├── api/                    REST routes (router.js registers them all); `watches.js` is the one
│                           control plane that needs the UI token even on loopback
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

### The watches (`SENSE_*`)

Everything ships **off**, and while `SENSE_ENABLED` is false the `[WATCH:]` vocabulary is not even
assembled, so she cannot promise a watch nobody would arm.

| Variable | Default | What for |
|---|---|---|
| `SENSE_ENABLED` | `false` | The master flag. `./hannah` starts `:8007` only when this is true |
| `SENSE_SIDECAR_URL` | `http://127.0.0.1:8007` | Where the sidecar is |
| `HANNAH_SENSE_TOKEN` | *(empty)* | Bearer for `:8007`. **Empty closes the sidecar, it does not open it**: every route but `/health` answers 401. The launcher generates it into `.env` (0600) when missing |
| `SENSE_MAX_WATCHES` | `2` | Two and not five: five at a 15 s period is twenty subprocess spawns a minute, forever, on a machine already running four sidecars |
| `SENSE_MIN_PERIOD_MS` | `15000` | Floor of the sampling period |
| `SENSE_DEBOUNCE_N` | `3` | Consecutive bad samples before a trip |
| `SENSE_BLIND_MS` | `120000` | No sample for this long → `blind`, and she says it out loud |
| `SENSE_COOLDOWN_MS` | `600000` | Floor of the cooldown between fires (P5.2) |
| `SENSE_MAX_FIRES` | `2` | Fires per window; after the last one the watch disarms itself **and says so** (P5.2) |
| `SENSE_ASK_TIMEOUT_MS` | `900000` | How long a question born of a trip waits (P5.2) |
| `SENSE_WATCH_TTL_MS` | `28800000` | How long a voice-armed watch lives (8 h, "until the morning"); the sidecar caps anything over 24 h |
| `SENSE_SSH_ENABLED` · `SENSE_SCREEN_ENABLED` · `SENSE_GUI_ENABLED` | `false` | The three tiers that do not exist yet (P5.3, P5.5, P5.6). They are read anyway so that *off* and *absent* are the same observable state |

**The caps are read twice, on purpose, and the launcher keeps them equal.** The sidecar has its own
single reader (`sidecar/sense/config.py`) because it is a separate process, and `npm run` does not
load the `.env` — so `./hannah` exports `SENSE_MAX_WATCHES`, `SENSE_MIN_PERIOD_MS`,
`SENSE_DEBOUNCE_N` and `SENSE_BLIND_MS` when it starts it. Without that, the backend would say
"two watches at most" *out loud, at arm time* while the sidecar enforced a different number.

The knobs are **not** editable from the ⚙ panel (`state/settings.js` allows only `sense.url` and
`sense.token`): they are the bounds of a primitive that runs with no human utterance, and widening
them with a click is exactly what the bounds exist to prevent.

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

### Who runs the model's free-form commands (`TOOLS_RUN_POLICY`)

Three things can act on the machine: the **deterministic layer** (window moves, open/close, list/
read/create/delete parsed from the user's own words), **skills** (`SKILL.md`: the model picks the
name, the backend builds the command) and the model's **free-form `[RUN: cmd]`**. The first two
are local, instant and model-independent. `[RUN:]` is the weak spot: no allowlist, only the
`DANGER` regex as a net, and a 7B model deciding on its own what to type. When the hands (the
agent) are on, they have risk tiers, approvals, an audit log and undo — so the policy decides
where a `[RUN:]` goes:

| `TOOLS_RUN_POLICY` | `[RUN:]` in the prompt | a stray `[RUN:]` from the model |
|---|---|---|
| `agent-first` (default when `AGENT_ENABLED=true`) | no, while the hands are healthy; yes if they are off or down | converted into a `[TASK:]` for the agent (`handleRunTag`, `llm.js`); the persona says "on it" and narrates the result |
| `skills-only` | never | refused; the model is told to use a skill or say it cannot |
| `free` (default without agent) | yes, with the command cheat-sheets | runs in the pty, as before |

Skills, the deterministic layer and the human's terminal panel (`TERMINAL_*`) are untouched by
the policy. **The terminal panel also echoes the hands**: every command the agent runs (`[hands] $
…`) and the first lines of its output show up there, read-only, with a backlog for when the panel
is opened later — one place to see what ran on the machine, whoever ran it.

### Who may talk to the backend

The backend still binds to `127.0.0.1`, but Vite proxies `/api` and `/ws` to it, so "loopback"
only means something once you know who is behind the proxy. `src/api/auth.js` decides:

- a client on **this machine** (the Electron app, a local browser through Vite) is served as-is;
- anything else — another device on the LAN, reachable only when Vite runs with `HANNAH_LAN=1`,
  i.e. `./hannah services` — must present the **UI token** (`Authorization: Bearer …` or
  `?token=` on the WebSocket URL). The token is `HANNAH_UI_TOKEN` or `data/ui-token`, generated
  on first run with mode `0600`; the launcher prints the URL with it.

The real client address is the **last** entry of `X-Forwarded-For` (Vite adds it with `xfwd`),
so a client cannot spoof itself into loopback. The rate limiter uses the same address. `/health`
and `GET /avatar` (the 3D model, fetched by the loader without headers) are the only exceptions.
The old `POST /api/v1/text` test route is gone: it ran the action loop without a session.

Other hardening in the same spirit: the pty and the agent never inherit `*_API_KEY`/`*_TOKEN`
variables; `settings.json`, `memory.db` and `ui-token` are written `0600`; `fetch_url` refuses
loopback, private and link-local addresses (`publicHostOnly`); what the camera sees is injected
with `noActions` (a sign held up to the webcam cannot trigger a command); `kdotool` is called with
argv, never through a shell; `NODE_ENV` defaults to `production` (no stack traces to clients).

### Runtime configuration

The ⚙ panel writes `data/settings.json`, which **overrides `.env`** and is applied **without a
restart** (it mutates `config` in memory and the whole pipeline reads it on every call). Only the
fields in the whitelist of `state/settings.js` are accepted, and **the API keys are never returned
to the browser**: the `GET /settings` view is redacted. **A blank field means "keep what is there"**,
never "clear it": the panel posts the whole form, so filling in only the agent's key used to arrive
with `model: ""` and `baseUrl: ""` for the brain (pointing the backend at OpenAI with no model) and
`agent.url: ""` (hands permanently "unavailable"). To change a provider, write the new value or pick
a preset.

---

## Python sidecars

Five FastAPI apps in `sidecar/`. **ASR, TTS and vision share the `sidecar/.venv` venv**; the
**motion (EMAGE) one uses the venv at the workspace root** (`../.venv`), because the RTX 5070 Ti
(Blackwell, sm_120) needs torch ≥ 2.7 with CUDA 12.8. `sidecar/common.py` centralizes the
preload of the CUDA libraries.

**`sense` has a third venv, `sidecar/sense/.venv`, created with `--system-site-packages`** — the
screen and AT-SPI rungs that come later need `gi` and `dbus`, which are distro packages. It is
deliberately not the shared one: that venv pins numpy and onnxruntime-gpu for faster-whisper,
Kokoro and YOLO, so adding the system site-packages to it would break the voice at runtime and in
silence. `site/install.sh` creates both.

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
