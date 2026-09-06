# Hannah — real-time interactive AI avatar

Hannah is an **AI companion** you can see and hear: you speak (or show her the camera) and a
3D avatar answers with voice, lip-sync, emotion and **co-speech gestures**, living as a
**floating overlay** on your desktop. The whole default stack is **local** (Ollama,
Whisper, Kokoro, YOLO/VLM). It can also **use the internet** and **a real terminal**.

## Components (repos)

| Dir | What it is | Language |
|-----|--------|----------|
| `backend/` | WS gateway + REST: orchestrates ASR→LLM→TTS→lip-sync + Python sidecars (Whisper, Kokoro, YOLO/VLM). Tools (internet, terminal), memory, window control. | Node (ESM) |
| `frontend/` | React + three.js client: VRoid/VRM avatar, mic, camera, HUD, terminal panel. | React/Vite |
| `backend/sidecar/gestures/` | the text→motion model (gestures) on :8005: [Vanth-Labs/motion-model](https://github.com/Vanth-Labs/motion-model) installed as a package into a venv, plus its weights. | Python |
| `backend/sidecar/sense/` | **hannah-sense** on :8007: the watches. Keeps looking at a process, a log or a port after the conversation ends and says when it stops. Observes only — it never touches the machine. Off by default (`SENSE_ENABLED`). | Python |
| `desktop/` | **Electron desktop app** (universal overlay Win/Mac/Linux). | Electron |
| `hannah-site/` | Landing page + Ollama-style installer (live at [vanthlabs.org](https://vanthlabs.org/)). | Static HTML |
| `hannah` | **Launcher**: brings up the whole stack and opens the overlay (by default, the app). | Bash |

## Architecture in 30s

- **Universal web app**: backend (Node) + frontend (web) run on any OS/browser.
- **Overlay layer** (float on top, move between screens, gaze that follows the cursor):
  two ways to run it —
  1. **Browser mode** (`hannah` launcher): opens the frontend in a browser in app-mode
     and places it with the environment's **adapter** (Hyprland via `hyprctl`, X11 via
     `xdotool`/`wmctrl`). Lightweight, nothing extra to install. Linux.
  2. **Electron app** (`desktop`): Chromium, overlay with cross-platform APIs
     (`setAlwaysOnTop`, `setBounds`, `getCursorScreenPoint`, `getAllDisplays`). **Win/Mac/Linux**.

## Ports and network

| Service | Port | |
|---|---|---|
| Backend (API + WS) | 3001 | listens on **127.0.0.1** (env `HOST`) |
| Frontend (Vite) | 5173 | listens on `0.0.0.0` — this is how your phone gets in |
| ASR · TTS · Vision | 8001 · 8002 · 8003 | local sidecars |
| Motion (lab, default) | 8005 | `backend/sidecar/gestures` · EMAGE on 8004 (fallback) |
| Ollama | 11434 | LLM + embeddings |
| Agent (hannah-agent) | 8006 | **127.0.0.1** · the "hands", off by default (`AGENT_ENABLED`) |
| Sense (hannah-sense) | 8007 | **127.0.0.1** · the watches, off by default (`SENSE_ENABLED`). Bearer on every route but `/health`; any request carrying an `Origin` is refused |

> **Access from your phone/another computer:** you go to `https://<your-pc-ip>:5173` and Vite acts
> as a proxy to the local backend. The backend is **not** exposed to the network (neither the
> terminal, nor your API keys, nor the memory). Only set `HOST=0.0.0.0` if you know what you're doing.

**Language: English out, any language in — and the reason is the voice, not the architecture.**
You can talk to her in whatever language you like: the ASR auto-detects the input and already
returns the detected language. What is pinned is the *output*, and it is pinned for one reason
only: **`af_heart` is the only Kokoro voice that sounds good**. English ships 28 voices; Spanish
ships 3, and they sound bad enough that using them is worse than answering in English.

So `Reply ALWAYS in English` in `llm.protocol` (`config.js`) is **not an arbitrary lock** — don't
remove it expecting multilingual output and better results; you will get worse audio. Going
multilingual is three small changes (thread the detected language through the turn, relax the
protocol, pick the voice per language) and the ASR **already provides that data today** — nothing
consumes it. The blocker is the TTS, so the day you plug in a better one, that is the work.

**Memory:** besides the session history, it keeps long-term memory in SQLite
(`backend/data/memory.db`) with a rolling summary and vector recall.

## Requirements

> **VRAM target: ≤16GB** — the whole stack (LLM + embeddings + TTS + ASR + vision +
> motion) fits in 16GB or less. That's why the LLM is a **7B** and the **tools use a
> tag-based action protocol** (reliable on small models), not function-calling.

- **Ollama** with `qwen2.5:7b` (chat + tools, ~5GB) and `nomic-embed-text` (memory);
  `llama3.1:8b` works if you don't use tools.
- Python 3.12 + venvs for the sidecars (details in `backend/README.md`).
- Node 20+. For the Electron app: nothing extra (it ships Chromium).
- Overlay on Linux: `hyprctl` (Hyprland) **or** `xdotool`+`wmctrl` (X11).

## Run

```bash
# 1) install (once)
cd backend  && npm install && cp .env.example .env
cd ../frontend && npm install --legacy-peer-deps   # careful: without the flag it fails (vite 5 vs plugin-basic-ssl)

# 2) brings up everything (Ollama, sidecars, backend, Vite) and opens the overlay:
./hannah                       # opens the Electron app; if it's already open, it focuses it
./hannah stop                  # shuts EVERYTHING down and frees the VRAM (Ollama models included)
./hannah doctor                # diagnoses whether the overlay will float here, and what's missing
./hannah uninstall             # removes this copy, the app and its data (Ollama and its models stay); --dry-run lists first
./hannah hands on              # installs and enables the hands (agent + bun) on demand; `hands off` disables them
HANNAH_MODE=browser ./hannah   # lightweight alternative: the frontend in a browser
HANNAH_MODE=services ./hannah  # everything up, NO window: prints https://<this-ip>:5173/?token=… for another device on the LAN

# 2') or the desktop app alone (Win/Mac/Linux), with the backend already running:
cd desktop && npm install && npm run start:dev   # uses the Vite on :5173
cd frontend && npm run build && cd ../desktop && npm start   # no Vite, from dist/
```

> **Closing the window shuts everything down.** The sidecars and the loaded models hold on to VRAM
> for as long as they're running (~14GB in a typical session), so closing the overlay launched by
> `./hannah` shuts the whole stack down and unloads the Ollama models. If you'd rather keep them warm:
> `./hannah stop --keep-ollama`, or `--dry-run` to see what would be shut down without touching anything.

## The hands: `hannah-agent`

Hannah has two ways to act on the computer, and the boundary is written into the model's
protocol so a 7B does not pick whichever tag it saw last:

- **`[RUN: cmd]`** — ONE command whose shape she already knows (list a folder, open an app, read a
  file). Instant, free, handled by the backend's own tool layer. This is what she did before.
- **`[TASK: description]`** — a job that needs **several steps or decisions** ("organize my
  downloads by type", "find the report I edited last week"). It goes to `hannah-agent`, a
  separate sidecar on `:8006` with a capable model, risk-tiered approvals, a timebox and an audit
  log.

**One voice, two hands.** The agent never speaks. Every real event it produces (accepted, plan,
progress, needs permission, done, failed) is handed to the persona through the same path her
eyes use, with one instruction: *relay this in one sentence, do not invent*. The event stream is
the only truth about a task; Hannah is the only voice. Ask her "how is it going?" and she answers
from the live status, not from memory. Say "yes" to an approval and it goes through — except
`high`-risk actions, which require the button in the HUD (voice can be spoofed by anyone in the
room). With the hands on, the model's own free-form commands go **through them** by default
(`TOOLS_RUN_POLICY=agent-first`): skills and the deterministic layer stay local and instant, and
anything else gets the agent's risk tiers and approvals instead of a 7B typing into a shell. The
terminal panel echoes every command the hands run and a glimpse of its output.

> **Privacy — this is the one exception to "everything is local".** The agent's default model is
> **Claude Sonnet 5** (Anthropic); the `--openrouter` profile uses **GLM 5.3 Flash** (Z.ai) via
> OpenRouter, cheaper. Both are **remote** — check the provider's data policy for retention terms.
> Everything a task touches — file contents, command output, your request — reaches that third party. The `companion` preset and the agent's sensitive-path
> denylist limit *what* a task can read; they do not change *where* it goes. It is **off by
> default**; enable it knowingly (`AGENT_ENABLED=true`), or use the agent's local Ollama profile
> for sensitive work. Details: `agent/docs/SECURITY.md`.

## Per-repo documentation

| Where | What you'll find |
|---|---|
| `backend/README.md` | WS and REST contracts, the path a turn takes, the deterministic action layer, configuration and design decisions |
| `desktop/README.md` | Why XWayland, why the flags go in argv, geometry via the compositor and window behavior |
| `frontend/README.md` | VRM avatar, retarget from geometry, state and audio capture |
| `SETUP.md` | Bring everything up on a new machine, step by step |
| `SKILLS.md` | Teach her capabilities without touching code |
| `agent/docs/` | The agent: integration contract (`INTEGRATION.md`), coexistence with the backend's tool layer, security model, decision records |

## Tools (internet + terminal)

They are **OFF by default**. You turn them on in your `.env` (in the file, not as stray shell
variables):

```bash
# backend/.env
TOOLS_ENABLED=true          # actions (internet, open/close, commands)
TOOLS_SYSTEM_CONTROL=true   # master flag for the real TERMINAL (pty) — implies shell access
```

- **Internet**: `web_search` (DuckDuckGo) and `fetch_url` (reading web pages).
- **Terminal**: a real persistent shell (`node-pty`, handles ssh and interactive programs) + `⌨`
  panel in the UI. **There is no command allowlist**: with the flag on it runs anything; the
  only safety net is the **confirmation prompt for destructive commands** (`rm`, `dd`, `mkfs`,
  `shutdown`, `git --force`…, `DANGER` regex, best-effort). `TOOLS_SYSTEM_CONTROL` gates
  `run_command`, `terminal`-type skills and the panel alike.
- **Skills and reference**: you can teach her capabilities without touching code —
  `backend/skills/<name>/SKILL.md` (`run`/`terminal`/`open`/`search` action, with
  per-OS variants) and `reference/*.md` (cheat-sheets that guide the model). See `SKILLS.md`.

## Distribute (per-OS builds)

```bash
cd desktop
npm run build:linux   # .AppImage / .deb   (tested: Hannah-*.AppImage runs self-contained)
npm run build:win     # .exe  — requires Windows or Wine (you can NOT build it from bare Linux)
npm run build:mac     # .dmg  — requires macOS (impossible from Linux)
```
> Before packaging: `cd frontend && npm run build` (the Electron loads that `dist/`).
> For the three OSes at once, the practical way is CI (GitHub Actions with native runners).
> The Electron app is the **overlay**; it still needs the **backend + Ollama + sidecars**
> running (locally). Packaging the backend as a service is future work.

## Platform matrix (overlay)

Run **`./hannah doctor`**: it tells you whether your environment supports the overlay and what's missing.

| Desktop | How it floats | Requirement |
|-----------|------------|-----------|
| Hyprland | native (`hyprctl`) | — |
| KDE Plasma (Wayland/X11) | KWin | `kdotool` or `wmctrl` |
| GNOME · XFCE · Cinnamon · MATE · i3 (X11) | EWMH | `wmctrl` |
| GNOME/KDE on Wayland | via XWayland | use the desktop app |
| Windows · macOS | Electron native | — |

> On **native Wayland** the protocol forbids an app from putting itself on top or moving itself
> (that's by design). That's why the desktop app forces **XWayland**, and that way the same code
> floats on every desktop. Details in `SETUP.md`.

## Notes

- **No retargeting** of motion to foreign rigs ("zombie pose" lesson): the VRoid avatar
  uses a retarget computed from geometry. See CLAUDE.md.
- Privacy: audio in memory, never to disk; user content is never logged.
- **License: MIT** for the code in every Hannah repo (the agent is a fork of opencode, also MIT).
  The assets are a different story and are NOT in git: SMPL-X (non-commercial research license)
  and Mixamo clips (Adobe) are downloaded by each user under their own terms; the Kokoro voice
  model and the Whisper/Ollama models come from their upstream releases.

Something failing? `hannah doctor` says what is up and what is missing; the launch log is `.hannah-launch.log` in this folder. Open an issue with both.
