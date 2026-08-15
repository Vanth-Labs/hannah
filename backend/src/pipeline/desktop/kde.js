// src/pipeline/desktop/kde.js
// Adaptador para KDE Plasma (KWin) vía `kdotool` — un clon de xdotool que habla con KWin por
// D-Bus, así que funciona TAMBIÉN en Plasma Wayland, donde xdotool/wmctrl no ven las ventanas
// nativas. Misma interfaz que los demás adaptadores.
//
// Nota: los ids de kdotool son UUIDs internos de KWin (no ventanas X11), por eso `getMonitors`
// no puede salir de ahí y se usa xrandr (disponible vía XWayland) como fuente de monitores.
import { sh } from './sh.js';

const TITLE = 'Hannah';

export async function probe() {
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (!de.includes('kde') && !de.includes('plasma')) return false;
  return !!(await sh('command -v kdotool'));
}

// Monitores: KWin no los expone por kdotool; xrandr funciona (XWayland) en Plasma.
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

// El cursor global no está expuesto por KWin; si hay XWayland, xdotool lo da.
export async function getCursor() {
  const out = await sh('xdotool getmouselocation --shell');
  const x = out && out.match(/X=(-?\d+)/);
  const y = out && out.match(/Y=(-?\d+)/);
  return x && y ? { x: +x[1], y: +y[1] } : null;
}

export async function findWindow() {
  const ids = await sh(`kdotool search --name '^${TITLE}'`);
  const id = ids && ids.trim().split('\n').filter(Boolean).pop();
  if (!id) return null;
  const geo = await sh(`kdotool getwindowgeometry --shell ${id}`);
  const gx = geo && geo.match(/X=(-?\d+)/); const gy = geo && geo.match(/Y=(-?\d+)/);
  const gw = geo && geo.match(/WIDTH=(\d+)/); const gh = geo && geo.match(/HEIGHT=(\d+)/);
  if (!gx || !gw) return null;
  return { id, at: [+gx[1], +gy[1]], size: [+gw[1], +gh[1]], name: TITLE };
}

export async function place(win, x, y, w, h) {
  await sh(`kdotool windowsize ${win.id} ${w} ${h}`);
  await sh(`kdotool windowmove ${win.id} ${x} ${y}`);
  await sh(`kdotool windowstate --add above ${win.id}`);          // siempre encima
  await sh(`kdotool set_desktop_for_window ${win.id} -1`);        // en todos los escritorios
  return true;
}

// Cierra ventanas cuyo título coincida con alguno de los términos. Nunca cierra a Hannah.
export async function close(queries) {
  let n = 0;
  for (const q of queries.filter(Boolean)) {
    const ids = await sh(`kdotool search --name '${q}'`);
    for (const id of (ids || '').trim().split('\n').filter(Boolean)) {
      const name = await sh(`kdotool getwindowname ${id}`);
      if ((name || '').trim().startsWith(TITLE)) continue;
      await sh(`kdotool windowclose ${id}`);
      n++;
    }
  }
  return n;
}
