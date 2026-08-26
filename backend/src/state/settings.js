// src/state/settings.js
// Config de proveedores mutable en runtime (app self-hosted, UN usuario por instancia).
// El pipeline lee siempre `config.*`, así que aquí solo mutamos ese objeto in-place.
// Precedencia: defaults de .env (seed) -> data/settings.json (lo que el user cambió) ->
// PATCH en runtime vía POST /settings.
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { jsonFile } from './dataDir.js';

const SETTINGS_FILE = jsonFile('settings.json');

// Campos editables por sección (whitelist). Nada fuera de esto se toca desde la API.
const ALLOWED = {
  llm: ['provider', 'model', 'apiKey', 'baseUrl', 'persona'],
  asr: ['provider', 'model', 'apiKey', 'language', 'sidecarUrl'],
  tts: ['provider', 'model', 'apiKey', 'voiceId', 'sidecarUrl'],
  // El token es un secreto: entra en SECRETS y nunca vuelve al navegador (se redacta).
  agent: ['url', 'token', 'mode', 'apiKey'],
};

// Secretos: nunca vuelven al navegador (se redactan a hasApiKey/hasToken).
const SECRETS = new Set(['apiKey', 'token']);

const blank = (value) => value == null || String(value).trim() === '';

export function applySettings(patch = {}) {
  for (const section of Object.keys(ALLOWED)) {
    const incoming = patch[section];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const key of ALLOWED[section]) {
      if (!(key in incoming)) continue;
      const value = incoming[key];
      // En blanco = conservar lo que hay (el valor del .env o el guardado antes). El panel
      // manda el formulario ENTERO: rellenar solo la key del agente llegaba con `model: ""`
      // y `baseUrl: ""` para el cerebro -> el backend apuntaba a OpenAI sin modelo, y con
      // `agent.url: ""` las manos quedaban "no disponibles". Vaciar un campo nunca es una
      // orden; para cambiar de proveedor se escribe el nuevo valor (o se usa un preset).
      if (blank(value)) continue;
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
      // Secretos: nunca el valor, solo si hay uno guardado (apiKey -> hasApiKey, token -> hasToken).
      if (key === 'apiKey') out[section].hasApiKey = Boolean(config[section][key]);
      else if (key === 'token') out[section].hasToken = Boolean(config[section][key]);
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
  SETTINGS_FILE.write(snapshot());
}

/** Al boot: aplica data/settings.json POR ENCIMA de los defaults de .env. */
export function loadPersisted() {
  const saved = SETTINGS_FILE.read();
  if (!saved) return;
  applySettings(saved);
  logger.info('Settings de usuario cargados desde data/settings.json');
}
