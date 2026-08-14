// src/state/memoryStore.js
// Memoria PERSISTENTE de largo plazo (SQLite local). App self-hosted, un usuario:
// una sola línea de historia + un "resumen rodante" que sobrevive reinicios.
// Sin dependencias de LLM aquí (persistencia pura) para evitar ciclos de import;
// el resumen lo genera conversationManager con el helper de llm.js.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'memory.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    vec BLOB NOT NULL,
    ts INTEGER NOT NULL
  );
`);

const _append = db.prepare('INSERT INTO turns (role, content, ts) VALUES (?, ?, ?)');
const _recent = db.prepare('SELECT role, content FROM turns ORDER BY id DESC LIMIT ?');
const _unsummarized = db.prepare('SELECT id, role, content FROM turns WHERE id > ? ORDER BY id ASC');
const _maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM turns');
const _getKv = db.prepare('SELECT value FROM kv WHERE key = ?');
const _setKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const _addEmb = db.prepare('INSERT INTO embeddings (text, vec, ts) VALUES (?, ?, ?)');
const _allEmb = db.prepare('SELECT text, vec FROM embeddings ORDER BY id DESC LIMIT ?');

export const memoryStore = {
  appendTurn(role, content) {
    _append.run(role, content, Date.now());
  },
  // Últimos n turnos en orden cronológico (viejo -> nuevo).
  recentTurns(n) {
    return _recent.all(n).reverse().map(({ role, content }) => ({ role, content }));
  },
  // Turnos aún no incluidos en el resumen (id > mark).
  unsummarized() {
    const mark = parseInt(_getKv.get('summary_upto_id')?.value || '0', 10);
    const rows = _unsummarized.all(mark);
    return { mark, maxId: _maxId.get().m, rows };
  },
  getSummary() {
    return _getKv.get('summary')?.value || '';
  },
  setSummary(text, uptoId) {
    _setKv.run('summary', text);
    if (uptoId != null) _setKv.run('summary_upto_id', String(uptoId));
  },
  // Vector recall (Fase F2): guarda/lee embeddings como BLOB float32.
  addEmbedding(text, float32) {
    _addEmb.run(text, Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength), Date.now());
  },
  // Últimos `limit` embeddings como {text, vec:Float32Array}.
  embeddings(limit = 2000) {
    return _allEmb.all(limit).map(({ text, vec }) => ({
      text,
      vec: new Float32Array(vec.buffer, vec.byteOffset, vec.length / 4),
    }));
  },
  close() {
    try { db.close(); } catch (e) { logger.error('memory.db close', { message: e.message }); }
  },
};
