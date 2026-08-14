// src/state/embeddings.js
// Embeddings locales (Ollama nomic-embed-text) + coseno, para el recall vectorial
// de la memoria de largo plazo (Fase F2). Persistencia pura, sin ciclos.
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Embebe un texto -> Float32Array (o null si falla). */
export async function embed(text) {
  if (!text || !text.trim()) return null;
  try {
    const res = await fetch(config.memory.embedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.memory.embedModel, prompt: text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const v = data.embedding || (data.embeddings && data.embeddings[0]);
    return v ? Float32Array.from(v) : null;
  } catch (error) {
    logger.error('embed falló', { message: error.message });
    return null;
  }
}

/** Similitud coseno entre dos vectores (misma longitud). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
