// src/state/skills.js
// Sistema de SKILLS estilo Claude Code: cada skill es una carpeta con un SKILL.md
// (frontmatter + guía). MODEL-AGNÓSTICO: cualquier LLM lee el índice de skills y decide
// cuál usar emitiendo [SKILL: nombre | input]; el BACKEND ejecuta la acción declarada
// (run/open/search) — el modelo no inventa el comando, solo elige la skill. Opcionalmente
// una skill declara `phrases:` para además dispararse determinista (fiable en cualquier modelo).
//
// Defaults de fábrica: hannah-backend/skills/<name>/SKILL.md (committed).
// Skills del usuario:  data/skills/<name>/SKILL.md (gitignored). El usuario pisa por nombre.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { runTool } from '../pipeline/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_DIR = path.resolve(__dirname, '../../skills');       // defaults del repo
const USER_DIR = path.resolve(__dirname, '../../data/skills');     // del usuario (gitignored)

let skills = [];   // [{ name, description, action:{type,template}, confirm, phrases:[], body, raw, source }]

// ── Parser de frontmatter MÍNIMO (sin dependencias). Soporta:
//   key: value            -> string
//   key: [a, b, "c d"]    -> array
//   key: true|false       -> boolean
function parseFrontmatter(raw) {
  const m = String(raw).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(raw).trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
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

function toSkill(raw, fallbackName, source) {
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || fallbackName).toLowerCase().trim();
  if (!name) return null;
  // Exactamente UNA acción: run (shell) | open (navegador) | search (web).
  let action = null;
  if (meta.run) action = { type: 'run', template: String(meta.run) };
  else if (meta.open) action = { type: 'open', template: String(meta.open) };
  else if (meta.search) action = { type: 'search', template: String(meta.search) };
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
  let entries = [];
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

// Rellena {arg}/{cualquier} con el input capturado y ejecuta la acción vía runTool.
async function execSkill(skill, arg, ctx) {
  const filled = skill.action.template.replace(/\{[^}]*\}/g, (arg || '').trim());
  if (skill.action.type === 'run') {
    let r = await runTool('run_command', { command: filled }, ctx);
    // Quita las líneas de prompt del shell y emite el toast (igual que runAndReport en tools.js).
    r = String(r).split('\n').filter((l) => !/^\(?[\w.@-]*\)?\s*\[[^\]]*\]\s*[$#]/.test(l)).join('\n').trim();
    ctx?.send?.({ type: 'command_run', command: filled, output: r.slice(0, 1200) });
    return `[Salida real de "${filled}"]:\n${r || '(sin salida)'}`;
  }
  if (skill.action.type === 'open') {
    const r = await runTool('open_url', { url: filled }, ctx);
    return `[${r}]`;
  }
  if (skill.action.type === 'search') {
    const r = await runTool('web_search', { query: filled }, ctx);
    return `[Resultados de buscar "${filled}"]:\n${r}`;
  }
  return null;
}

/** Invocación por el modelo: [SKILL: nombre | arg]. Devuelve el resultado a inyectar, o null. */
export async function resolveSkill(name, arg, ctx) {
  const skill = findSkill(name);
  if (!skill) return null;
  return execSkill(skill, arg, ctx);
}

/** Disparo DETERMINISTA opcional: si el texto contiene una `phrases` de alguna skill, la
 *  ejecuta capturando lo que sigue a la frase como arg. null si ninguna matchea. */
export async function resolveSkillPhrase(text, ctx) {
  const t = String(text || '').toLowerCase();
  for (const skill of skills) {
    for (const phrase of skill.phrases) {
      const i = t.indexOf(phrase);
      if (i === -1) continue;
      const arg = String(text).slice(i + phrase.length).trim().replace(/[.?!,;]+$/, '');
      return execSkill(skill, arg, ctx);
    }
  }
  return null;
}

/** Índice compacto de skills para inyectar en el system prompt (dinámico). '' si no hay. */
export function skillsPromptSection() {
  if (!skills.length) return '';
  const lines = skills.map((s) => {
    const eg = s.action.template.includes('{')
      ? ` e.g. [SKILL: ${s.name} | <input>]` : ` e.g. [SKILL: ${s.name}]`;
    return `  - ${s.name}: ${s.description || s.name}.${eg}`;
  });
  return `\n\nYou have these SKILLS. Invoke ONE inline with [SKILL: name | input] only when it\n`
    + `clearly fits what the user wants; the app runs it and gives you the real result to\n`
    + `narrate (never invent it). Omit the "| input" part for skills that take none.\n`
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
