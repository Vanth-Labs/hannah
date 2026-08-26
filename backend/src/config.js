// src/config.js
import dotenv from 'dotenv';
dotenv.config();

const requiredEnv = ['LLM_API_KEY'];
if (process.env.NODE_ENV === 'production') {
  requiredEnv.forEach((envVar) => {
    if (!process.env[envVar]) {
      throw new Error(`Missing mandatory environment variable: ${envVar}`);
    }
  });
}

export const config = {
  port: process.env.PORT || 3001,
  // Interfaz de escucha. Default LOCAL: el acceso desde la LAN (celular/laptop) entra por
  // el dev-server de Vite (:5173, host 0.0.0.0), que proxea /api y /ws al backend desde
  // esta máquina — así el backend (terminal, settings con API keys, memoria) nunca queda
  // expuesto a la red. Poné HOST=0.0.0.0 solo si necesitás hablarle al backend directo.
  host: process.env.HOST || '127.0.0.1',
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  asr: {
    provider: process.env.ASR_PROVIDER || 'cloud',
    model: process.env.WHISPER_MODEL || 'whisper-1',
    apiKey: process.env.OPENAI_API_KEY,
    language: process.env.ASR_LANGUAGE || '', // '' = auto-detect

    // SIDECAR_URL is the legacy name for the same setting
    sidecarUrl: process.env.ASR_SIDECAR_URL || process.env.SIDECAR_URL || 'http://127.0.0.1:8001',
  },
  llm: {
    provider: process.env.LLM_PROVIDER || 'openai-compatible',
    model: process.env.LLM_MODEL || 'llama-3.1-8b-instant',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || null, // Null defaults to official OpenAI servers
    contextTurns: parseInt(process.env.CONTEXT_TURNS || '10', 10),

    // Personalidad EDITABLE por el usuario (panel ⚙). Solo el carácter/estilo;
    // las reglas de tags van aparte en `protocol` y se anexan siempre.
    persona: process.env.LLM_PERSONA || `You are Hannah, a helpful and expressive AI avatar.
Respond conversationally and concisely (1–3 sentences).
Respond in the same language the user speaks.`,

    // Protocolo FIJO de tags (no editable): sin esto se rompen gestos/emoción.
    // `llm.js` construye el system prompt final como `persona + protocol`.
    protocol: `Reply ALWAYS in English. Never use any other language or script
(no Spanish, no Chinese/CJK characters). No emojis.

Your body already gestures naturally while you speak — never describe that.
ONLY when a deliberate physical gesture genuinely fits the moment, mark it inline
with a motion tag placed inside the sentence where the gesture happens:
[MOTION:short physical action]
Use it sparingly — at most once per response, and often not at all. Choose ONE of
these gestures (use these exact words) when it genuinely fits:
  greeting / goodbye  -> [MOTION:waves]
  pointing something  -> [MOTION:points]
  agreeing / yes      -> [MOTION:nods]
  disagreeing / no    -> [MOTION:shakes head no]
  excited / happy     -> [MOTION:happy hand gesture]
  brushing off        -> [MOTION:dismisses]
  acknowledging       -> [MOTION:acknowledges]
Never tag ordinary talking. Put the tag at the START of the sentence it belongs to,
in the SAME sentence as its spoken words, and keep that sentence short — e.g.
"[MOTION:waves] Hi there, nice to meet you!" (one sentence, so she only waves).
Do NOT split the greeting and the tag into two sentences, or she will gesture-talk
first and only wave at the end.

You live as a small floating avatar on the user's desktop and CAN move yourself
around. ONLY when the user asks you to move/relocate (or it clearly fits), emit a
move tag inline: [MOVE:where] where "where" is one of: top-left, top-right,
bottom-left, bottom-right, center, fullscreen, next-screen. Use it rarely; never for normal talk.

{{RUN_PROTOCOL}}Other action tags (same rule — emit, then wait for the real result):
  [SEARCH: query]  web search      [FETCH: url]  read a page (no window)
  [BROWSE: url]    open a page      [CLOSE: what] close a window/app
  [WEATHER: place] [LOOK] camera    [TIME] date/time    [OPEN: app name]

LIVE STATE, NOT MEMORY: for anything about the CURRENT machine or its state — its name/
hostname, IP, disk/memory/CPU, running processes, open ports, files, git status — or to
connect/open/run something, you MUST run the matching skill/action and answer from its real
result. NEVER answer these from memory or a remembered value: memory holds the user's
preferences and past chat, not the live system. If unsure whether a fact is current, run the
skill instead of recalling.

At the end of each response, append an emotion tag on a new line in the format:
[EMOTION:neutral|happy|surprised|thinking|sad|angry|curious|alert]`,
    // Sección [RUN:] del protocolo. Va aparte porque NO siempre entra: con la política
    // agent-first/skills-only (config.tools.runPolicy) el modelo no debe ver [RUN:] — sus
    // comandos libres van al agente como tarea. llm.js la inserta en {{RUN_PROTOCOL}}.
    runProtocol: `### RUNNING COMMANDS — your MAIN tool
To DO or CHECK anything on this computer, write the exact shell command inline as:
[RUN: <command>]
The app runs it in a real terminal and hands you back the REAL output to continue from. Then
STOP (do NOT write anything after the tag; wait for the result). Figure out the command
yourself — you don't need the user to phrase it a special way. Examples:
  "create a file notes.txt"        -> [RUN: touch notes.txt]
  "list the files here"            -> [RUN: ls -la]
  "how many files are here"        -> [RUN: ls -1 | wc -l]
  "make a folder called test"      -> [RUN: mkdir test]
  "what's my kernel"               -> [RUN: uname -r]
  "delete /tmp/x" (destructive)    -> [RUN: rm /tmp/x]   (the app will ask the user to confirm)
Never guess or invent a command's output. If a request needs the computer and you did NOT get
a real result back, do NOT claim you did it — just run the command.`,
  },
  tts: {
    provider: process.env.TTS_PROVIDER || 'kokoro',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'af_heart', // Kokoro voice ID. Hannah habla inglés -> voz inglesa (af_heart ♀). El prefijo define el idioma (a=en-us, e=es, ...). Cambiable en el panel ⚙.
    sidecarUrl: process.env.TTS_SIDECAR_URL || 'http://127.0.0.1:8002',
    apiKey: process.env.ELEVENLABS_API_KEY || '', // usado solo por el proveedor elevenlabs
    model: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  },
  vision: {
    // 'yolo' -> sidecar YOLO (etiquetas de objetos) · 'vlm' -> modelo de visión
    // local (Ollama moondream/llava) que DESCRIBE y entiende la escena.
    provider: process.env.VISION_PROVIDER || 'vlm',
    sidecarUrl: process.env.VISION_SIDECAR_URL || 'http://127.0.0.1:8003',
    vlmModel: process.env.VLM_MODEL || 'moondream',
    vlmBaseUrl: process.env.VLM_BASE_URL || 'http://localhost:11434/v1', // Ollama OpenAI-compat
  },
  motion: {
    // Dos providers con protocolos INCOMPATIBLES, cada uno con SU url (antes compartían
    // `sidecarUrl`, así que apuntar a un puerto rompía en silencio al otro):
    //   'lab'   -> hannah-motion-lab: texto→movimiento, JSON,      :8005 (default)
    //   'emage' -> sidecar EMAGE:     audio→movimiento, multipart,  :8004 (fallback)
    // MOTION_SIDECAR_URL (legacy) sigue respetándose para el provider activo.
    provider: process.env.MOTION_PROVIDER || 'lab',
    labUrl: process.env.MOTION_LAB_URL
      || ((process.env.MOTION_PROVIDER || 'lab') === 'lab' && process.env.MOTION_SIDECAR_URL)
      || 'http://127.0.0.1:8005',
    emageUrl: process.env.MOTION_EMAGE_URL
      || (process.env.MOTION_PROVIDER === 'emage' && process.env.MOTION_SIDECAR_URL)
      || 'http://127.0.0.1:8004',
    enabled: process.env.MOTION_ENABLED !== 'false',
  },
  memory: {
    // Recall vectorial (Fase F2): embeddings locales vía Ollama.
    dbPath: process.env.MEMORY_DB_PATH || null,   // null = data/memory.db; ':memory:' en tests
    embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
    embedUrl: process.env.EMBED_URL || 'http://localhost:11434/api/embeddings',
    recallK: parseInt(process.env.MEMORY_RECALL_K || '3', 10),
    recallEnabled: process.env.MEMORY_RECALL !== 'false',
  },
  // ── Las "manos": el sidecar hannah-agent (:8006) ─────────────────────────────────
  // Mismo patrón que motion (flag + url). OFF por defecto: sin el flag, para el resto del
  // sistema el agente NO existe — ni siquiera aparece [TASK:] en el prompt del modelo.
  // El agente ejecuta tareas de VARIOS pasos con un modelo capaz (Ox Alpha vía OpenRouter);
  // la persona (el 7B local) es la ÚNICA voz: el agente nunca habla, ella narra sus eventos.
  agent: {
    enabled: process.env.AGENT_ENABLED === 'true',
    url: process.env.AGENT_SIDECAR_URL || 'http://127.0.0.1:8006',
    // Bearer que el agente exige si HANNAH_AGENT_TOKEN está puesto de su lado. Mismo valor.
    token: process.env.HANNAH_AGENT_TOKEN || '',
    // La key del MODELO del agente (OpenRouter). El backend no la usa: la persiste (panel ⚙) y
    // el launcher se la pasa al agente por entorno al arrancarlo. Nunca vuelve al navegador.
    apiKey: process.env.OPENROUTER_API_KEY || '',
    // Preset de permisos del agente (ADR-0010): companion | trusted-project | paranoid.
    mode: process.env.AGENT_MODE || 'companion',
    // Presupuesto de narración: task.progress se cuenta como mucho una vez cada N ms por tarea.
    narrateProgressMs: parseInt(process.env.AGENT_NARRATE_PROGRESS_MS || '20000', 10),
    // Si el stream de eventos se cae más de N ms con una tarea viva, se da por PERDIDA (no
    // por terminada) y se dice honestamente que no se sabe cómo acabó.
    lostContactMs: parseInt(process.env.AGENT_LOST_CONTACT_MS || '15000', 10),
    // Tope duro por tarea (el agente la mata con task.failed reason "timebox").
    timeboxMs: parseInt(process.env.AGENT_TIMEBOX_MS || '600000', 10),
  },

  tools: {
    // Function-calling (Fase T). OFF por defecto: llama3.1:8b es poco fiable con tools
    // (a veces emite el tool-call como texto y ensucia el chat). Activar con TOOLS_ENABLED=true
    // idealmente con un modelo bueno para tools (qwen2.5) vía el panel ⚙.
    enabled: process.env.TOOLS_ENABLED === 'true',
    // SEGURIDAD: run_command, las skills `terminal` y el panel TERMINAL_* SOLO corren si
    // systemControl=true (default OFF). NO hay allowlist de comandos: con el flag activo se
    // ejecuta CUALQUIER comando en un pty real; la única red es la confirmación del usuario
    // para los destructivos (regex DANGER en pipeline/tools.js, best-effort).
    systemControl: process.env.TOOLS_SYSTEM_CONTROL === 'true',
    // Quién corre los comandos LIBRES del modelo ([RUN:]), es decir, lo que no es una skill ni
    // una intención determinista:
    //   free        -> el backend, en el pty (lo de siempre; única red: la regex DANGER).
    //   agent-first -> el agente (riesgo por niveles, aprobación, auditoría, deshacer); si el
    //                  agente está apagado o caído, cae a `free`.
    //   skills-only -> nunca: sin agente, el modelo solo tiene skills.
    // Por defecto agent-first cuando hay agente, free si no. Las skills y la capa determinista
    // siguen corriendo en local en cualquier política; la terminal del panel es del usuario.
    runPolicy: ['free', 'agent-first', 'skills-only'].includes(process.env.TOOLS_RUN_POLICY)
      ? process.env.TOOLS_RUN_POLICY
      : (process.env.AGENT_ENABLED === 'true' ? 'agent-first' : 'free'),
    // open_app: el LLM elige la CLAVE; el comando es fijo (sin inyección). Editable.
    appAllowlist: {
      firefox: 'firefox', chrome: 'google-chrome-stable', browser: 'xdg-open https://www.google.com',
      code: 'code', vscode: 'code', files: 'xdg-open ~',
      terminal: 'x-terminal-emulator || konsole || gnome-terminal || alacritty',
    },
  },
  session: {
    ttl: parseInt(process.env.SESSION_TTL_MINUTES || '30', 10),
  },
  // Comma-separated list of allowed origins
  corsOrigin: (process.env.CORS_ORIGIN || 'https://localhost:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
