// src/api/shortcuts.js
// Atajos de voz para abrir apps/páginas. GLOBAL de proceso (app self-hosted, un usuario).
// GET  /shortcuts -> { sites, apps }
// POST /shortcuts -> reemplaza el set completo { sites, apps } y persiste.
import { getShortcuts, setShortcuts } from '../state/shortcuts.js';
import { logger } from '../utils/logger.js';

export const readShortcuts = (req, res) => {
  try {
    res.status(200).json(getShortcuts());
  } catch (error) {
    res.status(500).json({ error: 'shortcuts_read_failed', message: error.message });
  }
};

export const writeShortcuts = (req, res) => {
  try {
    const body = req.body || {};
    const saved = setShortcuts({ sites: body.sites || {}, apps: body.apps || {} });
    logger.info('Atajos actualizados');
    res.status(200).json(saved);
  } catch (error) {
    res.status(500).json({ error: 'shortcuts_write_failed', message: error.message });
  }
};
