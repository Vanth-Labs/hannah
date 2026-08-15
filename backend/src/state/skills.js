// src/state/skills.js
// Sistema de SKILLS estilo Claude Code: cada skill es una carpeta con un SKILL.md
// (frontmatter + guía). MODEL-AGNÓSTICO: cualquier LLM lee el índice de skills y decide
// cuál usar emitiendo [SKILL: nombre | input]; el BACKEND ejecuta la acción declarada
// (run/terminal/open/search) — el modelo no inventa el comando, solo elige la skill.
// Opcionalmente `phrases:` para disparo determinista (fiable en cualquier modelo).
// CROSS-PLATFORM: las acciones aceptan variante por-OS (run.linux/run.mac/run.windows);
// se resuelve por process.platform.
//
// Defaults de fábrica: hannah-backend/skills/<name>/SKILL.md (committed).
// Skills del usuario:  data/skills/<name>/SKILL.md (gitignored). El usuario pisa por nombre.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { DATA_DIR } from './dataDir.js';
import { config } from '../config.js';
import { runTool, confirmIfDangerous } from '../pipeline/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_DIR = path.resolve(__dirname, '../../skills');   // defaults del repo
const USER_DIR = path.join(DATA_DIR, 'skills');                // del usuario (gitignored)

let skills = [];   // [{ name, description, action:{type,template}, confirm, phrases:[], body, raw, source }]

// ── Parser de frontmatter MÍNIMO (sin dependencias). Soporta:
//   key: value            -> string
//   key: [a, b, "c d"]    -> array
//   key: true|false       -> boolean
export function parseFrontmatter(raw) {   // exportada para tests (helper puro)
  const m = String(raw).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(raw).trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z_.]+)\s*:\s*(.*)$/);   // permite claves por-OS (run.linux)
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    // Comentario YAML al final, PERO no si el valor está entrecomillado (podría tener '#').
    if (!/^['"]/.test(val)) val = val.replace(/\s+#.*$/, '').trim();
    if (val === 'true' || val === 'false') { meta[key] = val === 'true'; continue; }
    // Desenvuelve SOLO comillas que rodean todo el valor (no una comilla de cierre del comando).
    const unquote = (s) => { const q = s.trim().match(/^(['"])([\s\S]*)\1$/); return q ? q[2] : s.trim(); };
    const arr = val.match(/^\[(.*)\]$/);
    if (arr) {
      meta[key] = arr[1].split(',').map(unquote).filter(Boolean);
    } else {
      meta[key] = unquote(val);
    }
  }
  return { meta, body: (m[2] || '').trim() };
}

// OS actual -> sufijo de clave. darwin=mac, win32=windows, resto=linux.
const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
// Elige la variante por-OS de una acción (run.linux) o la genérica (run).
const pick = (meta, type) => meta[`${type}.${OS}`] ?? meta[type] ?? null;

function toSkill(raw, fallbackName, source) {
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || fallbackName).toLowerCase().trim();
  if (!name) return null;
  // Exactamente UNA acción, con variante por-OS opcional (run.linux/mac/windows):
  //   run (shell) | terminal (sesión interactiva en el panel) | open (navegador) | search (web).
  let action = null;
  for (const type of ['run', 'terminal', 'open', 'search']) {
    const tpl = pick(meta, type);
    if (tpl) { action = { type, template: String(tpl) }; break; }
  }
  if (!action) return null;   // sin acción no es ejecutable
  return {
    name,
    description: String(meta.description || '').trim(),
    action,
    confirm: meta.confirm === true,
    phrases: Array.isArray(meta.phrases) ? meta.phrases.map((p) => String(p).toLowerCase()) : [],
    body,
    raw: String(raw),
    source,
  };
}

function scanDir(dir, source) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const s = toSkill(raw, e.name, source);
    if (s) out.push(s);
  }
  return out;
}

/** Al boot / tras editar: recarga defaults + skills del usuario (usuario pisa por nombre). */
export function loadSkills() {
  const shipped = scanDir(SHIPPED_DIR, 'shipped');
  const user = scanDir(USER_DIR, 'user');
  const byName = new Map();
  for (const s of shipped) byName.set(s.name, s);
  for (const s of user) byName.set(s.name, s);   // usuario gana
  skills = [...byName.values()];
  logger.info('skills cargadas', { total: skills.length, shipped: shipped.length, user: user.length });
  return skills;
}

export function getSkills() {
  return skills.map((s) => ({ ...s, phrases: [...s.phrases] }));
}

function findSkill(name) {
  const n = String(name || '').toLowerCase().trim();
  return skills.find((s) => s.name === n) || null;
}

// Arma "usuario@host" desde lenguaje natural dictado, p.ej.
// "192.168.1.30 con el usuario drocho" -> "drocho@192.168.1.30". Tolera relleno de la voz.
export function sshArg(raw) {   // exportada para tests (helper puro)
  let s = ` ${String(raw || '').trim()} `;
  let user = '';
  const mu = s.match(/\s(?:con\s+(?:el\s+)?usuario|como|usuario|user|con)\s+([^\s@]+)/i);
  if (mu) { user = mu[1].replace(/[.,;]+$/, ''); s = s.replace(mu[0], ' '); }
  // Palabras sueltas de relleno: se exige espacio a ambos lados para NO partir tokens con
  // guion (antes "mi-server.local" perdía el "mi-" y quedaba "server.local").
  s = s.replace(/(?<=\s)(?:un|una|el|la|al|a|mi|de|del|the|to|por|ssh)(?=\s)/gi, ' ').trim();
  // Si ya viene user@host, respetarlo. minúscula: la voz suele capitalizar ("DROCHO") y en
  // Linux el usuario es case-sensitive (casi siempre minúscula); hosts/IPs no se afectan.
  const at = s.match(/\S+@\S+/);
  if (at) return at[0].toLowerCase();
  const ip = s.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  const dom = s.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i);
  const host = (ip ? ip[0] : dom ? dom[0] : (s.split(/\s+/).filter(Boolean).pop() || '')).replace(/[.,;]+$/, '');
  return (user && host ? `${user}@${host}` : host).toLowerCase();
}

// Rellena {arg}/{cualquier} con el input capturado y ejecuta la acción vía runTool.
async function execSkill(skill, arg, ctx) {
  const filled = skill.action.template.replace(/\{[^}]*\}/g, (arg || '').trim());
  if (skill.action.type === 'run') {
    // El handler de run_command limpia el prompt y emite el toast (único origen).
    const r = await runTool('run_command', { command: filled }, ctx);
    return `[Salida real de "${filled}"]:\n${r}`;
  }
  if (skill.action.type === 'open') {
    const r = await runTool('open_url', { url: filled }, ctx);
    return `[${r}]`;
  }
  if (skill.action.type === 'search') {
    const r = await runTool('web_search', { query: filled }, ctx);
    return `[Resultados de buscar "${filled}"]:\n${r}`;
  }
  if (skill.action.type === 'terminal') {
    // Sesión interactiva (ssh, top, python...). No captura: abre el panel y escribe el
    // comando; el usuario sigue la sesión (password, etc.). Mismo gate que run_command.
    if (!config.tools.systemControl) return 'terminal access is off (enable system control)';
    // SSH: armar user@host desde lo dictado (más robusto que el {arg} literal).
    const command = /^\s*ssh\b/i.test(skill.action.template) ? `ssh ${sshArg(arg)}`.trim() : filled;
    const gate = await confirmIfDangerous(command, ctx);   // mismo gate que run_command
    if (!gate.approved) return gate.message;
    // Con argumento dictado por voz -> NO ejecutar solo: lo escribe y el usuario da Enter
    // (así corrige si la voz falló el host/usuario). Sin argumento -> corre directo.
    const autorun = !/\{[^}]*\}/.test(skill.action.template);
    ctx?.send?.({ type: 'open_terminal', command, run: autorun });
    // IMPORTANTE: instrucción tajante — el modelo NO debe simular la salida/sesión (qwen tiende
    // a inventar un login ssh completo). Solo un aviso corto.
    return autorun
      ? `La terminal ya está abierta y corriendo "${command}". Decí en UNA frase corta que lo abriste. PROHIBIDO inventar o mostrar salida, banner o login.`
      : `Abriste la terminal y dejaste ESCRITO (sin ejecutar) el comando "${command}". Decí en UNA frase corta que lo escribiste y que el usuario lo revise y apriete Enter. PROHIBIDO inventar o simular cualquier salida, sesión, login o banner.`;
  }
  return null;
}

/** Invocación por el modelo: [SKILL: nombre | arg]. Devuelve el resultado a inyectar, o null. */
export async function resolveSkill(name, arg, ctx) {
  const skill = findSkill(name);
  if (!skill) return null;
  return execSkill(skill, arg, ctx);
}

// Normaliza para matchear: minúsculas y SIN acentos (la voz/ASR varía "cómo"/"como",
// "conéctate"/"conectate"). Así el disparo no depende de tildes.
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Relleno que NO cuenta como palabra clave (para el match por keywords, orden libre).
const STOP = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'a', 'en', 'mi',
  'que', 'se', 'es', 'esta', 'este', 'esto', 'esa', 'ese', 'tu', 'the', 'of', 'my', 'to', 'por', 'con', 'y',
  // verbos/pronombres genéricos: no distinguen una skill (evita falsos positivos).
  'tengo', 'tenes', 'tiene', 'hay', 'dame', 'decime', 'quiero', 'saber', 'ver', 'esto', 'eso', 'me', 'lo', 'esta']);

/** Disparo DETERMINISTA: dispara una skill si el texto matchea alguna `phrase`. Robusto:
 *  sin acentos; para skills SIN argumento basta con que estén TODAS las palabras clave de la
 *  frase (en cualquier orden); para skills CON {arg} usa substring y toma el resto como arg. */
export async function resolveSkillPhrase(text, ctx) {
  const t = norm(text);
  for (const skill of skills) {
    const hasArg = /\{[^}]*\}/.test(skill.action.template);
    for (const phrase of skill.phrases) {
      const p = norm(phrase);
      if (hasArg) {
        const i = t.indexOf(p);
        if (i >= 0) return execSkill(skill, t.slice(i + p.length).trim().replace(/[.?!,;]+$/, ''), ctx);
      } else {
        if (t.includes(p)) return execSkill(skill, '', ctx);
        const kw = p.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
        if (kw.length && kw.every((w) => t.includes(w))) return execSkill(skill, '', ctx);
      }
    }
  }
  return null;
}

/** Índice COMPACTO de skills (una línea c/u) para el system prompt. Se mantiene chico a
 *  propósito: son atajos con nombre; para CUALQUIER otro comando el modelo usa [RUN:]
 *  (ver el protocolo). '' si no hay skills. */
export function skillsPromptSection() {
  if (!skills.length) return '';
  const lines = skills.map((s) => {
    const eg = s.action.template.includes('{') ? `[SKILL: ${s.name}|input]` : `[SKILL: ${s.name}]`;
    return `  ${eg} — ${s.description || s.name}`;
  });
  return `\n\nNamed SKILLS (shortcuts). Use one only if it clearly matches; otherwise use [RUN:].\n`
    + lines.join('\n');
}

// ── Edición (panel ⚙): escribe/borra en data/skills/<name>/SKILL.md y recarga ──
export function saveSkill(name, content) {
  const n = String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
  if (!n) throw new Error('nombre de skill inválido');
  const dir = path.join(USER_DIR, n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), String(content ?? ''));
  loadSkills();
  return getSkills();
}

export function deleteSkill(name) {
  const n = String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
  const dir = path.join(USER_DIR, n);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  loadSkills();
  return getSkills();
}
