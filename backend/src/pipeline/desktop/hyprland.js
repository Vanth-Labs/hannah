// src/pipeline/desktop/hyprland.js
// Adaptador de ventana para Hyprland (Wayland) vía hyprctl. Implementa la interfaz
// { probe, getMonitors, getCursor, findWindow, place } que consume windowControl.js.
import { exec } from 'child_process';

const sh = (cmd) => new Promise((res) => exec(cmd, { timeout: 3000 }, (e, out) => res(e ? null : out)));
const isHannah = (w) => (w.title || '').startsWith('Hannah') || (w.initialTitle || '').startsWith('Hannah');

async function hypr(json) {
  const out = await sh(`hyprctl ${json} -j`);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

export async function probe() {
  return !!process.env.HYPRLAND_INSTANCE_SIGNATURE && !!(await sh('command -v hyprctl'));
}

export async function getMonitors() {
  const ms = await hypr('monitors');
  return (ms || []).map((m) => ({ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, focused: !!m.focused }));
}

export async function getCursor() {
  const out = await sh('hyprctl cursorpos');
  const m = out && out.match(/(-?\d+)\s*,\s*(-?\d+)/);
  return m ? { x: +m[1], y: +m[2] } : null;
}

export async function findWindow() {
  const clients = await hypr('clients');
  const w = clients?.find(isHannah);
  return w ? { id: w.address, at: w.at, size: w.size, name: w.title } : null;
}

export async function place(win, x, y, w, h) {
  await sh(`hyprctl dispatch setfloating "address:${win.id}"`);
  await sh(`hyprctl dispatch resizewindowpixel "exact ${w} ${h},address:${win.id}"`);
  await sh(`hyprctl dispatch movewindowpixel "exact ${x} ${y},address:${win.id}"`);
  await sh(`hyprctl dispatch pin "address:${win.id}"`);
  return true;
}
