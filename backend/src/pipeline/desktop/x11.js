// src/pipeline/desktop/x11.js
// Adaptador de ventana para X11 (Xorg / XWayland) vía xdotool + wmctrl. Cubre la mayoría
// del Linux no-Wayland. Misma interfaz que el adaptador Hyprland.
// NOTA: probado en el layout estándar de xdotool/wmctrl; requiere `xdotool` y `wmctrl`.
import { exec } from 'child_process';

const sh = (cmd) => new Promise((res) => exec(cmd, { timeout: 3000 }, (e, out) => res(e ? null : out)));

export async function probe() {
  return !!process.env.DISPLAY && !!(await sh('command -v xdotool'));
}

// xrandr --listmonitors -> " 0: +*DP-1 2560/597x1440/336+0+0  DP-1"
export async function getMonitors() {
  const out = await sh('xrandr --listmonitors');
  if (!out) return [];
  const mons = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+):\s+\+?(\*)?(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
    if (m) mons.push({ name: m[3], x: +m[6], y: +m[7], width: +m[4], height: +m[5], focused: !!m[2] });
  }
  return mons;
}

export async function getCursor() {
  const out = await sh('xdotool getmouselocation --shell');   // X=.. Y=.. SCREEN=.. WINDOW=..
  const x = out && out.match(/X=(-?\d+)/);
  const y = out && out.match(/Y=(-?\d+)/);
  return x && y ? { x: +x[1], y: +y[1] } : null;
}

export async function findWindow() {
  const ids = await sh("xdotool search --name '^Hannah'");
  const id = ids && ids.trim().split('\n').filter(Boolean).pop();   // la más reciente
  if (!id) return null;
  const geo = await sh(`xdotool getwindowgeometry --shell ${id}`);  // X= Y= WIDTH= HEIGHT=
  const gx = geo && geo.match(/X=(-?\d+)/); const gy = geo && geo.match(/Y=(-?\d+)/);
  const gw = geo && geo.match(/WIDTH=(\d+)/); const gh = geo && geo.match(/HEIGHT=(\d+)/);
  if (!gx || !gw) return null;
  return { id, at: [+gx[1], +gy[1]], size: [+gw[1], +gh[1]], name: 'Hannah' };
}

// Cierra ventanas cuyo título/clase incluya alguno de los términos. Nunca cierra a Hannah.
export async function close(queries) {
  const out = await sh('wmctrl -l -x');   // "id  desk  clase.Clase  host  título"
  if (!out) return 0;
  let n = 0;
  for (const line of out.split('\n')) {
    if (!line.trim() || /\bHannah\b/.test(line)) continue;
    const id = line.split(/\s+/)[0];
    const hay = line.toLowerCase();
    if (queries.some((q) => q && hay.includes(q))) { await sh(`wmctrl -i -c ${id}`); n++; }
  }
  return n;
}

export async function place(win, x, y, w, h) {
  await sh(`xdotool windowsize ${win.id} ${w} ${h}`);
  await sh(`xdotool windowmove ${win.id} ${x} ${y}`);
  // always-on-top + pegar a todos los escritorios (equivalente al pin)
  await sh(`wmctrl -i -r ${win.id} -b add,above,sticky`);
  return true;
}
