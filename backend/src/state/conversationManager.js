// src/state/conversationManager.js
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { memoryStore } from './memoryStore.js';
import { summarizeConversation } from '../pipeline/llm.js';
import { embed } from './embeddings.js';

// Cuántos turnos sin resumir acumular antes de plegar en la memoria de largo plazo.
const SUMMARY_THRESHOLD = 12;

class ConversationManager {
  constructor() {
    this.sessions = new Map();
    this._summarizing = false;   // lock para no lanzar resúmenes en paralelo
    // Run a periodic garbage collector every 5 minutes to clear stale sessions
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /**
   * Creates a brand new interactive session
   */
  createSession() {
    const sessionId = uuidv4();
    // Precargar la ventana con los últimos turnos persistidos: continuidad entre
    // sesiones/reinicios (app self-hosted de un usuario). El resumen de largo plazo
    // se inyecta aparte en el system prompt (llm.js).
    const preloaded = memoryStore.recentTurns(config.llm.contextTurns);
    const sessionData = {
      sessionId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      turns: preloaded,
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
   * ¿Existe la sesión AHORA, sin tocarla? getSession() refresca lastActivityAt, así que
   * preguntarle "¿seguís viva?" desde algo que NO es un turno del usuario (el puente de las
   * vigilancias, que decide si le puede hablar a la sesión dueña) la mantendría viva para
   * siempre: una vigilancia callada durante ocho horas nunca dejaría expirar a nadie.
   * Cuenta la expiración perezosa: una sesión pasada del TTL está muerta aunque el barrido de
   * los 5 minutos todavía no haya pasado, porque el próximo getSession la va a borrar.
   */
  hasSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return (new Date() - session.lastActivityAt) / 1000 / 60 <= config.session.ttl;
  }

  /**
   * Appends a new turn (user utterance or assistant response) 
   * and strictly maintains the CONTEXT_TURNS window limit.
   */
  addTurn(sessionId, role, content, { ephemeral = false } = {}) {
    // Turno EFÍMERO: se dice y no se recuerda. Es lo que hace la narración de una vigilancia
    // (plan VIGILANCE §9, "evidence frames are never persisted"). Sin esta salida, ocho horas
    // de vigilancia desalojan la conversación real de la ventana de CONTEXT_TURNS y dejan lo
    // observado grabado para siempre en memory.db, que es justamente la base que la política
    // del agente marca como sensible. Se sale ANTES de tocar la ventana, SQLite y el embedding:
    // las tres cosas son el daño, no solo la última.
    if (ephemeral) return false;

    const session = this.getSession(sessionId);
    if (!session) return false;

    session.turns.push({ role, content });

    // Persistir en la memoria de largo plazo (SQLite) antes de recortar la ventana.
    memoryStore.appendTurn(role, content);
    // Embeber el turno para recall vectorial (fire-and-forget, no bloquea el turno).
    this.embedTurn(role, content);

    // Evict older turns if we cross our architectural budget constraint
    if (session.turns.length > config.llm.contextTurns) {
      session.turns.shift(); // Drops oldest turn (sigue en SQLite / resumen)
    }

    session.lastActivityAt = new Date();
    // Plegar en el resumen de largo plazo cuando se acumulan turnos (en background).
    this.maybeSummarize();
    return true;
  }

  /** Embebe un turno y lo guarda para recall vectorial (background). */
  async embedTurn(role, content) {
    if (!config.memory.recallEnabled || !content || content.length < 8) return;
    try {
      const vec = await embed(`${role}: ${content}`);
      if (vec) memoryStore.addEmbedding(content, vec);
    } catch (error) {
      logger.error('embedTurn falló', { message: error.message });
    }
  }

  /**
   * Actualiza el resumen de largo plazo en background cuando hay suficientes turnos
   * nuevos sin resumir. Fire-and-forget con lock para no solaparse.
   */
  async maybeSummarize() {
    if (this._summarizing) return;
    const { mark, maxId, rows } = memoryStore.unsummarized();
    if (rows.length < SUMMARY_THRESHOLD) return;
    this._summarizing = true;
    try {
      const updated = await summarizeConversation(memoryStore.getSummary(), rows);
      memoryStore.setSummary(updated, maxId);
      logger.info('Memoria de largo plazo actualizada', { folded: rows.length, sinceId: mark });
    } catch (error) {
      logger.error('maybeSummarize falló', { message: error.message });
    } finally {
      this._summarizing = false;
    }
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
  /** Registra un callback que corre cuando una sesión se borra (limpieza de estado ajeno). */
  onDelete(fn) { (this._onDelete ||= new Set()).add(fn); return () => this._onDelete.delete(fn); }

  deleteSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      for (const fn of this._onDelete || []) { try { fn(sessionId); } catch { /* nunca romper el borrado */ } }
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

    // Recoger las claves antes de borrar: un hook de onDelete puede tocar el Map
    // (borrar otra sesión en cascada) y mutarlo a mitad de la iteración.
    const expired = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      const ageInMinutes = (now - session.lastActivityAt) / 1000 / 60;
      if (ageInMinutes > config.session.ttl) expired.push(sessionId);
    }

    // El barrido borra por la misma puerta que un borrado explícito. Con this.sessions.delete()
    // los hooks de onDelete no corrían, y todo mapa por sesión registrado con ellos
    // (orchestrator, agentBridge) se filtraba para siempre en las sesiones que expiran calladas,
    // que son la mayoría: casi nadie llama a DELETE /session/:id.
    for (const sessionId of expired) {
      if (this.deleteSession(sessionId)) purgeCount++;
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
    memoryStore.close();
  }
}

// Export as a single application-wide instance
export const conversationManager = new ConversationManager();