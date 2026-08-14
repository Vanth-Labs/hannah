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
