// src/api/settings.js
// Endpoints de config de proveedores (LLM/ASR/TTS). App self-hosted, un usuario:
// la config es GLOBAL de proceso, no por sesión.
import { getSettings, applySettings, persist } from '../state/settings.js';
import { logger } from '../utils/logger.js';

// GET /settings -> vista redactada (nunca devuelve API keys, solo hasApiKey)
export const readSettings = (req, res) => {
  try {
    res.status(200).json(getSettings());
  } catch (error) {
    res.status(500).json({ error: 'settings_read_failed', message: error.message });
  }
};

// POST /settings -> aplica el patch (apiKey en blanco conserva el existente) y persiste
export const writeSettings = (req, res) => {
  try {
    const redacted = applySettings(req.body || {});
    persist();
    logger.info('Settings de proveedores actualizados');
    res.status(200).json(redacted);
  } catch (error) {
    res.status(500).json({ error: 'settings_write_failed', message: error.message });
  }
};
