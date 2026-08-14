// src/pipeline/windowControl.js
// Mueve la ventana overlay de Hannah por el escritorio/monitores (Hyprland vía
// hyprctl). Se dispara con el tag [MOVE:posición] que emite el LLM, o por un
// algoritmo (wander). No-op silencioso si no corre en Hyprland o no hay ventana.
import { exec } from 'child_process';
import { logger } from '../utils/logger.js';

const sh = (cmd) => new Promise((res) => exec(cmd, { timeout: 3000 }, (e, out) => res(e ? null : out)));
const MARGIN = 40;
// La ventana de Hannah: la app Tauri (title "Hannah") o el navegador en modo-app
// (title "Hannah — Zen Browser"/"Hannah - <browser>"). Matcheamos por prefijo.
const isHannah = (w) => (w.title || '').startsWith('Hannah') || (w.initialTitle || '').startsWith('Hannah');

async function hypr(json) {
  const out = await sh(`hyprctl ${json} -j`);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

async function findWindow() {
  const clients = await hypr('clients');
  if (!clients) return null;
  return clients.find(isHannah) || null;
}

// Mirada global: lee el cursor de Hyprland y la geometría de la ventana, y devuelve
// una dirección normalizada {x,y} en [-1,1] (x: derecha+, y: arriba+) para que Hannah
// mire hacia tu cursor AUNQUE esté en otro monitor. null si no hay ventana/cursor.
let _winCache = { at: null, size: null, ts: 0 };
export async function getGaze() {
  const now = Date.now();
  if (now - _winCache.ts > 1500) {
    const w = await findWindow();
    _winCache = w ? { at: w.at, size: w.size, ts: now } : { at: null, size: null, ts: now };
  }
  if (!_winCache.at) return null;
  const out = await sh('hyprctl cursorpos');
  const m = out && out.match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  const cx = +m[1], cy = +m[2];
  const [wx, wy] = _winCache.at;
  const [ww, wh] = _winCache.size;
  const centerX = wx + ww / 2;
  const eyeY = wy + wh * 0.32;           // altura aproximada de los ojos en la ventana
  const K = 1.4;                          // qué tan lejos "satura" la mirada
  const nx = Math.max(-1, Math.min(1, (cx - centerX) / (ww * K)));
  const ny = Math.max(-1, Math.min(1, (eyeY - cy) / (wh * K)));   // arriba+ (pantalla y crece hacia abajo)
  return { x: nx, y: ny };
}

function monitorOf(win, monitors) {
  const [x, y] = win.at;
  return monitors.find((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) || monitors[0];
}

// Coordenadas de una esquina/centro dentro de un monitor para el tamaño dado.
function cornerXY(m, corner, [w, h]) {
  const left = m.x + MARGIN, top = m.y + MARGIN;
  const right = m.x + m.width - w - MARGIN, bottom = m.y + m.height - h - MARGIN;
  switch (corner) {
    case 'top-left': return [left, top];
    case 'top-right': return [right, top];
    case 'bottom-left': return [left, bottom];
    case 'bottom-right': return [right, bottom];
    case 'center': return [Math.round(m.x + (m.width - w) / 2), Math.round(m.y + (m.height - h) / 2)];
    default: return [right, top];
  }
}

// Detecta un comando de movimiento en lo que dijo el usuario (ES/EN) y devuelve un
// spec canónico para moveWindow(), o null. Determinista -> no depende de que el LLM
// acierte el [MOVE:]. Ejemplos: "ponte en pantalla completa", "vete a la esquina de
// abajo a la izquierda", "pásate a la otra pantalla", "hazte pequeña", "ve al centro".
export function parseMoveIntent(text) {
  const s = (text || '').toLowerCase();
  // ¿hay intención de mover/redimensionar la ventana?
  const hasVerb = /\b(mu[eé]vete|mu[eé]vase|vete|ve|ponte|p[oó]nte|colócate|ub[ií]cate|ll[eé]vate|and[aá]te|p[aá]sate|regr[eé]sate|mueve|ponla|hazte|agr[aá]ndate|ach[ií]cate|minim|maxim|move|go|put yourself|resize)\b/.test(s);
  const hasScreenNoun = /(pantalla completa|full ?screen|otra pantalla|otro monitor|siguiente pantalla|next screen|esquina|corner|widget|centro|al medio|en medio)/.test(s);
  if (!hasVerb && !hasScreenNoun) return null;

  // pantalla completa / llenar
  if (/(pantalla completa|full ?screen|maxim|toda la pantalla|ll[eé]nala|agr[aá]ndate|hazte grande)/.test(s)) {
    return /(otra|otro|siguiente|next)/.test(s) ? 'next-screen full' : 'fullscreen';
  }
  // cambiar de pantalla/monitor
  if (/(otra pantalla|otro monitor|siguiente pantalla|next screen|cambia de pantalla|p[aá]sate de pantalla|de pantalla)/.test(s)) {
    return 'next-screen full';
  }
  // centro
  if (/(centro|en medio|al medio|center)/.test(s)) return 'center';

  // esquinas (widget) por dirección
  const vert = /(abajo|inferior|de abajo|bottom|baja)/.test(s) ? 'bottom'
    : (/(arriba|superior|de arriba|top|sube)/.test(s) ? 'top' : '');
  const horz = /(izquierda|izq\b|left)/.test(s) ? 'left'
    : (/(derecha|der\b|right)/.test(s) ? 'right' : '');
  if (vert && horz) return `${vert}-${horz}`;
  if (vert) return `${vert}-right`;
  // solo lado -> esa pantalla (con varios monitores, "a la izquierda" = monitor izquierdo)
  if (horz && /(pantalla|monitor|lado|mu[eé]vete|vete|p[aá]sate)/.test(s)) return `${horz} screen full`;
  if (horz) return `top-${horz}`;
  // pequeña/widget/esquina sin dirección -> esquina por defecto
  if (/(pequeñ|chica|chiquit|widget|esquina|rinc[oó]n|ach[ií]cate|minim)/.test(s)) return 'top-right';
  return null;
}

// Interpreta el spec del tag [MOVE:spec] y mueve la ventana. Ejemplos de spec:
// "top-right", "bottom-left", "center", "next-screen", "screen 2", "left-monitor".
export async function moveWindow(spec = '') {
  const s = String(spec).toLowerCase().trim();
  const win = await findWindow();
  if (!win) return false;                 // no Tauri/Hyprland -> no-op
  const monitors = await hypr('monitors');
  if (!monitors?.length) return false;

  const cur = monitorOf(win, monitors);
  const size = win.size || [360, 560];

  // ¿cambio de monitor?
  let target = cur;
  if (/(next|other|another)[\s-]*(screen|monitor|pantalla)/.test(s) || s === 'next' || s === 'next-screen') {
    const i = monitors.indexOf(cur);
    target = monitors[(i + 1) % monitors.length];
  } else {
    const byName = monitors.find((m) => s.includes(m.name.toLowerCase()));
    if (byName) target = byName;
    else {
      const mScreen = s.match(/(?:screen|monitor|pantalla)\s*(\d)/);
      if (mScreen) target = monitors[Math.min(monitors.length - 1, parseInt(mScreen[1], 10) - 1)] || cur;
      else if (s.includes('left')) target = monitors.reduce((a, b) => (b.x < a.x ? b : a), monitors[0]);
      else if (s.includes('right') && s.includes('screen')) target = monitors.reduce((a, b) => (b.x > a.x ? b : a), monitors[0]);
    }
  }

  const cornerName = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].find((c) => s.includes(c));
  const changedMonitor = target !== cur;
  const wantsFull = /\bfull|fill|whole|entire|toda|completa|maximiza|fullscreen\b/.test(s)
    || (!cornerName && (changedMonitor || /screen|monitor|pantalla/.test(s)));

  if (wantsFull) {
    // Llenar el monitor destino (compañera a pantalla completa en esa pantalla).
    await sh(`hyprctl dispatch resizewindowpixel "exact ${target.width} ${target.height},address:${win.address}"`);
    await sh(`hyprctl dispatch movewindowpixel "exact ${target.x} ${target.y},address:${win.address}"`);
    logger.info('window fill', { spec: s, monitor: target.name });
  } else {
    // Encoger a widget en la esquina pedida (por defecto top-right).
    const COMPACT = [400, 620];
    await sh(`hyprctl dispatch resizewindowpixel "exact ${COMPACT[0]} ${COMPACT[1]},address:${win.address}"`);
    const [x, y] = cornerXY(target, cornerName || 'top-right', COMPACT);
    await sh(`hyprctl dispatch movewindowpixel "exact ${x} ${y},address:${win.address}"`);
    logger.info('window corner', { spec: s, monitor: target.name, corner: cornerName || 'top-right' });
  }
  return true;
}
