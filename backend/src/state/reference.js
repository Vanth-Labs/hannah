// src/state/reference.js
// Documentos de REFERENCIA (cheat-sheets) que GUÍAN al modelo para escribir el comando
// correcto — que luego ejecuta con [RUN:]. No son ejecutables (a diferencia de las skills);
// son conocimiento. Un `linux.md` grande con muchos comandos > 20 skills de un comando c/u.
//
// Defaults: hannah-backend/reference/*.md (committed). Usuario: data/reference/*.md (gitignored).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIRS = [
  path.resolve(__dirname, '../../reference'),        // defaults del repo
  path.resolve(__dirname, '../../data/reference'),   // del usuario (gitignored)
];
const MAX_CHARS = 6000;   // cota para no inflar el prompt

let docs = [];   // [{ name, content }]

export function loadReference() {
  docs = [];
  for (const dir of DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8').trim();
        if (content) docs.push({ name: f.replace(/\.md$/, ''), content });
      } catch { /* skip */ }
    }
  }
  logger.info('referencia cargada', { docs: docs.length });
  return docs;
}

/** Bloque para inyectar en el system prompt: los cheat-sheets, con tope de tamaño. '' si no hay. */
export function referencePromptSection() {
  if (!docs.length) return '';
  let body = docs.map((d) => d.content).join('\n\n');
  if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n…(reference truncated)`;
  return `\n\n# COMMAND REFERENCE (use with [RUN:])\nThese cheat-sheets tell you the exact command`
    + ` for common requests. When a request matches, emit [RUN: <command>] — don't ask the user`
    + ` to phrase it, and don't answer from memory.\n\n${body}`;
}
