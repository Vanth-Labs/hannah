// src/pipeline/desktop/hyprland.js
// Adaptador de ventana para Hyprland (Wayland) vía hyprctl. Implementa la interfaz
// { probe, getMonitors, getCursor, findWindow, place } que consume windowControl.js.
import { sh } from './sh.js';

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
  return (ms || []).map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, focused: !!m.focused }));
}

export async function getCursor() {
  const out = await sh('hyprctl cursorpos');
  const m = out && out.match(/(-?\d+)\s*,\s*(-?\d+)/);
  return m ? { x: +m[1], y: +m[2] } : null;
}

export async function findWindow() {
  const clients = await hypr('clients');
  const w = clients?.find(isHannah);
  return w ? { id: w.address, at: w.at, size: w.size, name: w.title, monitor: w.monitor } : null;
}

// Cierra las ventanas cuyo título/clase incluya alguno de los términos. Nunca cierra a
// Hannah. Devuelve cuántas cerró.
export async function close(queries) {
  const clients = await hypr('clients');
  if (!clients) return 0;
  let n = 0;
  for (const w of clients) {
    if ((w.title || '').startsWith('Hannah')) continue;
    const hay = `${w.title || ''} ${w.class || ''} ${w.initialClass || ''} ${w.initialTitle || ''}`.toLowerCase();
    if (queries.some((q) => q && hay.includes(q))) { await sh(`hyprctl dispatch closewindow "address:${w.address}"`); n++; }
  }
  return n;
}

export async function place(win, x, y, w, h) {
  await sh(`hyprctl dispatch setfloating "address:${win.id}"`);
  // The window must BELONG to the target monitor: movewindowpixel only draws it there, and
  // Hyprland routes clicks by the workspaces of the monitor under the cursor, so on another
  // screen it was visible but clicks fell through to whatever was behind.
  const cx = x + w / 2, cy = y + h / 2;
  const target = (await hypr('monitors'))?.find((m) => cx >= m.x && cx < m.x + m.width / (m.scale || 1) && cy >= m.y && cy < m.y + m.height / (m.scale || 1));
  if (target?.activeWorkspace?.id != null) await sh(`hyprctl dispatch movetoworkspacesilent "${target.activeWorkspace.id},address:${win.id}"`);
  await sh(`hyprctl dispatch resizewindowpixel "exact ${w} ${h},address:${win.id}"`);
  await sh(`hyprctl dispatch movewindowpixel "exact ${x} ${y},address:${win.id}"`);
  await sh(`hyprctl dispatch pin "address:${win.id}"`);
  return true;
}
