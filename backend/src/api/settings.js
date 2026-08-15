// src/api/settings.js
// Endpoints de config de proveedores (LLM/ASR/TTS). App self-hosted, un usuario:
// la config es GLOBAL de proceso, no por sesión.
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { getSettings, applySettings, persist } from '../state/settings.js';
import { logger } from '../utils/logger.js';

// GET /settings -> vista redactada (nunca devuelve API keys, solo hasApiKey)
export const readSettings = (req, res) => {
  res.status(200).json(getSettings());
};

// POST /settings -> aplica el patch (apiKey en blanco conserva el existente) y persiste
export const writeSettings = (req, res) => {
  const redacted = applySettings(req.body || {});
  persist();
  logger.info('Settings de proveedores actualizados');
  res.status(200).json(redacted);
};
