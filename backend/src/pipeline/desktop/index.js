// src/pipeline/desktop/index.js
// Selección de adaptador de ventana según el entorno (una sola vez, cacheado). Expone
// la interfaz unificada que usa windowControl.js. Si ningún adaptador aplica (p.ej.
// Windows/Mac en modo navegador, o Wayland-GNOME), todo es no-op y el overlay degrada
// a ventana normal.
import * as hyprland from './hyprland.js';
import * as x11 from './x11.js';
import { logger } from '../../utils/logger.js';

let _active;   // undefined = sin detectar; null = ninguno
async function adapter() {
  if (_active !== undefined) return _active;
  if (await hyprland.probe()) { _active = hyprland; logger.info('desktop adapter: hyprland'); }
  else if (await x11.probe()) { _active = x11; logger.info('desktop adapter: x11'); }
  else { _active = null; logger.info('desktop adapter: ninguno (overlay degradado)'); }
  return _active;
}

export async function getMonitors() { return (await adapter())?.getMonitors() ?? []; }
export async function getCursor() { return (await adapter())?.getCursor() ?? null; }
export async function findWindow() { return (await adapter())?.findWindow() ?? null; }
export async function place(win, x, y, w, h) { return (await adapter())?.place(win, x, y, w, h) ?? false; }
export async function closeWindows(queries) { return (await adapter())?.close?.(queries) ?? 0; }
