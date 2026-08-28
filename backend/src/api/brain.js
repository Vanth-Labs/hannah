// src/api/brain.js
// First-run brain choice ("where should I think?") and the per-user Ollama helpers behind it.
// Everything here is triggered by a button in the overlay; nothing runs on its own.
// Errors are caught by the `handler` wrapper of the router (api/handler.js).
import * as brain from '../pipeline/brain.js';
import { applySettings, persist } from '../state/settings.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// GET /brain -> mode, configured, ollama (reachable/models/installed), hardware, recommendation, job
export const readBrain = async (req, res) => {
  res.status(200).json(await brain.status());
};

// POST /brain/choose {mode:'local'|'cloud', llm?:{baseUrl, model, apiKey}} -> saves and re-syncs
export const chooseBrain = async (req, res) => {
  const { mode, llm } = req.body || {};
  if (mode !== 'local' && mode !== 'cloud') return res.status(400).json({ error: 'mode must be local or cloud' });
  const patch = { brain: { mode }, llm: { provider: 'openai-compatible', ...(llm || {}) } };
  if (mode === 'local') {
    // a local brain always talks to Ollama's OpenAI-compatible endpoint; the key is a placeholder
    patch.llm.baseUrl = llm?.baseUrl && brain.isLocalUrl(llm.baseUrl) ? llm.baseUrl : 'http://localhost:11434/v1';
    patch.llm.model = llm?.model || brain.LOCAL_MODELS.brain;
    patch.llm.apiKey = 'ollama';
  }
  if (mode === 'cloud') {
    // Validate before saving: a retired model or a bad key must fail HERE, with words, not on
    // the first sentence with a silent turn. Providers that do not serve /models are trusted.
    const check = await brain.validateCloud(patch.llm.baseUrl, patch.llm.model, patch.llm.apiKey || config.llm.apiKey);
    if (!check.ok) return res.status(400).json(check);
  }
  applySettings(patch);
  persist();
  logger.info('brain chosen', { mode });
  res.status(200).json(await brain.status());
};

// POST /brain/ollama/install -> per-user install (background job)
export const installOllama = (req, res) => {
  const job = brain.startInstallOllama();
  res.status(202).json({ job });
};

// POST /brain/ollama/start -> `ollama serve` in the user's session
export const startOllama = async (req, res) => {
  await brain.startOllama();
  res.status(200).json(await brain.status());
};

// POST /brain/ollama/pull {models:[...]} -> background job with progress
export const pullModels = (req, res) => {
  const models = req.body?.models || (req.body?.model ? [req.body.model] : []);
  const clean = models.map((m) => String(m).trim()).filter((m) => /^[A-Za-z0-9._:/-]+$/.test(m));
  const job = brain.startPull(clean);
  res.status(202).json({ job });
};
