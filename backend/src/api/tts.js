// src/api/tts.js
// Proxy read-only al sidecar Kokoro para listar sus voces reales (para el selector del
// panel ⚙). No sintetiza; solo consulta GET /voices del sidecar. Si el sidecar está caído
// devuelve { voices: [] } y el frontend usa su fallback.
import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const readVoices = async (req, res) => {
  try {
    const { data } = await axios.get(`${config.tts.sidecarUrl}/voices`, { timeout: 4000 });
    res.status(200).json({ voices: Array.isArray(data?.voices) ? data.voices : [] });
  } catch (error) {
    logger.info('No se pudieron listar voces del sidecar TTS', { message: error.message });
    res.status(200).json({ voices: [] });
  }
};

// ── Vista previa de una voz: una frase corta, en el idioma de la voz, sintetizada por el
// sidecar y devuelta tal cual (audio/wav). Es lo que hace útil el selector "simple" del
// panel ⚙: nadie elige una voz por su id; la escucha. Solo Kokoro (ids `xx_nombre`).
const SAMPLE_BY_LANG = {
  e: 'Hola, soy Hannah. Así suena mi voz.',
  a: "Hi, I'm Hannah. This is how I sound.",
  b: "Hi, I'm Hannah. This is how I sound.",
  f: 'Bonjour, je suis Hannah. Voici ma voix.',
  i: 'Ciao, sono Hannah. Questa è la mia voce.',
  p: 'Olá, eu sou a Hannah. Esta é a minha voz.',
  j: 'こんにちは、ハンナです。これが私の声です。',
  z: '你好，我是汉娜。这是我的声音。',
  h: 'नमस्ते, मैं हन्ना हूँ। यह मेरी आवाज़ है।',
};
const VOICE_ID = /^[a-z]{2}_[a-z0-9]{1,24}$/;

/** Puro: frase de muestra para una voz, o null si el id no es un id Kokoro válido. */
export function previewSample(voice) {
  const id = String(voice || '');
  if (!VOICE_ID.test(id)) return null;
  return SAMPLE_BY_LANG[id[0]] || SAMPLE_BY_LANG.a;
}

export const previewVoice = async (req, res) => {
  const voice = String(req.query.voice || '');
  const text = previewSample(voice);
  if (!text) return res.status(400).json({ error: 'invalid_voice' });
  try {
    const r = await axios.post(`${config.tts.sidecarUrl}/v1/audio/speech`, { text, voice },
      { responseType: 'arraybuffer', timeout: 15000 });
    res.set('Content-Type', r.headers['content-type'] || 'audio/wav');
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(r.data));
  } catch (error) {
    logger.info('Vista previa de voz falló', { voice, message: error.message });
    return res.status(503).json({ error: 'tts_unavailable' });
  }
};
