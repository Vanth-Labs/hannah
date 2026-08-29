// src/api/settings.js
// Endpoints de config de proveedores (LLM/ASR/TTS). App self-hosted, un usuario:
// la config es GLOBAL de proceso, no por sesión.
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { getSettings, applySettings, persist } from '../state/settings.js';
import { validateCloud, isLocalUrl } from '../pipeline/brain.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const blank = (v) => v == null || String(v).trim() === '';

// GET /settings -> vista redactada (nunca devuelve API keys, solo hasApiKey)
export const readSettings = (req, res) => {
  res.status(200).json(getSettings());
};

// POST /settings -> aplica el patch (apiKey en blanco conserva el existente) y persiste.
// Si toca el cerebro y apunta a un proveedor, se valida ANTES de guardar (misma regla que
// /brain/choose): un modelo retirado o una key mala fallan aqui con palabras y la lista de
// modelos que si hay, no en el primer turno con un 404 mudo.
export const writeSettings = async (req, res) => {
  const patch = req.body || {};
  const llm = patch.llm;
  if (llm && typeof llm === 'object' && ['baseUrl', 'model', 'apiKey'].some((k) => !blank(llm[k]))) {
    const baseUrl = blank(llm.baseUrl) ? config.llm.baseUrl : llm.baseUrl;
    if (!isLocalUrl(baseUrl)) {
      const model = blank(llm.model) ? config.llm.model : llm.model;
      const apiKey = blank(llm.apiKey) ? config.llm.apiKey : llm.apiKey;
      const check = await validateCloud(baseUrl, model, apiKey);
      if (!check.ok) return res.status(400).json(check);
    }
  }
  const redacted = applySettings(patch);
  persist();
  logger.info('Settings de proveedores actualizados');
  res.status(200).json(redacted);
};
