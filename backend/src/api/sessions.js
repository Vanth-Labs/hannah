// src/api/sessions.js
import { conversationManager } from '../state/conversationManager.js';

export const createSession = (req, res) => {
  try {
    // GDPR Notice Compliance: Inform clients they must obtain user consent prior to hitting this pipeline
    const sessionInfo = conversationManager.createSession();
    
    res.status(201).json(sessionInfo);
  } catch (error) {
    res.status(500).json({ error: 'session_creation_failed', message: error.message });
  }
};

export const deleteSession = (req, res) => {
  try {
    const { id } = req.params;
    const deleted = conversationManager.deleteSession(id);

    if (!deleted) {
      return res.status(404).json({ error: 'not_found', message: 'Session not found or already expired.' });
    }

    // 204 No Content is ideal for successful deletion routes
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: 'session_deletion_failed', message: error.message });
  }
};