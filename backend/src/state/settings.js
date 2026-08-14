// src/state/settings.js
// Config de proveedores mutable en runtime (app self-hosted, UN usuario por instancia).
// El pipeline lee siempre `config.*`, así que aquí solo mutamos ese objeto in-place.
// Precedencia: defaults de .env (seed) -> data/settings.json (lo que el user cambió) ->
// PATCH en runtime vía POST /settings.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Campos editables por sección (whitelist). Nada fuera de esto se toca desde la API.
const ALLOWED = {
  llm: ['provider', 'model', 'apiKey', 'baseUrl', 'persona'],
  asr: ['provider', 'model', 'apiKey', 'language', 'sidecarUrl'],
  tts: ['provider', 'model', 'apiKey', 'voiceId', 'sidecarUrl'],
};

// Campos que en blanco NO se sobreescriben (conservan el valor actual).
const KEEP_IF_BLANK = new Set(['apiKey', 'persona']);

/**
 * Merge de un patch dentro de `config` in-place.
 * Un apiKey en blanco/ausente NO sobreescribe (para que el round-trip redactado
 * del frontend no borre un secreto ya guardado).
 */
export function applySettings(patch = {}) {
  for (const section of Object.keys(ALLOWED)) {
    const incoming = patch[section];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const key of ALLOWED[section]) {
      if (!(key in incoming)) continue;
      let value = incoming[key];
      if (KEEP_IF_BLANK.has(key) && (value == null || String(value).trim() === '')) {
        continue; // blanco = conservar el valor existente (key/persona)
      }
      if (key === 'baseUrl' && value === '') value = null; // '' -> OpenAI oficial
      config[section][key] = value;
    }
  }
  return getSettings();
}

/**
 * Vista redactada para el browser: el apiKey real NUNCA se devuelve, solo un
 * booleano `hasApiKey` que indica si hay una key guardada.
 */
export function getSettings() {
  const out = {};
  for (const section of Object.keys(ALLOWED)) {
    out[section] = {};
    for (const key of ALLOWED[section]) {
      if (key === 'apiKey') out[section].hasApiKey = Boolean(config[section][key]);
      else out[section][key] = config[section][key] ?? '';
    }
  }
  return out;
}

// Snapshot completo (con secretos) para el archivo en disco.
function snapshot() {
  const out = {};
  for (const section of Object.keys(ALLOWED)) {
    out[section] = {};
    for (const key of ALLOWED[section]) out[section][key] = config[section][key] ?? '';
  }
  return out;
}

/** Escribe data/settings.json (gitignored, como .env). */
export function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(snapshot(), null, 2));
  } catch (error) {
    logger.error('No se pudo persistir settings.json', { message: error.message });
  }
}

/** Al boot: aplica data/settings.json POR ENCIMA de los defaults de .env. */
export function loadPersisted() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    applySettings(saved);
    logger.info('Settings de usuario cargados desde data/settings.json');
  } catch (error) {
    logger.error('No se pudo cargar settings.json', { message: error.message });
  }
}
