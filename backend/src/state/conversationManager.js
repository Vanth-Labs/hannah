// src/state/conversationManager.js
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

class ConversationManager {
  constructor() {
    this.sessions = new Map();
    // Run a periodic garbage collector every 5 minutes to clear stale sessions
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /**
   * Creates a brand new interactive session
   */
  createSession() {
    const sessionId = uuidv4();
    const sessionData = {
      sessionId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      turns: [],
      emotion: 'neutral',
      language: 'es' // Default language avatar speaks
    };

    // Inject system prompt as the hidden first context turn if required by your pipeline flow
    // For Claude, system messages are often passed separately, but we track turns here
    this.sessions.set(sessionId, sessionData);
    
    logger.info('New session created', { sessionId });
    return {
      sessionId,
      expiresIn: config.session.ttl * 60
    };
  }

  /**
   * Retrieves an active session or null if expired/non-existent
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check if session has expired dynamically
    const ageInMinutes = (new Date() - session.lastActivityAt) / 1000 / 60;
    if (ageInMinutes > config.session.ttl) {
      this.deleteSession(sessionId);
      return null;
    }

    // Refresh activity timestamp on access
    session.lastActivityAt = new Date();
    return session;
  }

  /**
   * Appends a new turn (user utterance or assistant response) 
   * and strictly maintains the CONTEXT_TURNS window limit.
   */
  addTurn(sessionId, role, content) {
    const session = this.getSession(sessionId);
    if (!session) return false;

    session.turns.push({ role, content });

    // Evict older turns if we cross our architectural budget constraint
    if (session.turns.length > config.llm.contextTurns) {
      session.turns.shift(); // Drops oldest turn
    }

    session.lastActivityAt = new Date();
    return true;
  }

  /**
   * Updates the ongoing structural metadata of the conversation
   */
  updateSessionMetadata(sessionId, updates = {}) {
    const session = this.getSession(sessionId);
    if (!session) return false;

    if (updates.emotion) session.emotion = updates.emotion;
    if (updates.language) session.language = updates.language;
    
    session.lastActivityAt = new Date();
    return true;
  }

  /**
   * Purges a session immediately from RAM (Privacy Directive Compliance)
   */
  deleteSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      logger.info('Session purged successfully from memory', { sessionId });
      return true;
    }
    return false;
  }

  /**
   * Sweeps the Map to delete old sessions automatically
   */
  cleanupExpiredSessions() {
    const now = new Date();
    let purgeCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const ageInMinutes = (now - session.lastActivityAt) / 1000 / 60;
      if (ageInMinutes > config.session.ttl) {
        this.sessions.delete(sessionId);
        purgeCount++;
      }
    }

    if (purgeCount > 0) {
      logger.info('Stale sessions cleared by state garbage collector', { count: purgeCount });
    }
  }

  /**
   * Stops the periodic garbage collector (needed so test runners can exit cleanly)
   */
  dispose() {
    clearInterval(this.cleanupInterval);
  }
}

// Export as a single application-wide instance
export const conversationManager = new ConversationManager();