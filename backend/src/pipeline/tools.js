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

  // run_command: DESACTIVADO salvo config.tools.systemControl=true, y solo prefijos
  // del allowlist (sin shell arbitrario, sin sudo/rm/redirecciones).
  run_command: {
    schema: fn('run_command', 'Run one of the allowed shell commands. Only enabled if the user turned system control on.',
      { command: { type: 'string', description: 'command to run' } }, ['command']),
    handler: async ({ command }) => {
      if (!config.tools.systemControl) return 'system control is disabled';
      const c = String(command || '').trim();
      if (/[;&|`$><]|\bsudo\b|\brm\b|\bmkfs\b|\bdd\b/.test(c)) return 'blocked: unsafe command';
      const ok = config.tools.cmdAllowlist.some((p) => c.startsWith(p));
      if (!ok) return `blocked: only these are allowed: ${config.tools.cmdAllowlist.join(', ')}`;
      return await new Promise((res) => exec(c, { timeout: 5000 }, (e, out) =>
        res(e ? `error: ${e.message}` : (out || 'done').slice(0, 400))));
    },
  },
};

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
