// src/state/shortcuts.js
// Atajos de voz para ABRIR apps/páginas ("abre youtube", "abre el navegador"). Antes
// estaban hardcodeados en tools.js; ahora viven en data/shortcuts.json (editable por el
// panel ⚙ y a mano) para que el usuario agregue los suyos sin tocar código. Ver SHORTCUTS.md.
//
//   sites: clave hablada -> dominio         (ej. "youtube" -> "youtube.com")  -> abre en el navegador
//   apps:  clave hablada -> clave de app    (ej. "navegador" -> "browser")    -> open_app (comando en config.tools.appAllowlist)
//
// Precedencia: DEFAULTS (horneados aquí) se escriben al archivo la primera vez; a partir
// de ahí el archivo es la fuente de verdad (lo que el usuario agregó/quitó se respeta).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'shortcuts.json');

// Defaults que se envían de fábrica: varias páginas y apps comunes ya listas.
export const DEFAULTS = {
  sites: {
    youtube: 'youtube.com', wikipedia: 'wikipedia.org', google: 'google.com', gmail: 'mail.google.com',
    github: 'github.com', twitter: 'twitter.com', x: 'x.com', reddit: 'reddit.com', chatgpt: 'chatgpt.com',
    whatsapp: 'web.whatsapp.com', telegram: 'web.telegram.org', spotify: 'open.spotify.com',
    netflix: 'netflix.com', twitch: 'twitch.tv', maps: 'maps.google.com', drive: 'drive.google.com',
    instagram: 'instagram.com', facebook: 'facebook.com', linkedin: 'linkedin.com', amazon: 'amazon.com',
    'mercado libre': 'mercadolibre.com', mercadolibre: 'mercadolibre.com',
  },
  // La clave de valor debe existir en config.tools.appAllowlist.
  apps: {
    navegador: 'browser', browser: 'browser', firefox: 'firefox', chrome: 'chrome',
    terminal: 'terminal', consola: 'terminal', code: 'code', vscode: 'vscode',
    archivos: 'files', files: 'files',
  },
};

let shortcuts = { sites: { ...DEFAULTS.sites }, apps: { ...DEFAULTS.apps } };

function normalize(obj = {}) {
  // Claves en minúscula y sin espacios extra; valores string no vacíos.
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).toLowerCase().trim();
    const val = String(v ?? '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/** Devuelve los atajos actuales (copia defensiva). */
export function getShortcuts() {
  return { sites: { ...shortcuts.sites }, apps: { ...shortcuts.apps } };
}

/** Reemplaza el set COMPLETO (lo que manda el panel es la verdad) y persiste. */
export function setShortcuts(next = {}) {
  shortcuts = {
    sites: normalize(next.sites || {}),
    apps: normalize(next.apps || {}),
  };
  persist();
  return getShortcuts();
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(shortcuts, null, 2));
  } catch (error) {
    logger.error('No se pudo persistir shortcuts.json', { message: error.message });
  }
}

/** Al boot: carga data/shortcuts.json; si no existe, lo crea con los defaults. */
export function loadShortcuts() {
  try {
    if (!fs.existsSync(FILE)) {
      persist();   // sembrar con defaults la primera vez
      logger.info('shortcuts.json creado con defaults');
      return;
    }
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    shortcuts = {
      sites: normalize(saved.sites || {}),
      apps: normalize(saved.apps || {}),
    };
    logger.info('Atajos de usuario cargados desde data/shortcuts.json');
  } catch (error) {
    logger.error('No se pudo cargar shortcuts.json (uso defaults)', { message: error.message });
  }
}
