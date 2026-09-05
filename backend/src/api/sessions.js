// src/api/sessions.js
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { conversationManager } from '../state/conversationManager.js';

export const createSession = (req, res) => {
  // GDPR Notice Compliance: Inform clients they must obtain user consent prior to hitting this pipeline
  res.status(201).json(conversationManager.createSession());
};

export const deleteSession = (req, res) => {
  const { id } = req.params;
  const deleted = conversationManager.deleteSession(id);
  if (!deleted) {
    return res.status(404).json({ error: 'not_found', message: 'Session not found or already expired.' });
  }
  // 204 No Content is ideal for successful deletion routes
  return res.status(204).end();
};
