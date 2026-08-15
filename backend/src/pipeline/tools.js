// src/pipeline/tools.js
// Tools locales que Hannah puede invocar (function-calling). Cada tool = schema
// (formato OpenAI) + handler(args, ctx). ctx trae { sessionId } para las que lo
// necesitan (look_now). SEGURIDAD: system control por allowlist / flag (ver abajo).
import { exec } from 'child_process';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { describeFrame } from './vlm.js';
import { getLastFrame } from '../state/frameStore.js';
import { memoryStore } from '../state/memoryStore.js';
import { embed, cosine } from '../state/embeddings.js';
import { runCommand, requestConfirm } from './terminal.js';
import { closeWindows } from './desktop/index.js';
import { getShortcuts } from '../state/shortcuts.js';

// Comandos DESTRUCTIVOS que requieren confirmación del usuario (lo demás corre libre).
export const DANGER = /\brm\s+-[a-z]*[rf]|\brm\s+\S*\s*\/(?:\s|$|\*)|\bmkfs|\bdd\s+.*\bof=|:\(\)\s*\{\s*:|>\s*\/dev\/(?!null)|\bchmod\s+-R\s+0|\b(shutdown|reboot|poweroff|halt|fdisk|wipefs|userdel|mkswap)\b|\bgit\s+.*--force|\bmv\s+\S+\s+\/\s*$/i;

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

  recall_memory: {
    schema: fn('recall_memory', 'Search your long-term memory for things the user told you in earlier conversations.',
      { query: { type: 'string', description: 'what to look up' } }, ['query']),
    handler: async ({ query }) => {
      const q = await embed(query || '');
      if (!q) return 'memory unavailable';
      const top = memoryStore.embeddings(2000)
        .map((r) => ({ t: r.text, s: cosine(q, r.vec) }))
        .sort((a, b) => b.s - a.s).filter((r) => r.s > 0.5).slice(0, 3);
      return top.length ? top.map((r) => r.t).join(' | ') : 'nothing relevant found';
    },
  },

  look_now: {
    schema: fn('look_now', 'Look through your camera right now and describe what you currently see.'),
    handler: async (_args, ctx) => {
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
        const u = /^https?:\/\//i.test(url || '') ? url : `https://${url}`;
        const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
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
      const u = /^https?:\/\//i.test(url || '') ? url : `https://${url}`;
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      exec(`${opener} "${u}"`, (e) => { if (e) logger.error('open_url exec', { message: e.message }); });
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
      // Confirmación SOLO para comandos destructivos.
      if (DANGER.test(cmd)) {
        if (!ctx?.send) return `refused for safety (no way to ask you to confirm): ${cmd}`;
        const { id, promise } = requestConfirm();
        ctx.send({ type: 'confirm_command', id, command: cmd });
        const approved = await promise;
        if (!approved) return `the user did NOT approve running: ${cmd}`;
      }
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

// Intents de DATOS deterministas: "ejecuta X", "busca X", "lee la url X". Ejecuta la
// acción y devuelve el RESULTADO real para inyectarlo al LLM (así no lo inventa). null
// si no aplica. (open/move se manejan aparte porque no necesitan resultado.)
export async function resolveDataAction(text, ctx) {
  const t = text || '';
  let m;

  // Limpiar la terminal: "limpiá/borrá/clearea la terminal/consola/pantalla" -> evento a xterm.
  if (/(?:^|\s)(?:limpi[aá]|borr[aá]|clear(?:e[aá])?|clean|vaci[aá])\w*\s+(?:la\s+|el\s+|mi\s+)?(?:terminal|consola|pantalla|shell)\b/i.test(t)) {
    ctx?.send?.({ type: 'terminal_clear' });
    return '[Limpiaste la terminal. Decilo en una frase corta.]';
  }

  // ── EJECUTAR COMANDOS EN LA TERMINAL (determinista; es lo que más falla si se deja
  // al LLM). Tres capas de más a menos fiable: backticks -> frase conocida -> verbo. ──
  const runAndReport = async (raw) => {
    const cmd = (raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/[.?!]+$/, '').trim();
    if (!cmd) return null;
    // El handler de run_command limpia el prompt y emite el toast command_run (único origen).
    const r = await runTool('run_command', { command: cmd }, ctx);
    return `[Salida real de "${cmd}"]:\n${r}`;
  };
  // Verbos imperativos de "correr" (voseo/tú/infinitivo/enclítico + EN). Preciso a
  // propósito: excluye "hace" (calor/tiempo) y "tira"/"correo" para no correr basura.
  const RUN_VERBS = 'corr[eé]r?(?:me|lo)?|ejecut[aá]r?(?:me|lo)?|lanz[aá]r?|tir[aá]r|run|exec(?:ute)?|haz|hac[eé]lo|hac[é]';
  const RUN_HINT = new RegExp(`\\b(?:${RUN_VERBS})\\b`, 'i');

  // 1) Comando entre backticks/comillas + intención de correr -> lo más fiable.
  const quoted = t.match(/`([^`]+)`/) || t.match(/'([^']{2,})'/) || t.match(/"([^"]{2,})"/);
  if (quoted && RUN_HINT.test(t)) return runAndReport(quoted[1]);

  // 1.5) Leer/mostrar un ARCHIVO local -> cat. ANTES que "ls" y que "lee <url>", para que
  // "cat X", "mostrame el archivo X", "leé /ruta/x.txt" no se confundan con listar carpeta
  // ni con una URL. Extrae SOLO la ruta (ignora relleno como "del archivo").
  {
    // Raíces + sufijo libre (sin \b final: matchea "mostrame", "leéme", acentos, etc.).
    const wantsRead = /(?:^|\s)cat\b/i.test(t)
      || /\b(?:le[eé]|leer|read|mostr|muestr|ense[ñn]|imprim)\w*/i.test(t);
    const isUrl = /https?:\/\//i.test(t) || /\b[\w-]+\.(?:com|org|net|io|dev|gg|tv|co|app|ai)\b/i.test(t);
    const fileTok = t.match(/((?:~|\.{0,2})\/[^\s"'`]+|[^\s"'`/]+\.[A-Za-z0-9]{1,5})/);
    if (wantsRead && !isUrl && fileTok) return runAndReport(`cat ${fileTok[1]}`);
  }

  // 2) CREAR un archivo: "creá/creame [un] archivo <nombre> [con (el) contenido/texto <...>]".
  if ((m = t.match(/(?:^|\s)(?:cre[aá]r?(?:me)?|crea)\s+(?:un\s+|el\s+|una\s+)?(?:archivo|fichero|file|nota|documento)\s+(?:llamado\s+|de\s+nombre\s+|con\s+nombre\s+)?([^\s,]+)(?:\s+con\s+(?:el\s+)?(?:contenido|texto|el\s+texto)\s+(.+))?/i))) {
    const name = m[1].replace(/[.,;]+$/, '');
    const content = (m[2] || '').trim().replace(/[.]+$/, '');
    return runAndReport(content ? `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(name)}` : `touch ${JSON.stringify(name)}`);
  }

  // 2.5) LISTAR la carpeta: "listá/listame/lista/ls" o "mostrá los archivos" (ruta opcional).
  if (/(?:^|\s)(?:list[aá]\w*|ls\b)/i.test(t) || /\bmostr\w*\s+(?:los\s+)?archivos?\b/i.test(t)) {
    const dir = t.match(/((?:~|\.{0,2})\/[^\s"'`]+)/);
    return runAndReport(dir ? `ls -la ${dir[1]}` : 'ls -la');
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

// Schemas de las tools habilitadas (respeta config.tools.names y systemControl).
export function toolSchemas() {
  if (!config.tools.enabled) return [];
  return config.tools.names
    .filter((n) => TOOLS[n] && (n !== 'run_command' || config.tools.systemControl))
    .map((n) => TOOLS[n].schema);
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
