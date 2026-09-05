// src/pipeline/tools.js
// Tools locales que Hannah puede invocar (function-calling). Cada tool = schema
// (formato OpenAI) + handler(args, ctx). ctx trae { sessionId } para las que lo
// necesitan (look_now). SEGURIDAD: system control por allowlist / flag (ver abajo).
import { exec, execFile } from 'child_process';
import net from 'node:net';
import dns from 'node:dns/promises';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { describeFrame } from './vlm.js';
import { getLastFrame } from '../state/frameStore.js';
import { runCommand, requestConfirm } from './terminal.js';
import { isHealthy as handsHealthy, dispatch as dispatchTask, clean } from './agentBridge.js';
import * as senseClient from './senseClient.js';
import { closeWindows } from './desktop/index.js';
import { getShortcuts } from '../state/shortcuts.js';

// Comandos DESTRUCTIVOS que requieren confirmación del usuario (lo demás corre libre).
export const DANGER = /\brm\s+\S|\brmdir\b|\bunlink\b|\bRemove-Item\b|\bdel\s+\S|\bmkfs|\bdd\s+.*\bof=|:\(\)\s*\{\s*:|>\s*\/dev\/(?!null)|\bchmod\s+-R\s+0|\b(shutdown|reboot|poweroff|halt|fdisk|wipefs|userdel|mkswap)\b|\bgit\s+.*--force|\bmv\s+\S+\s+\/\s*$/i;

/**
 * Gate de seguridad ÚNICO para todo lo que ejecuta comandos (run_command y las skills
 * `terminal`): si el comando matchea DANGER, le pide confirmación al usuario y espera.
 * Devuelve { approved, message } — `message` es la respuesta a darle al modelo si se niega.
 */
export async function confirmIfDangerous(command, ctx) {
  if (!DANGER.test(command)) return { approved: true };
  if (!ctx?.send) return { approved: false, message: `refused for safety (no way to ask you to confirm): ${command}` };
  const { id, promise } = requestConfirm();
  ctx.send({ type: 'confirm_command', id, command });
  const approved = await promise;
  return approved
    ? { approved: true }
    : { approved: false, message: `the user did NOT approve running: ${command}` };
}

/**
 * Guardia SSRF para lo que el modelo pide leer: solo hosts públicos. Rechaza loopback, redes
 * privadas, link-local (metadata de nube), IPv6 local, y nombres que no resuelven a algo
 * público. Devuelve el motivo (string) si hay que rechazar, o '' si es público.
 */
export async function publicHostOnly(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return 'invalid url'; }
  if (!/^https?:$/.test(parsed.protocol)) return 'only http(s)';
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'local name';
  const bad = (ip) => {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split('.').map(Number);
      return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(ip)) {
      const v = ip.toLowerCase();
      if (v === '::1' || v === '::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
      const m4 = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return m4 ? bad(m4[1]) : false;
    }
    return true;
  };
  if (net.isIP(host)) return bad(host) ? 'private address' : '';
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return 'unresolvable';
    return addrs.some((a) => bad(a.address)) ? 'resolves to a private address' : '';
  } catch { return 'unresolvable'; }
}

// Normaliza a URL absoluta https:// si el modelo/usuario dio solo el dominio.
const ensureHttps = (url) => (/^https?:\/\//i.test(url || '') ? url : `https://${url}`);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOLS = {
  get_datetime: {
    schema: fn('get_datetime', 'Get the current local date and time.'),
    handler: async () => new Date().toLocaleString(),
  },

  look_now: {
    schema: fn('look_now', 'Look through your camera right now and describe what you currently see.'),
    handler: async (_args, ctx) => {
      if (config.vision.provider === 'off') return 'vision is switched off on this install (no vision model); say so plainly';
      const frame = getLastFrame(ctx?.sessionId);
      if (!frame) return 'the camera is not active right now';
      return (await describeFrame(frame, 'Describe briefly what you see right now.')) || 'could not make it out';
    },
  },

  get_weather: {
    schema: fn('get_weather', 'Get the current weather for a location.',
      { location: { type: 'string', description: 'city or place' } }, ['location']),
    handler: async ({ location }) => {
      try {
        const r = await fetch(`https://wttr.in/${encodeURIComponent(location || '')}?format=j1`);
        const c = (await r.json())?.current_condition?.[0];
        return c
          ? `${c.weatherDesc?.[0]?.value}, ${c.temp_C}°C (feels ${c.FeelsLikeC}°C), humidity ${c.humidity}%`
          : 'weather unavailable';
      } catch { return 'weather unavailable'; }
    },
  },

  // ── INTERNET ────────────────────────────────────────────────────────────
  fetch_url: {
    schema: fn('fetch_url', 'Open a web page and return its readable text (for reading articles/docs).',
      { url: { type: 'string', description: 'the URL to read' } }, ['url']),
    handler: async ({ url }) => {
      try {
        const u = ensureHttps(url);
        // SSRF: nunca leer direcciones internas (sidecars, el agente, metadata de nube).
        const why = await publicHostOnly(u);
        if (why) return `refused to fetch that address (${why})`;
        const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000), redirect: 'manual' });
        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ').trim();
        return text ? text.slice(0, 2500) : 'the page had no readable text';
      } catch (error) { return `could not fetch that page: ${error.message}`; }
    },
  },

  open_url: {
    schema: fn('open_url', 'Open a URL in the default browser (a VISIBLE window, to show the user a page).',
      { url: { type: 'string', description: 'the URL to open' } }, ['url']),
    handler: async ({ url }) => {
      const u = ensureHttps(url);
      // Validar y NO pasar por shell: execFile con args -> la URL nunca se interpreta (sin inyección).
      let parsed;
      try { parsed = new URL(u); } catch { return `invalid url: ${url}`; }
      if (!/^https?:$/.test(parsed.protocol)) return 'only http(s) urls are allowed';
      const done = (e) => { if (e) logger.error('open_url exec', { message: e.message }); };
      if (process.platform === 'darwin') execFile('open', [u], done);
      else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', u], done);
      else execFile('xdg-open', [u], done);
      return `opening ${u} in the browser`;
    },
  },

  close_window: {
    schema: fn('close_window', 'Close desktop windows matching a name (a browser, an app, a page title). Never closes Hannah herself.',
      { target: { type: 'string', description: 'app or window to close, e.g. "browser", "youtube", "terminal"' } }, ['target']),
    handler: async ({ target }) => {
      const t = (target || '').toLowerCase().trim();
      if (!t) return 'no window specified';
      const aliasKey = Object.keys(CLOSE_ALIAS).find((k) => t.includes(k));
      const queries = aliasKey ? CLOSE_ALIAS[aliasKey] : [t];
      const n = await closeWindows(queries.filter(Boolean));
      return n ? `closed ${n} window(s) matching "${target}"` : `no window matching "${target}" was open`;
    },
  },

  web_search: {
    schema: fn('web_search', 'Search the web and return the top results (title, snippet, url).',
      { query: { type: 'string', description: 'what to search for' } }, ['query']),
    handler: async ({ query }) => {
      try {
        const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query || '')}`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
        const html = await r.text();
        const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
        const out = [];
        const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) && out.length < 5) {
          let href = m[1];
          if (/y\.js|ad_domain|ad_provider/.test(href)) continue;   // saltar anuncios
          const uddg = href.match(/[?&]uddg=([^&]+)/);       // DDG envuelve la URL real
          if (uddg) href = decodeURIComponent(uddg[1]);
          out.push(`${strip(m[2])} — ${strip(m[3])} (${href})`);
        }
        return out.length ? out.join('\n') : 'no results found';
      } catch (error) { return `search failed: ${error.message}`; }
    },
  },

  // ── SYSTEM CONTROL (con candados) ──────────────────────────────────────
  // open_app: SOLO abre apps del allowlist (el LLM elige la clave, nunca el comando).
  open_app: {
    schema: fn('open_app', 'Open one of the allowed desktop applications by name.',
      { name: { type: 'string', description: 'app name' } }, ['name']),
    handler: async ({ name }) => {
      const key = String(name || '').toLowerCase().trim();
      const cmd = config.tools.appAllowlist[key];
      if (!cmd) return `"${name}" is not in the allowed apps (${Object.keys(config.tools.appAllowlist).join(', ')})`;
      exec(cmd, (e) => { if (e) logger.error('open_app exec', { message: e.message }); });
      return `opening ${key}`;
    },
  },

  // run_command: terminal REAL (pty persistente: cd/env persisten; ssh/git/curl/etc.).
  // Solo si systemControl=true. Corre libre; SOLO pide confirmación si es destructivo.
  run_command: {
    schema: fn('run_command',
      'Run a shell command in your terminal. Persistent shell (cd/env persist across calls); '
      + 'supports ssh, git, curl, package managers and interactive tools. Use it to inspect or act on the system.',
      { command: { type: 'string', description: 'the shell command to run' } }, ['command']),
    handler: async ({ command }, ctx) => {
      if (!config.tools.systemControl) return 'terminal access is off (enable system control to allow it)';
      const cmd = String(command || '').trim();
      if (!cmd) return 'no command given';
      const gate = await confirmIfDangerous(cmd, ctx);
      if (!gate.approved) return gate.message;
      let out = await runCommand(ctx?.sessionId || 'default', cmd);
      // Limpiar líneas de prompt del shell y mostrar el toast (para CUALQUIER origen: el
      // modelo con [RUN:], la capa determinista o una skill).
      out = String(out).split('\n').filter((l) => !/^\(?[\w.@-]*\)?\s*\[[^\]]*\]\s*[$#]/.test(l)).join('\n').trim();
      ctx?.send?.({ type: 'command_run', command: cmd, output: out.slice(0, 1200) });
      return out || '(sin salida)';
    },
  },
};

// Detecta "abre/ábreme X" (ES/EN) y lo abre de forma DETERMINISTA (no depende de que el
// LLM emita [BROWSE:]/[OPEN:]). Los mapas de sitios/apps vienen de shortcuts.js (editable
// por el usuario en el panel ⚙ / data/shortcuts.json). Devuelve true si lo manejó.
export async function handleOpenIntent(text, ctx) {
  const s = (text || '').toLowerCase();
  const m = s.match(/(?:^|\s)(?:[aá]bre(?:me|la|lo)?|abrir|open)\s+(?:me\s+|el\s+|la\s+|una?\s+)?(.+)/);
  if (!m) return false;
  const target = m[1].trim().replace(/\s+en (?:el|mi) navegador.*$/, '').replace(/[.,!?¿¡]+$/, '').trim();
  if (!target) return false;
  const { sites, apps } = getShortcuts();
  const hasDomain = /\.[a-z]{2,}(?:\/|$|\s)/.test(target);
  // App conocida (sin dominio) -> open_app (busca la clave hablada más larga que coincida).
  if (!hasDomain) {
    const appKey = Object.keys(apps).filter((a) => target.includes(a)).sort((a, b) => b.length - a.length)[0];
    if (appKey) { await runTool('open_app', { name: apps[appKey] }, ctx); return true; }
  }
  // Sitio conocido o dominio explícito -> open_url.
  const siteKey = Object.keys(sites).filter((k) => target.includes(k)).sort((a, b) => b.length - a.length)[0];
  const url = siteKey ? sites[siteKey] : (hasDomain ? target.replace(/\s+/g, '') : null);
  if (url) { await runTool('open_url', { url }, ctx); return true; }
  return false;
}

// Detecta "cierra/cerrar X" (ES/EN) y cierra las ventanas que coincidan, DETERMINISTA vía
// el compositor (hyprctl/wmctrl). Nunca cierra a Hannah. Devuelve true si lo manejó.
// Alias -> qué buscar en título/clase de la ventana. "navegador" cubre varios navegadores.
const CLOSE_ALIAS = {
  navegador: ['zen', 'firefox', 'chrom', 'brave', 'vivaldi', 'librewolf'],
  browser: ['zen', 'firefox', 'chrom', 'brave', 'vivaldi', 'librewolf'],
  terminal: ['kitty', 'foot', 'alacritty', 'konsole', 'gnome-terminal', 'wezterm', 'st-256'],
  consola: ['kitty', 'foot', 'alacritty', 'konsole', 'gnome-terminal', 'wezterm', 'st-256'],
  editor: ['code', 'zed', 'sublime', 'gedit'],
  code: ['code'], vscode: ['code'], archivos: ['nautilus', 'dolphin', 'thunar', 'nemo'], files: ['nautilus', 'dolphin', 'thunar', 'nemo'],
};
export async function handleCloseIntent(text, ctx) {
  const s = (text || '').toLowerCase();
  const m = s.match(/(?:^|\s)(?:ci[eé]rr[aae]|cerr[aá]r?|close)(?:me|te|la|lo|las|los)?\s+(?:el\s+|la\s+|los\s+|las\s+|una?\s+|esta\s+|ese\s+|the\s+)?(.+)/);
  if (!m) return false;
  const target = m[1].trim().replace(/\s+(?:por favor|please|ahora|ya)\s*$/i, '').replace(/[.,!?¿¡]+$/, '').trim();
  if (!target) return false;
  // "cierra esto / la ventana / esta ventana" -> ventana enfocada (no implementado por nombre): ignorar.
  if (/^(esto|eso|la ventana|esta ventana|esa ventana|window)$/.test(target)) return false;
  const aliasKey = Object.keys(CLOSE_ALIAS).find((k) => target.includes(k));
  const queries = aliasKey ? CLOSE_ALIAS[aliasKey] : [target.replace(/\s+ventana.*$/, '').trim()];
  const n = await closeWindows(queries.filter(Boolean));
  ctx?.send?.({ type: 'window_close', target, closed: n });
  return true;   // manejado aunque n===0 (no había esa ventana), para no alucinar
}

// ── VIGILANCIAS: armar una por voz (plan VIGILANCE, M5.1.3) ─────────────────────────────
// Una vigilancia es un estado de atención que SOBREVIVE al turno: el sidecar hannah-sense
// (:8007) muestrea cada tanto y avisa cuando lo mirado cambia. Acá vive lo determinista:
// reconocer el pedido, NEGARSE antes de prometer nada si el escalón que haría falta no está en
// esta máquina, y construir el spec tipado que viaja al sidecar. El sidecar solo MIRA (regla R1
// del plan): nada de esto ejecuta ni arregla nada.

// El catálogo de sensores, en el orden de la escalera. ÚNICA fuente de tres cosas que si no
// serían cuatro listas que se separan solas: qué escalón implementa cada sensor, qué vocabulario
// ve el modelo (llm.js renderiza el protocolo desde acá), cómo se arma el spec, y con qué nombre
// manda cada campo quien no habla por tags (la ruta REST, `args`). Regla R2: un
// sensor es un objeto TIPADO con campos con nombre, NUNCA una cadena de comando — por eso
// `build` devuelve campos y en ninguna parte se concatena nada.
export const WATCH_SENSORS = [
  {
    rung: 'R1', kind: 'proc', tag: 'proc', args: ['pattern'],
    usage: '[WATCH: proc | <pattern>]', hint: 'a process is still alive',
    build: ([pattern]) => (pattern
      ? { sensor: { kind: 'proc', pattern } }
      : { error: 'a proc watch needs the pattern that matches the process' }),
  },
  {
    rung: 'R2', kind: 'file', tag: 'file', args: ['path', 'minutes'],
    usage: '[WATCH: file | <path> | <minutes>]', hint: 'a file stopped being written to for that many minutes',
    build: ([path, minutes]) => {
      if (!path) return { error: 'a file watch needs the path of the file' };
      // El modelo escribe MINUTOS porque es como lo dice el usuario ("cinco minutos"); el
      // contrato del sensor son segundos. La conversión vive acá, en un solo lugar, y se acota
      // a los límites del sensor para que un "0" no se convierta en un 400 después de que
      // Hannah ya dijo que estaba mirando.
      const asked = Number(String(minutes ?? '').replace(/[^\d.]/g, '')) || 5;
      return { sensor: { kind: 'file', path, stallSeconds: Math.min(86400, Math.max(5, Math.round(asked * 60))) } };
    },
  },
  {
    rung: 'R3', kind: 'logmatch', tag: 'log', args: ['path', 'pattern'],
    usage: '[WATCH: log | <path> | <pattern>]', hint: 'a pattern shows up in a log',
    build: ([path, pattern]) => {
      if (!path) return { error: 'a log watch needs the path of the log' };
      if (!pattern) return { error: 'a log watch needs the pattern to look for' };
      return { sensor: { kind: 'logmatch', path, pattern } };
    },
  },
  {
    rung: 'R5', kind: 'port', tag: 'port', args: ['port'],
    usage: '[WATCH: port | <number>]', hint: 'something is still listening on a port',
    build: ([port]) => {
      const n = Number.parseInt(String(port ?? '').replace(/[^\d]/g, ''), 10);
      return Number.isInteger(n) && n >= 1 && n <= 65535
        ? { sensor: { kind: 'port', port: n } }
        : { error: 'a port watch needs a port number between 1 and 65535' };
    },
  },
  {
    rung: 'R6', kind: 'unit', tag: 'unit', args: ['unit'],
    usage: '[WATCH: unit | <name.service>]', hint: 'a system service is still up',
    build: ([unit]) => (unit && !/\s/.test(unit)
      ? { sensor: { kind: 'unit', unit } }
      : { error: 'a unit watch needs the name of a single service, like docker.service' }),
  },
];

/** Los sensores que ESTA máquina puede armar hoy, según la sonda viva de /v1/capabilities. */
export const armableWatchSensors = (survey) => WATCH_SENSORS.filter(
  (s) => survey?.rungs?.[s.rung]?.available === true && (survey.sensors || []).includes(s.kind));

// Verbos que SIEMPRE son un pedido de vigilancia, y verbos que lo son solo si además se nombra
// una forma de romperse. "avisame si" y "tell me if" sueltos son conversación normal ("tell me
// if you know"); con "se para"/"stops" al lado son un pedido de vigilancia. Partirlo en dos
// mitades es lo que evita que cada "decime si" arme algo.
// Sin `\b` de cierre a propósito, y no por descuido: `á`/`ó` no son \w en JS, así que un
// `\b` detrás de "vigilá" o de "se cayó" NUNCA casa y la mitad castellana quedaba muerta.
// Donde hace falta cortar la palabra se usa (?!\w), que solo mira hacia adelante.
const WATCH_VERB_STRONG = /(?:^|\s)(?:vigil|monitore|keep an eye on)/i;
const WATCH_VERB_WEAK = /(?:^|\s)(?:av[ií]s[aá]me|dec[ií]me|asegur[aá]te|f[ií]jate|let me know|tell me|ping me|check|make sure|watch\w*)(?!\w)/i;
const WATCH_TRIP = /(?:^|\W)(?:se\s+(?:para|frena|cae|cuelga|muere|corta|detiene|traba|cay[oó])|deja\s+de\s+\w+|stops?|stopped|dies?|died|crash\w*|fails?|failed|freezes?|hangs?|goes\s+down)(?!\w)/i;

// Los tiers que esta fase NO tiene. Se detectan por lo que dice la FRASE para poder contestar
// lo que se pidió ("no puedo mirar la pantalla") en vez de la lista de lo que sí hay: el que
// pidió mirar una ventana no quiere enterarse de que puede mirar puertos. La razón hablada la
// escribe el backend a propósito: la del sidecar es para el operador ("llega en P5.5, falta
// tesseract") y nombra hitos internos que no significan nada dichos en voz alta.
const WATCH_TIERS = [
  {
    rung: 'R6b',
    re: /(?:^|\W)(?:ssh|remot\w*|el\s+servidor|the\s+server|otra\s+m[aá]quina|another\s+machine|remote\s+host)(?!\w)/i,
    why: 'watching a machine over the network is not something I can do from here',
  },
  {
    rung: 'R8',
    re: /(?:^|\W)(?:pantalla|screen|ventana|window|bot[oó]n|button|barra\s+de\s+progreso|progress\s+bar|pixel\w*)(?!\w)/i,
    why: 'I cannot look at what is on the display; I can only watch processes, files, logs, ports and services',
  },
  {
    rung: 'R7',
    re: /(?:^|\W)(?:widget|at-spi|accesibilidad|accessibility)(?!\w)/i,
    why: 'I cannot reach inside another application to watch its controls',
  },
];

/**
 * ¿Es esta frase un pedido de vigilancia, y se puede? Devuelve:
 *   null            -> no es un pedido de vigilancia; el turno sigue normal
 *   { refuse: why } -> lo es y NO se puede: se habla la razón y no se arma nada
 *   { pass: true }  -> lo es y se puede: lo arma el modelo con [WATCH:], que ya vio en el
 *                      prompt el vocabulario de los escalones disponibles
 * Negarse ACÁ, antes de que hable, es la mitad que importa: una vigilancia que se arma y
 * falla después ya fue prometida en voz alta, y la corrección llega cuando el usuario se fue.
 */
export async function resolveWatchIntent(text) {
  const t = String(text || '');
  if (!WATCH_VERB_STRONG.test(t) && !(WATCH_VERB_WEAK.test(t) && WATCH_TRIP.test(t))) return null;

  const survey = await senseClient.survey();
  const tier = WATCH_TIERS.find((x) => x.re.test(t));
  if (tier && survey.rungs?.[tier.rung]?.available !== true) {
    // La razón del sidecar al log, la del backend a la voz: son dos audiencias distintas.
    logger.info('vigilancia rechazada por tier', { rung: tier.rung, reason: survey.rungs?.[tier.rung]?.reason || 'ausente' });
    return { refuse: tier.why };
  }
  if (!armableWatchSensors(survey).length) {
    return { refuse: survey.error
      ? 'the part of me that watches things is not running right now'
      : 'there is nothing on this machine I can keep an eye on right now' };
  }
  return { pass: true };
}

/** Parsea el argumento de [WATCH: kind | a | b] al spec TIPADO del sidecar. Puro. */
export function parseWatchTag(arg) {
  const parts = String(arg || '').split('|').map((s) => s.trim());
  const tag = (parts.shift() || '').toLowerCase().replace(/[^a-z]/g, '');
  const entry = WATCH_SENSORS.find((s) => s.tag === tag || s.kind === tag);
  if (!entry) return { error: `"${tag || arg}" is not something I know how to watch` };
  return entry.build(parts);
}

/**
 * Arma la vigilancia que pidió el modelo con [WATCH:]. Devuelve { watchId } o { error, reason }.
 * Nunca lanza (senseClient tampoco). La narración de lo que pase DESPUÉS (disparos, ceguera,
 * el buzón) es del puente senseBridge.js (M5.1.4); acá solo se arma y se dice si no se pudo.
 */
export async function armWatch(sessionId, tagArg, label) {
  const parsed = parseWatchTag(tagArg);
  if (parsed.error) return { error: 'bad_watch_spec', reason: parsed.error };
  return armSensor(sessionId, parsed.sensor, label);
}

/**
 * Traduce un spec tipado con campos POR NOMBRE ({ kind:'file', path, minutes }) al del sidecar.
 * Es la puerta de quien no habla por tags: la ruta REST. Los campos se leen del catálogo, así
 * que un objeto crudo del cliente nunca viaja entero y un campo de más se cae solo. Puro.
 */
export function specFromFields(sensor) {
  const kind = String(sensor?.kind || '');
  const entry = WATCH_SENSORS.find((s) => s.kind === kind || s.tag === kind);
  if (!entry) return { error: `"${clean(kind, 20) || 'that'}" is not something I know how to watch` };
  return entry.build(entry.args.map((a) => sensor[a]));
}

/**
 * Arma un sensor YA tipado. Es el único lugar donde se decide con qué período, con qué debounce
 * y hasta cuándo vive una vigilancia, venga de la voz o de la ruta REST: dos copias de esa
 * política se separan, y la que se quede vieja arma vigilancias que nadie recuerda haber pedido.
 * `sessionId` es la preferencia de entrega; sin él (REST) la vigilancia nace sin dueño y lo que
 * dispare va al buzón hasta que alguien se conecte.
 */
export async function armSensor(sessionId, sensor, label) {
  const survey = await senseClient.survey();
  if (!armableWatchSensors(survey).some((s) => s.kind === sensor.kind)) {
    return { error: 'rung_unavailable', reason: 'that rung is not available on this machine' };
  }
  const r = await senseClient.createWatch({
    // La ETIQUETA son las palabras del USUARIO, saneadas: ni la paráfrasis del modelo ni una
    // línea observada. Es lo único de esta vigilancia que vuelve al system prompt en cada turno
    // mientras esté armada, así que es el punto exacto donde una inyección se volvería
    // permanente (plan §9 T9). `clean` es el mismo saneador que usa el puente del agente, y acá
    // hace lo que puede hacer de este lado: la etiqueta que se guarda es la que ve el USUARIO en
    // el HUD, con su puntuación. Quien la neutraliza para el MODELO es watchLabel (llm.js), en el
    // momento de escribirla en el prompt, porque esta fila puede volver del sidecar (o de la ruta
    // REST) sin haber pasado nunca por acá.
    label: clean(label, 80) || 'what you asked me to watch',
    sensor,
    periodMs: config.sense.minPeriodMs,
    debounceN: config.sense.debounceN,
    // Asunción A3: no hay vigilancias abiertas para siempre. El sidecar EXIGE expiresAt.
    expiresAt: Date.now() + config.sense.watchTtlMs,
    // Preferencia de entrega, no dueño: la vigilancia vive en el sidecar y sobrevive a la
    // sesión que la armó (plan §10).
    ...(sessionId ? { sessionId } : {}),
  });
  senseClient.invalidate();   // la foto anterior de watches/capacidades ya es mentira
  return r;
}

// Intents de DATOS deterministas: "ejecuta X", "busca X", "lee la url X". Ejecuta la
// acción y devuelve el RESULTADO real para inyectarlo al LLM (así no lo inventa). null
// si no aplica. (open/move se manejan aparte porque no necesitan resultado.)
const DELETE_STOPWORDS = new Set(['you', 'it', 'that', 'this', 'the', 'one', 'them', 'those', 'these', 'which', 'what', 'we', 'i',
  'ese', 'esa', 'eso', 'esos', 'esas', 'este', 'esta', 'esto', 'aquel', 'aquella', 'lo', 'la', 'el', 'los', 'las', 'que', 'creaste', 'created']);

export async function resolveDataAction(text, ctx) {
  const t = text || '';
  let m;

  // Limpiar la terminal: "limpiá/borrá/clearea la terminal/consola/pantalla" -> evento a xterm.
  if (/(?:^|\s)(?:limpi[aá]|borr[aá]|clear(?:e[aá])?|clean|vaci[aá])\w*\s+(?:la\s+|el\s+|mi\s+)?(?:terminal|consola|pantalla|shell)\b/i.test(t)) {
    ctx?.send?.({ type: 'terminal_clear' });
    return '[Limpiaste la terminal. Decilo en una frase corta.]';
  }

  // Con las manos activas (política agent-first y agente sano), lo que ESCRIBE o BORRA no se
  // corre acá: va al agente con las palabras literales del usuario. Este parser pierde cosas
  // ("crea prueba.txt en ~/Documentos que diga hola" acababa en un `touch prueba.txt` en $HOME
  // sin el directorio ni el texto); el agente entiende la frase entera y pide permiso.
  const handsOn = () => config.tools.runPolicy !== 'free' && config.agent.enabled && handsHealthy() && !!ctx?.sessionId;
  const handToHands = async (what, title) => {
    const r = await dispatchTask(ctx.sessionId, what, { title });
    if (r.error) return `[Not done: your hands could not take it (${r.error}). Tell the user you cannot do that right now.]`;
    return '[Handed to your HANDS. Tell the user briefly that you are on it; do NOT claim any result yet — '
      + 'your hands will report back and you will relay what they say.]';
  };
  const runAndReport = async (raw, { sentence = null, writes = false } = {}) => {
    let cmd = (raw || '').trim();
    const wrap = cmd.match(/^(['"`])([\s\S]*)\1$/);   // desenvolver SOLO si TODO está entre comillas
    if (wrap) cmd = wrap[2].trim();
    cmd = cmd.replace(/[.?!]+$/, '').trim();
    if (!cmd) return null;
    if (writes && handsOn()) {
      return sentence
        ? handToHands(`The user asked, in their own words: "${sentence}". Do exactly that and report what you did.`, sentence.slice(0, 50))
        : handToHands(`Run this command and report its result: ${cmd}`, `run: ${cmd.slice(0, 50)}`);
    }
    // El handler de run_command limpia el prompt y emite el toast command_run (único origen).
    const r = await runTool('run_command', { command: cmd }, ctx);
    return `[Salida real de "${cmd}"]:\n${r}`;
  };
  // ANTES que cualquier rama de "correr": el verbo `run` de RUN_VERBS se come "check that my
  // training RUN doesn't stop" — verificado, la rama 3 matchea y ejecuta `doesn't stop` —, y la
  // rama 1 (comillas + RUN_HINT) se comería "vigilá `train.py`". Un pedido de vigilancia que
  // llega acá ya no es un pedido de vigilancia: es un comando basura y un turno de narración.
  const watch = await resolveWatchIntent(t);
  if (watch?.refuse) {
    // Se contesta ANTES de que el modelo hable, así que no puede prometer nada. Es la mitad del
    // hito: la alternativa es armar algo que falla cuando el usuario ya no está mirando.
    return `[You can NOT watch that: ${watch.refuse}. Tell the user plainly, in one sentence, `
      + 'that you will NOT be keeping an eye on it, and why. Do NOT promise to check later and '
      + 'do NOT claim any watch is running.]';
  }
  // Es una vigilancia y se puede: ni "corré" ni "leé" ni "borrá" la tocan. Devolver null (y no
  // un resultado) deja el turno con las acciones VIVAS, que es lo que hace falta para que el
  // modelo pueda emitir su [WATCH:]. Una frase que pide las dos cosas ("corré X y avisame si se
  // para") también cae acá: la arma el modelo, que tiene [TASK:] y [WATCH:] a la vez.
  if (watch?.pass) return null;

  // Verbos imperativos de "correr" (voseo/tú/infinitivo/enclítico + EN). Preciso a
  // propósito: excluye "hace" (calor/tiempo) y "tira"/"correo" para no correr basura.
  const RUN_VERBS = 'corr[eé]r?(?:me|lo)?|ejecut[aá]r?(?:me|lo)?|lanz[aá]r?|tir[aá]r|run|exec(?:ute)?|haz|hac[eé]lo|hac[é]';
  const RUN_HINT = new RegExp(`\\b(?:${RUN_VERBS})\\b`, 'i');

  // 1) Comando entre backticks/comillas + intención de correr -> lo más fiable.
  const quoted = t.match(/`([^`]+)`/) || t.match(/'([^']{2,})'/) || t.match(/"([^"]{2,})"/);
  if (quoted && RUN_HINT.test(t)) return runAndReport(quoted[1], { writes: true });

  // 1.5) Leer/mostrar un ARCHIVO local -> cat. ANTES que "ls" y que "lee <url>", para que
  // "cat X", "mostrame el archivo X", "leé /ruta/x.txt" no se confundan con listar carpeta
  // ni con una URL. Extrae SOLO la ruta (ignora relleno como "del archivo").
  {
    // Raíces + sufijo libre (sin \b final: matchea "mostrame", "leéme", acentos, etc.).
    const wantsRead = /(?:^|\s)cat\b/i.test(t)
      || /\b(?:le[eé]|leer|read|mostr|muestr|ense[ñn]|imprim)\w*/i.test(t);
    const isUrl = /https?:\/\//i.test(t) || /\b[\w-]+\.(?:com|org|net|io|dev|gg|tv|co|app|ai)\b/i.test(t);
    const fileTok = t.match(/((?:~|\.{0,2})\/[^\s"'`]+|[^\s"'`/]+\.[A-Za-z0-9]{1,5})/);
    if (wantsRead && !isUrl && fileTok) return runAndReport(`cat ${JSON.stringify(fileTok[1])}`);
  }

  // 2) CREAR un archivo: "creá/creame [un] archivo <nombre> [con (el) contenido/texto <...>]".
  if ((m = t.match(/(?:^|\s)(?:cre[aá]r?(?:me)?|crea)\s+(?:un\s+|el\s+|una\s+)?(?:archivo|fichero|file|nota|documento)\s+(?:llamado\s+|de\s+nombre\s+|con\s+nombre\s+)?([^\s,]+)(?:\s+con\s+(?:el\s+)?(?:contenido|texto|el\s+texto)\s+(.+))?/i))) {
    const name = m[1].replace(/[.,;]+$/, '');
    const content = (m[2] || '').trim().replace(/[.]+$/, '');
    return runAndReport(content ? `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(name)}` : `touch ${JSON.stringify(name)}`, { sentence: t, writes: true });
  }

  // 2.2) BORRAR archivo/carpeta -> rm (SIEMPRE pide confirmación por el guard DANGER). No confundir
  // con "borrá la terminal" (se maneja arriba). Extrae la ruta/nombre real.
  // Negado ("no borres X", "do not delete anything") NO es una orden de borrar: sin este
  // guardián, "do not delete the file report.txt" ejecutaba `rm report.txt`.
  const negatedDelete = /\b(?:no|nunca|jam[aá]s|don'?t|do\s+not|never|without)\s+(?:me\s+|lo\s+|la\s+|los\s+|las\s+)?(?:elimin|borr|remove|delet|\brm\b)/i.test(t);
  if (!negatedDelete
      && /(?:^|\s)(?:elimin[aá]r?(?:me)?|borr[aá]r?(?:me)?|borra|remove|delete|\brm\b)/i.test(t)
      && !/\b(terminal|consola|pantalla|shell)\b/i.test(t)) {
    const dir = /\b(carpeta|directorio|folder|dir)\b/i.test(t);
    let target = null;
    let mm;
    if ((mm = t.match(/((?:~|\.{0,2})\/[^\s"'`]+)/))) target = mm[1];                 // ruta con /
    else if ((mm = t.match(/(?:archivo|fichero|carpeta|directorio|file|folder|llamad[oa]|de\s+nombre)\s+(?:"([^"]+)"|'([^']+)'|([^\s,]+))/i))) target = mm[1] || mm[2] || mm[3];
    else if ((mm = t.match(/([^\s"'`/]+\.[A-Za-z0-9]{1,6})/))) target = mm[1];         // nombre.ext
    // "delete the file YOU just created" / "borra ESE archivo": el objetivo es una referencia, no
    // un nombre. No es un intent determinista (salía `rm "you"`): que lo resuelva el modelo, que
    // con las manos activas delega con contexto.
    if (target && DELETE_STOPWORDS.has(target.replace(/[.,;]+$/, '').toLowerCase())) target = null;
    if (target) {
      target = target.replace(/[.,;]+$/, '');
      return runAndReport(`rm ${dir ? '-r ' : ''}${JSON.stringify(target)}`, { sentence: t, writes: true });
    }
  }

  // 2.5) LISTAR la carpeta: "listá/listame/lista/ls" o "mostrá los archivos" (ruta opcional).
  if (/(?:^|\s)(?:list[aá]\w*|ls\b)/i.test(t) || /\bmostr\w*\s+(?:los\s+)?archivos?\b/i.test(t)) {
    const dir = t.match(/((?:~|\.{0,2})\/[^\s"'`]+)/);
    return runAndReport(dir ? `ls -la ${JSON.stringify(dir[1])}` : 'ls -la');
  }

  // (Las frases comunes tipo "qué kernel", "cuánto espacio" migraron a SKILLS cross-platform
  //  con `phrases:` — ver state/skills.js y skills/. resolveSkillPhrase corre antes que esto.)

  // 3) Verbo explícito + comando: "corré/ejecutá/hacé [un] <cmd>"
  if ((m = t.match(new RegExp(`(?:^|\\s)(?:${RUN_VERBS})\\s+(?:el\\s+comando\\s+|the\\s+command\\s+|una?\\s+|a\\s+)?(.+)`, 'i')))) {
    return runAndReport(m[1]);
  }
  // Leer una URL: "lee (la url) X"
  if ((m = t.match(/(?:^|\s)(?:lee|leé|read|abre y lee)\s+(?:la\s+(?:url|p[aá]gina|web)\s+|the\s+)?(\S+\.\S+\S*)/i))) {
    const r = await runTool('fetch_url', { url: m[1].trim() }, ctx);
    return `[Contenido de ${m[1].trim()}]:\n${r}`;
  }
  // Buscar en internet: "busca X (en internet/google)"
  if ((m = t.match(/(?:^|\s)(?:busc[aá]|search)\s+(?:en internet\s+|en google\s+|en la web\s+|for\s+)?(.+)/i))) {
    const q = m[1].trim().replace(/\s+en (?:internet|google|la web)\s*$/i, '').replace(/[.?!]+$/, '');
    const r = await runTool('web_search', { query: q }, ctx);
    return `[Resultados de buscar "${q}"]:\n${r}`;
  }
  return null;
}

export async function runTool(name, args, ctx) {
  const t = TOOLS[name];
  if (!t) return `unknown tool: ${name}`;
  try {
    logger.info('tool invocada', { name });
    return await t.handler(args || {}, ctx);
  } catch (error) {
    logger.error('tool falló', { name, message: error.message });
    return `error running ${name}: ${error.message}`;
  }
}
