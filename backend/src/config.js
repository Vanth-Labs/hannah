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
    systemPrompt: `You are Hannah, a helpful and expressive AI avatar.
Respond conversationally and concisely (1–3 sentences).
Respond in the same language the user speaks.

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

At the end of each response, append an emotion tag on a new line in the format:
[EMOTION:neutral|happy|surprised|thinking|sad]`,
  },
  tts: {
    provider: process.env.TTS_PROVIDER || 'kokoro',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'af_bella', // Doubles as the Kokoro voice ID (af_* = American English)
    sidecarUrl: process.env.TTS_SIDECAR_URL || 'http://127.0.0.1:8002',
  },
  vision: {
    sidecarUrl: process.env.VISION_SIDECAR_URL || 'http://127.0.0.1:8003',
  },
  motion: {
    // 'lab'   -> hannah-motion-lab (texto→movimiento, JSON, puerto 8005)
    // 'emage' -> sidecar EMAGE original (audio→movimiento, multipart, puerto 8004)
    provider: process.env.MOTION_PROVIDER || 'lab',
    sidecarUrl: process.env.MOTION_SIDECAR_URL || 'http://127.0.0.1:8005',
    enabled: process.env.MOTION_ENABLED !== 'false',
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
