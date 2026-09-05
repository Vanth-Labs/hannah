// src/api/auth.js
// Quién puede hablarle al backend. Regla: los clientes de ESTA máquina (la app Electron, el
// navegador local a través del proxy de Vite) entran sin más; cualquier otro origen — otro
// equipo de la red, vía el proxy de Vite en modo LAN — necesita el token de la UI.
//
// Por qué así: el backend escucha en 127.0.0.1, pero Vite (0.0.0.0:5173) le hace de proxy, así
// que "loopback" solo protege si sabemos QUIÉN está detrás del proxy. Vite añade
// X-Forwarded-For (xfwd) con la IP real del cliente; se toma la ÚLTIMA entrada, que es la que
// puso el proxy (un cliente puede mandar su propio X-Forwarded-For, pero queda delante).
//
// El token: HANNAH_UI_TOKEN en el entorno, o data/ui-token (se genera la primera vez, modo
// 0600). El launcher lo imprime en la URL del modo services. Comparación en tiempo constante.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { DATA_DIR } from '../state/dataDir.js';
import { logger } from '../utils/logger.js';

export const TOKEN_FILE = process.env.HANNAH_UI_TOKEN_FILE || path.join(DATA_DIR, 'ui-token');

let cached = null;

/** El token de la UI: del entorno, del archivo, o recién generado (y guardado 0600). */
export function uiToken() {
  if (cached) return cached;
  if (config.uiToken) { cached = String(config.uiToken).trim(); return cached; }
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) { cached = t; return cached; }
  } catch { /* no existe todavía */ }
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
    logger.info('UI token generado', { file: TOKEN_FILE });
  } catch (e) {
    logger.error('No se pudo guardar el UI token', { message: e.message });
  }
  cached = t;
  return cached;
}

/** IP real del cliente: la última entrada de X-Forwarded-For (la puso el proxy) o el socket. */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || req.ip || '';
}

export function isLoopback(ip) {
  const s = String(ip || '');
  return s === '::1' || s === 'localhost' || /^127\./.test(s) || /^::ffff:127\./.test(s);
}

function tokenFrom(req) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch { /* url rara */ }
  return null;
}

function equal(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * ¿Puede este request usar la API? Loopback real -> sí. Si no, hace falta el token.
 * Devuelve { ok, reason } — `reason` solo para el log.
 */
export function authorize(req) {
  const ip = clientIp(req);
  if (isLoopback(ip)) return { ok: true, reason: 'loopback' };
  const t = tokenFrom(req);
  if (t && equal(t, uiToken())) return { ok: true, reason: 'token' };
  return { ok: false, reason: t ? 'bad_token' : 'no_token', ip };
}

/**
 * El control plane de las VIGILANCIAS, que es el único lugar donde el backend es más estricto
 * que su propio default, y a propósito (plan VIGILANCE §9).
 *
 * `authorize()` de arriba abre para cualquier IP de loopback sin token, y para el resto de la API
 * eso está bien: nada se mueve sin que un humano diga algo. Una vigilancia es la primera
 * primitiva de este sistema que corre SIN ninguna frase del usuario, así que acá el token hace
 * falta igual, y cualquier request con `Origin` se rechaza: una página abierta en el navegador de
 * esta misma máquina alcanza 127.0.0.1:3001 con un request "simple" y sin preflight, y el
 * navegador es el único cliente que pone `Origin` (fetch de Node no lo pone). Mismo guardia,
 * palabra por palabra, que la fachada del agente y que el sidecar :8007.
 *
 * CONSECUENCIA, y es deliberada: el HUD, que ES un navegador, no puede usar estas rutas. Por eso
 * las vigilancias le llegan por el WebSocket (watch_armed/watch_state) y las desarma por ahí
 * (WATCH_DISARM). Estas rutas son para lo que no es navegador: el launcher, `hannah doctor`.
 */
export function authorizeWatch(req) {
  if (req.headers?.origin) return { ok: false, reason: 'origin', ip: clientIp(req) };
  const t = tokenFrom(req);
  if (t && equal(t, uiToken())) return { ok: true, reason: 'token' };
  return { ok: false, reason: t ? 'bad_token' : 'no_token', ip: clientIp(req) };
}

/** Middleware de /api/v1/watches. 403 al que trae Origin, 401 al que no trae token válido. */
export function requireWatchAuth(req, res, next) {
  const a = authorizeWatch(req);
  if (a.ok) return next();
  if (a.reason === 'origin') {
    logger.warn('vigilancias: request con Origin rechazado', { ip: a.ip, path: req.path });
    return res.status(403).json({ error: 'forbidden', message: 'The watch control plane does not serve browsers.' });
  }
  logger.warn('vigilancias: sin token válido', { ip: a.ip, reason: a.reason, path: req.path });
  return res.status(401).json({ error: 'unauthorized', message: 'The watch control plane needs the UI token, even from this machine (see ./hannah services).' });
}

/** Middleware Express para /api/v1: todo menos /health (que no revela nada sensible). */
export function requireUiAuth(req, res, next) {
  // /health no revela nada sensible; GET/HEAD /avatar es el modelo 3D que el cargador pide sin cabeceras.
  if (req.path === '/health' || (req.path === '/avatar' && (req.method === 'GET' || req.method === 'HEAD'))) return next();
  const a = authorize(req);
  if (a.ok) return next();
  logger.warn('API rechazada: cliente no local sin token válido', { ip: a.ip, path: req.path });
  return res.status(401).json({ error: 'unauthorized', message: 'This backend only serves the local machine; remote access needs the UI token (see ./hannah services).' });
}
