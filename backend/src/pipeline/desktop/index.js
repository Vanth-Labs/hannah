// src/pipeline/desktop/index.js
// Selección de adaptador de ventana según el entorno (una sola vez, cacheado). Expone la
// interfaz unificada que usa windowControl.js. Si ningún adaptador aplica (p.ej. Wayland
// nativo sin herramientas), todo es no-op y el overlay degrada a ventana normal.
//
// Orden: la vía NATIVA del compositor primero (más fiable), y X11/XWayland como denominador
// común — sirve para GNOME, XFCE, Cinnamon, MATE, i3 y para cualquier sesión Wayland cuya
// ventana corra bajo XWayland (que es como arranca la app de escritorio, a propósito).
import * as hyprland from './hyprland.js';
import * as kde from './kde.js';
import * as x11 from './x11.js';
import { overlayReport } from './env.js';
import { logger } from '../../utils/logger.js';

const CHAIN = [['hyprland', hyprland], ['kde', kde], ['x11', x11]];

let _active;   // undefined = sin detectar; null = ninguno
async function adapter() {
  if (_active !== undefined) return _active;
  _active = null;
  for (const [name, mod] of CHAIN) {
    if (await mod.probe()) { _active = mod; logger.info('desktop adapter', { adapter: name }); break; }
  }
  // Veredicto legible: qué va a poder hacer el overlay en este entorno (y qué falta).
  const r = await overlayReport();
  logger[r.level === 'none' ? 'warn' : 'info']('overlay', { level: r.level, via: r.via, detail: r.detail });
  for (const t of r.tips) logger.info(`overlay tip: ${t}`);
  if (!_active) logger.info('desktop adapter: ninguno (overlay degradado a ventana normal)');
  return _active;
}

export async function getMonitors() { return (await adapter())?.getMonitors() ?? []; }
export async function getCursor() { return (await adapter())?.getCursor() ?? null; }
export async function findWindow() { return (await adapter())?.findWindow() ?? null; }
export async function place(win, x, y, w, h) { return (await adapter())?.place(win, x, y, w, h) ?? false; }
export async function closeWindows(queries) { return (await adapter())?.close?.(queries) ?? 0; }
