// src/state/frameStore.js
// Último frame de cámara por sesión. Módulo aislado (sin deps de pipeline) para que
// tanto visionLoop como tools.js lo usen sin crear ciclos de import.
const frames = new Map();

export const pushFrame = (sessionId, frame) => { if (sessionId && frame) frames.set(sessionId, frame); };
export const getLastFrame = (sessionId) => frames.get(sessionId) || null;
export const clearFrame = (sessionId) => frames.delete(sessionId);
