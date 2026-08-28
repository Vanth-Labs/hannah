// src/pipeline/terminal.js
// Terminal real por sesión: un pseudo-terminal (node-pty) persistente por conversación,
// para que Hannah (y el usuario, vía el panel xterm) corran comandos con estado (cd/env),
// SSH e interactivos. Salida en vivo a los suscriptores (el panel) + captura para el LLM.
import os from 'os';
import path from 'node:path';
import fs from 'node:fs';
import pty from 'node-pty';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

const sessions = new Map();   // sessionId -> { pty, subs:Set<send>, lastData }

function create(sessionId) {
  // Shell por OS: Windows -> PowerShell/cmd; Linux/Mac -> login shell del usuario.
  const isWin = process.platform === 'win32';
  // Windows: PowerShell si esta (siempre, en 10/11), y cmd solo de respaldo; COMSPEC apunta a cmd.
  const psPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const shell = isWin ? (fs.existsSync(psPath) ? psPath : (process.env.COMSPEC || 'cmd.exe')) : (process.env.SHELL || 'bash');
  const args = isWin ? [] : ['-l'];
  // Sin secretos en el shell: las API keys del backend no tienen por qué verlas los comandos
  // (un `env` en el panel, una skill, o un modelo con mala intención las leería).
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/(_API_KEY|_TOKEN|_PASSWORD|_SECRET)$/i.test(k) && !/^HANNAH_AGENT_/.test(k)));
  const p = pty.spawn(shell, args, {
    name: 'xterm-color', cols: 100, rows: 30, cwd: os.homedir(), env,
  });
  const s = { pty: p, subs: new Set(), lastData: Date.now() };
  p.onData((d) => {
    s.lastData = Date.now();
    for (const send of s.subs) { try { send({ type: 'terminal_out', data: d }); } catch { /* noop */ } }
  });
  p.onExit(() => sessions.delete(sessionId));
  sessions.set(sessionId, s);
  logger.info('pty creada', { sessionId });
  return s;
}

const ensure = (sessionId) => sessions.get(sessionId) || create(sessionId);

// Panel: suscribir/desuscribir el stream de salida.
export function attach(sessionId, send) {
  const s = ensure(sessionId);
  s.subs.add(send);
  return () => s.subs.delete(send);
}
export function input(sessionId, data) { sessions.get(sessionId)?.pty.write(data); }
export function resize(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
  if (s && cols > 0 && rows > 0) { try { s.pty.resize(cols, rows); } catch { /* noop */ } }
}
export function dispose(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { try { s.pty.kill(); } catch { /* noop */ } sessions.delete(sessionId); }
}

// Ejecuta un comando y devuelve su salida (para el LLM). También se ve en el panel en vivo.
export async function runCommand(sessionId, command) {
  const s = ensure(sessionId);
  let captured = '';
  const sub = s.pty.onData((d) => { captured += d; });
  s.pty.write(command.replace(/\n+$/, '') + '\n');
  await waitIdle(s, 15000, 700);
  sub.dispose();
  /* eslint-disable no-control-regex -- limpiamos secuencias ANSI/OSC del pty: los
     caracteres de control son justamente lo que hay que matchear. */
  const clean = captured
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (títulos / shell-integration, ej. 3008)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')            // CSI (colores/cursor)
    .replace(/\x1b[=>PX^_].*?(?:\x1b\\|\x07)/g, '')     // DCS/PM/APC
    .replace(/\x1b[=>()][0-9A-Za-z]?/g, '')             // modos/charset
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')       // control chars sueltos
    .replace(/\r/g, '')
    .replace(/[^\n]*[$#%>]\s*$/, '')                     // recortar el prompt final (PS1)
    .trim();
  /* eslint-enable no-control-regex */
  // quitar prompt + eco del comando de la primera línea (deja solo la salida real)
  const cmdFirst = command.trim().split('\n')[0];
  const lines = clean.split('\n');
  const i = lines[0]?.indexOf(cmdFirst);
  if (i >= 0) { lines[0] = lines[0].slice(i + cmdFirst.length).trim(); if (!lines[0]) lines.shift(); }
  return lines.join('\n').trim().slice(0, 3000) || '(sin salida)';
}

function waitIdle(s, maxMs, idleMs) {
  const start = Date.now();
  return new Promise((res) => {
    const iv = setInterval(() => {
      const now = Date.now();
      if (now - s.lastData > idleMs || now - start > maxMs) { clearInterval(iv); res(); }
    }, 150);
  });
}

// ── Confirmación de comandos destructivos ─────────────────────────────────
const pending = new Map();   // id -> resolve
export function requestConfirm(timeoutMs = 40000) {
  const id = randomUUID();
  const promise = new Promise((res) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res(false); } }, timeoutMs);
  });
  return { id, promise };
}
export function resolveConfirm(id, approved) {
  const r = pending.get(id);
  if (r) { pending.delete(id); r(!!approved); }
}
