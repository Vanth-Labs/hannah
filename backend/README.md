# Hannah — Real-Time AI Avatar · Backend (Node.js)

> **For AI coding agents:** This document is the single source of truth for the backend architecture of the Hannah project. Read it fully before writing any code. Every module, route, technology decision, and constraint described here is intentional and must be respected across all sessions.

---

## Table of Contents

0. [Quick Start](#0-quick-start)
1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Technology Stack](#4-technology-stack)
5. [Module Specifications](#5-module-specifications)
   - 5.1 [ASR — Speech Recognition](#51-asr--speech-recognition)
   - 5.2 [LLM — Dialogue & Intent](#52-llm--dialogue--intent)
   - 5.3 [TTS — Voice Synthesis](#53-tts--voice-synthesis)
   - 5.4 [Lip-Sync Data Generation](#54-lip-sync-data-generation)
   - 5.5 [WebSocket Gateway](#55-websocket-gateway)
   - 5.6 [REST API](#56-rest-api)
   - 5.7 [State Manager](#57-state-manager)
   - 5.8 [Privacy & Security Layer](#58-privacy--security-layer)
6. [Data Flow](#6-data-flow)
7. [Latency Targets](#7-latency-targets)
8. [Environment Variables](#8-environment-variables)
9. [API Reference](#9-api-reference)
10. [MVP Scopes](#10-mvp-scopes)
11. [Roadmap & Phases](#11-roadmap--phases)
12. [Development Rules for Agents](#12-development-rules-for-agents)
13. [Repository Setup Instructions](#13-repository-setup-instructions)

---

## 0. Quick Start

If you have cloned this repository, follow these steps to get the backend running:

1.  **Install Dependencies**:
    ```bash
    npm install
    ```
2.  **Configure Environment**:
    ```bash
    cp .env.example .env
    ```
    The default `.env.example` targets a **fully local stack** (Ollama LLM + local sidecars). For cloud providers, set `ASR_PROVIDER=cloud` + `OPENAI_API_KEY`, and point `LLM_BASE_URL`/`LLM_API_KEY` at Groq.
3.  **Start the Python sidecars** (each in its own terminal; venv lives at `sidecar/.venv`):
    ```bash
    npm run sidecar:asr      # faster-whisper on :8001 (only if ASR_PROVIDER=local)
    npm run sidecar:tts      # Kokoro TTS on :8002 (required for voice output)
    npm run sidecar:vision   # YOLOv8 on :8003 (only for camera vision)
    npm run sidecar:motion   # EMAGE gestures on :8004 (venv at <workspace>/.venv; needs ~/PantoMatrix)
    ```
4.  **Start Development Server**:
    ```bash
    npm run dev
    ```
    The server will be live at `http://localhost:3001`.
5.  **Run tests**:
    ```bash
    npm test
    ```

---

## 1. Project Overview

**Hannah** is a real-time interactive AI avatar system. The backend is a Node.js server that acts as the central pipeline coordinator between:

- A browser/app client (frontend — separate repo)
- External AI services (Whisper ASR, Claude/GPT LLM, ElevenLabs/Coqui TTS)
- A Python sidecar process (for ML tasks Node.js cannot handle natively)

**What the backend does:**

- Receives raw audio chunks from the client via WebSocket
- Streams audio to ASR → gets transcript text
- Sends transcript to LLM → gets response text
- Sends response text to TTS → gets synthesized audio
- Extracts viseme/phoneme data from the TTS output for lip-sync
- Sends synthesized audio + lip-sync data + emotion tags back to the client in real time
- Manages conversation state (multi-turn context)
- Enforces privacy rules (no raw audio/video stored)

**What the backend does NOT do:**

- Render any 3D/2D graphics (that is the frontend's job)
- Run MediaPipe face tracking (runs in the browser)
- Store permanent user data without explicit consent

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser/App)                  │
│  Microphone → WebAudio → WebSocket client                    │
│  Three.js avatar ← audio + visemes + emotion ← WebSocket     │
└─────────────────────────┬───────────────────────────────────┘
                          │  WebSocket (binary audio chunks + JSON)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   NODE.JS BACKEND SERVER                      │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │  WebSocket  │   │  REST API    │   │  State Manager   │  │
│  │  Gateway    │   │  (Express)   │   │  (conversation   │  │
│  │  (Port 3001)│   │              │   │   context/turns) │  │
│  └──────┬──────┘   └──────────────┘   └──────────────────┘  │
│         │                                                      │
│         ▼                                                      │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    PIPELINE ORCHESTRATOR                  │ │
│  │                                                           │ │
│  │  [1] ASR Module → [2] LLM Module → [3] TTS Module        │ │
│  │        ↓                                  ↓               │ │
│  │  transcript text              audio buffer + visemes       │ │
│  └──────┬────────────────────────────────────┬─────────────┘ │
│         │                                    │                 │
│         ▼                ▼               ▼             ▼       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Whisper    │  │ YOLO       │  │ Kokoro     │  │ EMAGE    │ │
│  │ ASR (8001) │  │ Vis (8003) │  │ TTS (8002) │  │ Mo (8004)│ │
│  └────────────┘  └────────────┘  └────────────┘  └──────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │  External HTTPS calls
          ┌───────────────┼────────────────────┐
          ▼               ▼                    ▼
   OpenAI Whisper   Groq LLaMA 3.1       ElevenLabs TTS
   (ASR Cloud)      (LLM Cloud)          (Fallback Cloud)
```

### Streaming Strategy

All pipeline stages stream output — do NOT wait for a full response before passing to the next stage:

```
Audio chunks → ASR partial transcript → LLM token stream → TTS audio chunks → Client
```

This is mandatory to achieve the <500ms latency target.

---

## 3. Repository Structure

```
hannah-backend/
│
├── src/
│   ├── server.js                  # Entry point — starts HTTP + WS server
│   ├── config.js                  # Loads and validates env vars
│   │
│   ├── gateway/
│   │   └── websocket.js           # WebSocket connection handler
│   │
│   ├── pipeline/
│   │   ├── orchestrator.js        # Coordinates ASR → LLM → TTS flow (voice + text turns)
│   │   ├── asr.js                 # ASR module (Whisper cloud or local sidecar)
│   │   ├── llm.js                 # LLM module (OpenAI-compatible: Groq / Ollama)
│   │   ├── tts.js                 # TTS module (Kokoro sidecar / ElevenLabs fallback)
│   │   ├── lipsync.js             # Viseme extraction (Phonetic heuristic mapping)
│   │   ├── vision.js              # YOLO sidecar client (analyze-scene)
│   │   └── visionLoop.js          # Per-session camera frame loop (4s cadence)
│   │
│   ├── state/
│   │   └── conversationManager.js # Multi-turn context, session store
│   │
│   ├── api/
│   │   ├── router.js              # Express router — mounts all routes
│   │   ├── health.js              # GET /health
│   │   └── sessions.js            # POST /session, DELETE /session/:id
│   │
│   ├── privacy/                   # (Planned) Sanitizer and privacy filters
│   │
│   └── utils/
│       ├── logger.js              # Structured logging
│       └── timer.js               # Latency measurement per pipeline stage
│
├── sidecar/                       # Python FastAPI sidecars (venv at sidecar/.venv)
│   ├── asr/main.py                # faster-whisper — port 8001 (npm run sidecar:asr)
│   ├── tts/main.py                # Kokoro ONNX — port 8002 (npm run sidecar:tts)
│   ├── vision/main.py             # YOLOv8 — port 8003 (npm run sidecar:vision)
│   ├── motion/                    # EMAGE gestures — port 8004 (npm run sidecar:motion)
│   │   ├── main.py                #   venv aparte en <workspace>/.venv (uv, py3.12, torch cu128)
│   │   ├── build_avatar.py        #   one-time: SMPL-X GLB texturizado para el frontend
│   │   └── requirements.txt
│   └── requirements.txt
│
├── tests/
│   └── unit/                      # jest (ESM) — lipsync, llm parsing, conversationManager
│
├── .env.example                   # Template for all required env vars
├── .env                           # Local secrets — NEVER commit this
├── .gitignore
├── package.json
├── package-lock.json
└── README.md                      # This file
```

---

## 4. Technology Stack

### Core Runtime

| Layer           | Technology   | Version  | Why                                            |
| --------------- | ------------ | -------- | ---------------------------------------------- |
| Runtime         | Node.js      | ≥ 20 LTS | Long-term support, native fetch, async streams |
| HTTP server     | Express      | 4.x      | Minimal, well-supported                        |
| WebSocket       | `ws` library | 8.x      | Low-level, performant, works with raw binary   |
| Process manager | PM2          | Latest   | Restart on crash, cluster mode                 |

### AI Services

| Module | Primary (Cloud)                             | Fallback (Local/Sidecar)          | Why                                                        |
| ------ | ------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| ASR    | OpenAI Whisper API                          | faster-whisper via Python sidecar | Whisper best multilingual accuracy; local for offline/cost |
| LLM    | Groq (LLaMA 3.1 8B)                         | —                                 | Ultra-low latency inference; essential for <500ms target   |
| TTS    | Kokoro TTS (Port 8002)                      | ElevenLabs (Cloud Fallback)       | Kokoro best speed/quality balance; local execution         |
| Vision | YOLO v8 (Port 8001)                         | —                                 | Real-time scene analysis and object detection              |

### Supporting Libraries

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "dotenv": "^16.0.0",
    "@anthropic-ai/sdk": "^0.24.0",
    "openai": "^4.47.0",
    "axios": "^1.6.0",
    "uuid": "^9.0.0",
    "winston": "^3.13.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.3.0"
  },
  "devDependencies": {
    "jest": "^29.0.0",
    "nodemon": "^3.1.0",
    "supertest": "^7.0.0"
  }
}
```

### Python Sidecar Dependencies (`sidecar/requirements.txt`)

```
fastapi==0.111.0
uvicorn==0.30.0
faster-whisper==1.0.1
TTS==0.22.0
python-multipart==0.0.9
numpy==1.26.4
```

---

## 5. Module Specifications

### 5.1 ASR — Speech Recognition

**File:** `src/pipeline/asr.js`

**Responsibility:** Convert raw audio (PCM/WAV/WebM chunks) to text transcript.

**Primary path (cloud):** OpenAI Whisper API

- Endpoint: `https://api.openai.com/v1/audio/transcriptions`
- Model: `whisper-1`
- Language: auto-detect (supports Spanish — primary language of this project)
- Input: audio buffer (WAV, WebM, MP3 — max 25MB per request)

**Fallback path (local):** Python sidecar at `http://localhost:8001/asr`

- Model: `faster-whisper` with `small` model on CPU, `medium` on GPU
- Triggered when: `ASR_PROVIDER=local` in env, or cloud call fails

**Streaming behavior:**

- Client sends audio in chunks via WebSocket
- Chunks are buffered until a silence threshold is detected (VAD)
- Then the buffer is sent to ASR as one segment
- Partial transcripts are NOT streamed from Whisper (it returns full segment)

**Output contract:**

```js
{
  transcript: "string",       // recognized text
  language: "es",             // detected language code
  confidence: 0.97,           // float 0–1 (if available)
  duration_ms: 240            // time spent in ASR
}
```

**Error handling:** On timeout (>3s) or API error, send `{ error: "asr_failed" }` to client and skip this turn.

---

### 5.2 LLM — Dialogue & Intent

**File:** `src/pipeline/llm.js`

**Responsibility:** Receive transcript text + conversation history → return response text + optional emotion tag.

**Primary:** Groq (`llama-3.1-8b-instant`) via OpenAI-compatible SDK.

**System prompt:** Loaded from `src/config.js` (configurable via env). Default:

```
You are Hannah, a helpful and expressive AI avatar.
Respond conversationally and concisely (1–3 sentences).
Respond in the same language the user speaks.
At the end of each response, append an emotion tag on a new line in the format:
[EMOTION:neutral|happy|surprised|thinking|sad]
```

**Streaming:** YES — stream tokens as they arrive and pipe directly to TTS module. Do not wait for full response.

**Context window management:**

- Keep last N turns (default: `CONTEXT_TURNS=10` from env)
- Managed by `conversationManager.js`
- On session start, inject system prompt as first message

**Output contract:**

```js
{
  text: "string",             // response text (without emotion tag)
  emotion: "happy",           // parsed from [EMOTION:...] tag
  tokens_used: 142,           // for monitoring
  duration_ms: 380
}
```

---

### 5.3 TTS — Voice Synthesis

**File:** `src/pipeline/tts.js`

**Responsibility:** Convert response text → synthesized speech audio buffer.

**Primary:** Kokoro TTS via Python sidecar at `TTS_SIDECAR_URL` (default `http://127.0.0.1:8002`)

- Endpoint: `POST /v1/audio/speech`
- Output format: `wav`, 24000 Hz
- Voice ID: configurable via `ELEVENLABS_VOICE_ID` (legacy env var name; default `af_bella`)

**Fallback:** ElevenLabs cloud (`TTS_PROVIDER` other than `kokoro`, requires `ELEVENLABS_API_KEY`)

Each sentence's audio is accumulated into a complete WAV before being sent to the client as one `audio_chunk` message — the browser decodes with `decodeAudioData`, which needs the whole file.

**Output contract:**

```js
{
  audioBuffer: Buffer,        // raw audio bytes (mp3 or wav)
  format: "wav",              // or "mp3"
  duration_ms: 1200,          // estimated audio duration
  sample_rate: 24000,         // Kokoro typical sample rate
  tts_latency_ms: 150         // time to first byte
}
```

---

### 5.4 Lip-Sync Data Generation

**File:** `src/pipeline/lipsync.js`

**Responsibility:** Generate viseme timing data synchronized with TTS audio, to drive avatar mouth animation on the frontend.

**Approach (two options, configurable):**

**Option A — Text-based viseme mapping (default, fast):**

- Parse response text into phonemes using a phoneme library (`phoneme` npm package or custom rules)
- Map phonemes → ARKit viseme names (standardized set of 15 blendshape targets)
- Estimate timing based on TTS audio duration and syllable count
- Cheap and fast (<5ms); acceptable quality for MVP

**Option B — Audio-based viseme extraction (higher quality):**

- Analyze TTS audio buffer with `Web Audio API`-equivalent processing
- Extract energy/frequency per time window (10ms frames)
- Map frequency bands → viseme weights
- Higher realism; adds ~50ms processing time

**ARKit Viseme targets used:**

```
sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, I, O, U
```

**Output contract:**

```js
{
  visemes: [
    { time_ms: 0,   viseme: "sil", weight: 0.0 },
    { time_ms: 80,  viseme: "aa",  weight: 0.9 },
    { time_ms: 160, viseme: "PP",  weight: 0.7 },
    // ...
  ],
  duration_ms: 1200
}
```

This array is sent to the frontend alongside the audio buffer so the avatar can animate in sync.

---

### 5.5 WebSocket Gateway

**File:** `src/gateway/websocket.js`

**Responsibility:** Manage real-time bidirectional communication with the client.

**Connection flow:**

1. Client connects to `ws://host/ws?sessionId=<uuid>`
2. Server validates session via `ConversationManager`.
3. Client streams raw audio chunks as binary WebSocket frames.
4. Server emits JSON messages back to the client.

**Incoming message types (client → server):**

| Type         | Payload           | Description                                      |
| ------------ | ----------------- | ------------------------------------------------ |
| `binary`     | raw audio bytes   | Audio chunk from microphone (PCM/WAV)            |
| `JSON`       | `{ command: "SPEECH_START" }` | Resets buffers for a new utterance. |
| `JSON`       | `{ command: "SPEECH_END" }`   | Triggers the pipeline processing.   |

**Outgoing message types (server → client):**

```js
// Transcript acknowledgment (ASR result)
{ type: "user_transcript", text: "Hola, ¿cómo estás?" }

// Audio Segment (Sent per sentence as they are generated)
{ 
  type: "audio_chunk", 
  text: "Hola, soy Hannah.", 
  visemes: [ { time_ms, viseme, weight }, ... ],
  audioBase64: "..." // Base64 encoded MP3/WAV chunk
}

// Turn completion
{ 
  type: "turn_complete", 
  emotion: "happy", 
  metrics: { llm_ms: 450 } 
}

// Error
{ type: "error", message: "Error interno de procesamiento" }
```

**Concurrency:** Each WebSocket connection is independent. Sessions are tied to the `sessionId` query parameter.

---

### 5.6 REST API

**File:** `src/api/router.js`

**Base URL:** `http://host:PORT/api/v1`

| Method   | Path           | Description                                                        |
| -------- | -------------- | ------------------------------------------------------------------ |
| `GET`    | `/health`      | Server health + dependency status                                  |
| `POST`   | `/session`     | Create new session, returns `sessionId` and TTL                    |
| `DELETE` | `/session/:id` | End session, purge from memory                                     |
| `POST`   | `/text`        | HTTP fallback — send text, get full response envelope (validation) |

---

### 5.7 State Manager

**File:** `src/state/conversationManager.js`

**Responsibility:** Maintain per-session conversation history and metadata.

**Rules:**
- Sessions expire after `SESSION_TTL_MINUTES`.
- Automatic garbage collection runs every 5 minutes.
- Strictly maintains `CONTEXT_TURNS` window (default 10).
- Data is kept in RAM using a `Map`.

---

### 5.8 Privacy & Security Layer

**Rules (mandatory):**
1. **No raw audio stored.** Audio is processed in memory and buffers are cleared immediately after `SPEECH_END` processing.
2. **No video processed server-side.**
3. **Logs contain no PII.** Transcripts and responses are never logged.
4. **GDPR/CCPA Compliance.** API consumers must obtain consent before creating a session.

---

## 6. Data Flow

Complete end-to-end flow for one conversational turn:

```
[1] Client sends { command: "SPEECH_START" }
[2] Client streams binary audio chunks via WebSocket
[3] Client sends { command: "SPEECH_END" }
[4] Server ASR (Whisper) transcribes full buffer
[5] Server emits { type: "user_transcript", text }
[6] Server LLM (Groq) generates response text (buffered per sentence)
[7] For each sentence:
    a. TTS (Kokoro) synthesizes audio chunk
    b. LipSync generates viseme timeline
    c. Server emits { type: "audio_chunk", text, visemes, audioBase64 }
[8] Server emits { type: "turn_complete", emotion }
```

Target total latency (step 3 to first step 7c): **< 500ms**.

---

## 7. Latency Targets

Based on the MascotBot benchmark (7-stage pipeline achieving ~340ms P50):

| Stage                                | Budget      | Notes                  |
| ------------------------------------ | ----------- | ---------------------- |
| Audio capture + send                 | ~50ms       | Client-side            |
| ASR (Whisper API)                    | ~150ms      | Cloud; local is slower |
| LLM (Groq, time to first token)      | ~100ms      | Streaming helps        |
| TTS (Kokoro, time to first byte)     | ~100ms      | Streaming endpoint     |
| Viseme generation                    | <10ms       | Text-based method      |
| **Total end-to-end (P50 target)**    | **< 400ms** |                        |

**Mandatory:** measure and log latency for every stage, every turn, using `src/utils/timer.js`. Alert (log warning) if any stage exceeds its budget by 2×.

---

## 8. Environment Variables

Copy `.env.example` to `.env`. Never commit `.env`.

```bash
# Server
PORT=3001
NODE_ENV=development
LOG_LEVEL=info

# ASR (Whisper) — cloud (OpenAI) o local (sidecar :8001)
ASR_PROVIDER=local
WHISPER_MODEL=small
# OPENAI_API_KEY=sk-...           # solo con ASR_PROVIDER=cloud
ASR_SIDECAR_URL=http://127.0.0.1:8001

# LLM — cualquier endpoint OpenAI-compatible (Groq, Ollama, OpenRouter)
LLM_PROVIDER=openai-compatible
LLM_API_KEY=ollama                # Groq: gsk_...
LLM_BASE_URL=http://localhost:11434/v1   # Groq: https://api.groq.com/openai/v1
LLM_MODEL=llama3.1:8b             # Groq: llama-3.1-8b-instant
CONTEXT_TURNS=10

# TTS (Kokoro, sidecar :8002)
TTS_PROVIDER=kokoro
TTS_SIDECAR_URL=http://127.0.0.1:8002
ELEVENLABS_VOICE_ID=af_bella # Kokoro uses this variable for voice ID

# Vision (YOLO, sidecar :8003)
VISION_SIDECAR_URL=http://127.0.0.1:8003

# Motion (EMAGE / PantoMatrix, sidecar :8004)
MOTION_SIDECAR_URL=http://127.0.0.1:8004
MOTION_ENABLED=true
# PANTOMATRIX_DIR=~/PantoMatrix   # repo con los pesos (por defecto ~/PantoMatrix)

# Session
SESSION_TTL_MINUTES=30

# Security — lista separada por comas (Vite dev server usa https)
CORS_ORIGIN=https://localhost:5173,http://localhost:5173
```

**Canonical sidecar port map: ASR 8001 · TTS 8002 · Vision 8003 · Motion 8004** (matches the `sidecar:*` npm scripts).

### Motion sidecar (EMAGE) — notes

- Venv separado en la **raíz del workspace** (`Hannah-Motion/.venv`, creado con `uv`, Python 3.12): la GPU (RTX 50xx / Blackwell) exige torch ≥ 2.7 con wheels **cu128**, incompatible con el stack py3.9/torch2.0 que fija el repo PantoMatrix.
- Pesos y modelo SMPL-X se cargan **offline** desde `~/PantoMatrix` (`PANTOMATRIX_DIR`).
- Salida por oración: `poses (T×165 axis-angle, 55 joints SMPL-X, 30fps)` + `trans (T×3)`, adjunta como campo `motion` del mensaje `audio_chunk`.
- El avatar del frontend (`hannah-frontend/public/smplx_avatar.glb`) se genera con `build_avatar.py`: esqueleto = joints SMPL-X con rotación de reposo identidad → el axis-angle de EMAGE se aplica 1:1, **sin retargeting**. Textura albedo oficial del addon de Blender de SMPL-X.
- ⚠️ Licencia del modelo SMPL-X (MPI): **uso no comercial / investigación**.

---

## 9. API Reference

### WebSocket: `ws://localhost:3001/ws`

Query params: `?sessionId=<uuid>` (get from `POST /api/v1/session` first)

### `GET /api/v1/health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "services": {
    "asr": "cloud",
    "llm": "groq",
    "tts": "kokoro",
    "sidecar": "disabled"
  },
  "uptime_s": 3421
}
```

### `POST /api/v1/session`

Request: `{}` (empty body for now)

Response:

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 1800
}
```

### `POST /api/v1/text` (HTTP fallback, non-streaming)

Request:

```json
{
  "sessionId": "...",
  "text": "Hola, ¿cómo te llamas?"
}
```

Response:

```json
{
  "transcript": "Hola, ¿cómo te llamas?",
  "response": "Me llamo Hannah. ¿En qué puedo ayudarte?",
  "emotion": "happy",
  "audioBase64": "...",
  "audioFormat": "mp3",
  "visemes": [ ... ],
  "latency": {
    "llm_ms": 380,
    "tts_ms": 290,
    "total_ms": 710
  }
}
```

---

## 10. MVP Scopes

### MVP Básico (Target: ~3 months from start)

- [x] WebSocket gateway running
- [x] Audio chunk buffering with end-of-utterance detection
- [x] ASR via Whisper cloud
- [x] LLM via Claude with multi-turn context
- [x] TTS via ElevenLabs streaming
- [x] Text-based viseme generation
- [x] Session management (in-memory)
- [x] Emotion tags parsed and emitted
- [ ] Python sidecar (not needed for MVP básico)
- [ ] Face tracking integration (frontend only)

**Success criteria:** Full voice conversation with <1s latency, lip-sync data delivered, runs on PC with standard internet connection.

### MVP Avanzado (Target: +4–6 months)

- [x] Python sidecar for offline ASR + TTS (no external API dependency)
- [ ] Audio-based viseme extraction (Option B in lipsync.js)
- [x] **Co-speech body gesture generation via PantoMatrix/EMAGE** — motion sidecar (:8004) turns each sentence's TTS audio into SMPL-X gestures, rendered on the native SMPL-X avatar (HUD toggle)
- [ ] EMAGE → VRM/GLB retargeting (drive avatar.glb / a .vrm with SMPL-X motion; hard: rest-pose + bone-frame conversion)
- [ ] EMAGE facial expressions (100-d FLAME coeffs currently unused; only the jaw bone moves)
- [ ] Cross-sentence gesture continuity (feed previous window tail as masked_motion to EmageAudioModel.inference)
- [ ] Body gesture intent tags added to LLM output
- [ ] Avatar facial expression mapping (sad/happy/surprised)
- [ ] MediaPipe face mirroring data accepted from client and forwarded to avatar
- [ ] Persistent session storage (Redis or SQLite for context across reconnects)
- [ ] Rate limiting per session
- [ ] Admin dashboard endpoint for metrics

---

## 11. Roadmap & Phases

| Phase                     | Dates        | Backend Goal                                                                                |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| **1 — Research & Design** | Jun–Aug 2026 | Finalize this architecture, set up repo, validate all API keys work                         |
| **2 — Prototypes**        | Sep–Dec 2026 | Working pipeline: Whisper → Groq → Kokoro, WS gateway live, latency baseline measured        |
| **3 — Unity Integration** | Jan–Mar 2027 | Backend stable; provide viseme + emotion data consumed by Unity frontend                    |
| **4 — Iteration**         | Apr–Jun 2027 | Optimize streaming, reduce latency, add sidecar for offline mode                            |
| **5 — MVP Launch**        | Jul–Aug 2027 | Deploy to production, monitor metrics, gather user feedback                                 |

---

## 12. Development Rules for Agents

> These rules apply to every coding agent working on this codebase. Follow them without exception.

1. **Never store audio buffers to disk.** They exist in memory only, for the duration of one pipeline turn.
2. **Never log user content.** Log timing, errors, and metadata only. No transcripts, no LLM responses in logs.
3. **Always stream.** Every module that supports streaming must stream. Do not accumulate full responses before forwarding.
4. **One pipeline per WebSocket connection.** Do not share pipeline state between users/sessions.
5. **Measure latency for every stage.** Use `src/utils/timer.js`. Add timing to every module's output contract.
6. **English-language code, Spanish-language avatar.** Variable names, comments, and docs are in English. The LLM system prompt and avatar persona are in Spanish.
7. **LLM model comes from env (`LLM_MODEL`).** Default is `llama-3.1-8b-instant` (Groq); local dev uses Ollama (`llama3.1:8b`). Never hardcode model strings outside `src/config.js`.
8. **Fail gracefully.** If ASR fails, tell the client with `{ type: "error", code: "asr_failed" }` and do not proceed to LLM. Never let an unhandled exception crash the server.
9. **Environment variables for all secrets and configuration.** No hardcoded API keys, URLs, or model names outside of `src/config.js`.
10. **All new routes must be registered in `src/api/router.js`.** Never add routes directly in `server.js`.
11. **Tests are required for every pipeline module.** Add unit tests to `tests/unit/` before marking any module complete.
12. **The Python sidecar is optional and disabled by default.** All code paths must work without it (`SIDECAR_ENABLED=false`).

---

## 13. Repository Setup Instructions

Follow these steps exactly to initialize the project from scratch.

### Prerequisites

```bash
node --version   # must be >= 20
npm --version    # must be >= 10
python --version # must be >= 3.10 (for sidecar, optional)
git --version
```

### Step 1 — Initialize the repository

```bash
mkdir hannah-backend
cd hannah-backend
git init
npm init -y
```

### Step 2 — Install dependencies

```bash
# Production dependencies
npm install express ws dotenv openai axios uuid winston cors helmet express-rate-limit

# Dev dependencies
npm install --save-dev jest nodemon supertest
```

### Step 3 — Set up the folder structure

```bash
mkdir -p src/gateway src/pipeline src/state src/api src/privacy src/utils
mkdir -p sidecar
mkdir -p tests/unit tests/integration
mkdir -p scripts
```

### Step 4 — Create the .gitignore

```bash
cat > .gitignore << 'EOF'
node_modules/
.env
*.log
dist/
coverage/
sidecar/__pycache__/
sidecar/.venv/
*.wav
*.mp3
EOF
```

### Step 5 — Create the .env.example file

```bash
cat > .env.example << 'EOF'
PORT=3001
NODE_ENV=development
LOG_LEVEL=info

# 1. Speech to Text (Whisper)
ASR_PROVIDER=cloud
OPENAI_API_KEY=sk-...
WHISPER_MODEL=whisper-1

# 2. Dialogue Brain (Groq LLaMA 3)
LLM_PROVIDER=openai-compatible
LLM_API_KEY=gsk_...
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.1-8b-instant
CONTEXT_TURNS=10

# 3. Audio Output (Kokoro)
TTS_PROVIDER=kokoro
ELEVENLABS_VOICE_ID=af_bella

SIDECAR_URL=http://localhost:8001
SIDECAR_ENABLED=false

SESSION_TTL_MINUTES=30
CORS_ORIGIN=http://localhost:5173
EOF

cp .env.example .env
# Now edit .env and fill in your real API keys
```

### Step 6 — Add npm scripts to package.json

Edit `package.json` and replace the `"scripts"` section with:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "nodemon src/server.js",
  "test": "jest",
  "test:watch": "jest --watch",
  "test:coverage": "jest --coverage",
  "sidecar": "cd sidecar && uvicorn main:app --port 8001 --reload"
}
```

### Step 7 — (Optional) Set up Python sidecar

```bash
cd sidecar
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install fastapi uvicorn faster-whisper TTS python-multipart numpy
# Create sidecar/requirements.txt
pip freeze > requirements.txt
cd ..
```

### Step 8 — Validate the setup

```bash
# Start the dev server
npm run dev

# In another terminal, test your API keys (Groq):
node -e "
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL });
client.chat.completions.create({ model: 'llama-3.1-8b-instant', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] })
  .then(r => console.log('Groq OK:', r.choices[0].message.content))
  .catch(e => console.error('Groq FAIL:', e.message));
"
```

### Step 9 — First commit

```bash
git add .
git commit -m "chore: initial project structure for Hannah backend"
```

### Step 10 — (Optional) Push to GitHub

```bash
gh repo create hannah-backend --private --source=. --remote=origin --push
# or manually:
git remote add origin https://github.com/YOUR_USERNAME/hannah-backend.git
git push -u origin main
```

---

## Quick Reference — Key Files for Each Agent Task

| Task                                 | Primary file                                 | Secondary files                |
| ------------------------------------ | -------------------------------------------- | ------------------------------ |
| Add a new WebSocket message type     | `src/gateway/websocket.js`                   | `src/pipeline/orchestrator.js` |
| Change ASR provider                  | `src/pipeline/asr.js`                        | `src/config.js`, `.env`        |
| Change LLM model or prompt           | `src/pipeline/llm.js`                        | `src/config.js`                |
| Change TTS voice                     | `src/pipeline/tts.js`                        | `.env` (ELEVENLABS_VOICE_ID)   |
| Tune lip-sync quality                | `src/pipeline/lipsync.js`                    | —                              |
| Add a REST endpoint                  | `src/api/router.js` + new file in `src/api/` | `src/server.js`                |
| Adjust session TTL or context length | `src/state/conversationManager.js`           | `.env`                         |
| Add latency logging                  | `src/utils/timer.js`                         | relevant pipeline module       |
| Enable Python sidecar                | `src/utils/sidecar.js`                       | `.env` (SIDECAR_ENABLED=true)  |

---

_Last updated: July 2026 — Hannah v0.1 — Backend architecture document_
