// src/api/skills.js
// CRUD de skills (estilo Claude Code) para el panel ⚙. Las skills del usuario se guardan
// en data/skills/<name>/SKILL.md. GLOBAL de proceso (self-hosted, un usuario).
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { getSkills, saveSkill, deleteSkill } from '../state/skills.js';
import { logger } from '../utils/logger.js';

// Vista para el panel: metadatos + el markdown crudo (editable). No exponemos internals.
const view = () => getSkills().map((s) => ({
  name: s.name,
  description: s.description,
  action: `${s.action.type}: ${s.action.template}`,
  phrases: s.phrases,
  source: s.source,
  content: s.raw,
}));

export const readSkills = (req, res) => {
  res.status(200).json({ skills: view() });
};

export const writeSkill = (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: 'name y content requeridos' });
  saveSkill(name, content);
  logger.info('skill guardada', { name });
  return res.status(200).json({ skills: view() });
};

export const removeSkill = (req, res) => {
  deleteSkill(req.params.name);
  logger.info('skill borrada', { name: req.params.name });
  res.status(200).json({ skills: view() });
};
