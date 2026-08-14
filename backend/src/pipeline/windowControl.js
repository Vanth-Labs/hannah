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

// Info de monitores para la UI: cuántos hay y sus nombres, ordenados espacialmente
// (izquierda->derecha). Universal: el frontend muestra el selector de pantalla solo si >1.
export async function getMonitors() {
  const monitors = await hypr('monitors');
  if (!monitors?.length) return { count: 0, list: [] };
  const ordered = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  return { count: ordered.length, list: ordered.map((m, i) => ({ name: m.name, index: i + 1 })) };
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
  const hasVerb = /\b(mu[eé]vete|mu[eé]vase|vete|ve|ponte|p[oó]nte|colócate|ub[ií]cate|ll[eé]vate|and[aá]te|p[aá]sate|regr[eé]sate|mueve|ponla|hazte|agr[aá]ndate|ach[ií]cate|minim|maxim|move|go|put yourself|move yourself|resize|make yourself|shrink|grow|switch|jump)\b/.test(s);
  const hasScreenNoun = /(pantalla completa|full ?screen|otra pantalla|otro monitor|siguiente pantalla|next screen|other screen|other monitor|switch screen|esquina|corner|widget|centro|center|middle|al medio|en medio|small|tiny)/.test(s);
  if (!hasVerb && !hasScreenNoun) return null;

  // pantalla completa / llenar / fullscreen
  if (/(pantalla completa|full ?screen|maxim|toda la pantalla|whole screen|ll[eé]nala|agr[aá]ndate|hazte grande|make yourself big|get big)/.test(s)) {
    return /(otra|otro|siguiente|next|other)/.test(s) ? 'next-screen full' : 'fullscreen';
  }
  // cambiar de pantalla/monitor / switch screen
  if (/(otra pantalla|otro monitor|siguiente pantalla|next screen|other screen|other monitor|switch screen|cambia de pantalla|p[aá]sate de pantalla|de pantalla|move screens)/.test(s)) {
    return 'next-screen full';
  }
  // centro / center
  if (/(centro|en medio|al medio|center|middle)/.test(s)) return 'center';

  // esquinas (widget) por dirección
  const vert = /(abajo|inferior|de abajo|bottom|baja)/.test(s) ? 'bottom'
    : (/(arriba|superior|de arriba|top|sube)/.test(s) ? 'top' : '');
  const horz = /(izquierda|izq\b|left)/.test(s) ? 'left'
    : (/(derecha|der\b|right)/.test(s) ? 'right' : '');
  if (vert && horz) return `${vert}-${horz}`;
  if (vert) return `${vert}-right`;
  // solo lado -> esa pantalla (con varios monitores, "a la izquierda" = monitor izquierdo)
  if (horz && /(pantalla|monitor|lado|screen|side|mu[eé]vete|vete|p[aá]sate|move|go)/.test(s)) return `${horz} screen full`;
  if (horz) return `top-${horz}`;
  // pequeña/widget/esquina sin dirección -> esquina por defecto
  if (/(pequeñ|chica|chiquit|widget|esquina|rinc[oó]n|ach[ií]cate|minim|small|tiny|shrink|corner)/.test(s)) return 'top-right';
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

  const cornerName = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].find((c) => s.includes(c));

  // ¿cambio de monitor? SOLO en specs de pantalla. Las esquinas (top-left, bottom-right…)
  // se quedan SIEMPRE en el monitor actual — el "left"/"right" de la esquina NO es el
  // monitor. (Antes "bottom-left" te mandaba al monitor izquierdo, ese era el bug.)
  // Orden ESPACIAL izquierda->derecha (arriba->abajo), para que "pantalla 1/2/3" y
  // "siguiente" sean intuitivos y no dependan del orden arbitrario de hyprctl.
  const ordered = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  let target = cur;
  if (!cornerName) {
    if (/(next|other|another)[\s-]*(screen|monitor|pantalla)/.test(s) || s === 'next' || s === 'next-screen') {
      const i = ordered.indexOf(cur);
      target = ordered[(i + 1) % ordered.length];   // la siguiente hacia la derecha (con vuelta)
    } else {
      const byName = monitors.find((m) => s.includes(m.name.toLowerCase())
        || s.includes(m.name.toLowerCase().replace(/-a?-?\d+$/, '')));   // "hdmi", "dp-2"…
      const mScreen = s.match(/(?:screen|monitor|pantalla)\s*(\d)/);
      if (byName) target = byName;
      else if (mScreen) target = ordered[Math.min(ordered.length - 1, parseInt(mScreen[1], 10) - 1)] || cur;
      else if (s.includes('left')) target = ordered[0];                  // la más a la izquierda
      else if (s.includes('right')) target = ordered[ordered.length - 1]; // la más a la derecha
    }
  }

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
