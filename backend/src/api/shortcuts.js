// src/api/shortcuts.js
// Atajos de voz para abrir apps/páginas. GLOBAL de proceso (app self-hosted, un usuario).
// GET  /shortcuts -> { sites, apps }
// POST /shortcuts -> reemplaza el set completo { sites, apps } y persiste.
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { getShortcuts, setShortcuts } from '../state/shortcuts.js';
import { logger } from '../utils/logger.js';

export const readShortcuts = (req, res) => {
  res.status(200).json(getShortcuts());
};

export const writeShortcuts = (req, res) => {
  const body = req.body || {};
  const saved = setShortcuts({ sites: body.sites || {}, apps: body.apps || {} });
  logger.info('Atajos actualizados');
  res.status(200).json(saved);
};
