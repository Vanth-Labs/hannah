// src/pipeline/windowControl.js
// Control del overlay de Hannah: mover/redimensionar entre monitores y "mirada global".
// La lógica es AGNÓSTICA del entorno; las operaciones específicas (monitores, cursor,
// ventana, colocar) las hace el ADAPTADOR de escritorio (Hyprland / X11 / …). No-op si
// no hay adaptador (degrada a ventana normal).
import { getMonitors as adGetMonitors, getCursor, findWindow, place } from './desktop/index.js';
import { logger } from '../utils/logger.js';

const MARGIN = 40;
const COMPACT = [400, 620];

// Mirada global: dirección normalizada {x,y} en [-1,1] (x: derecha+, y: arriba+) hacia
// el cursor, aunque esté en otro monitor. null si no hay ventana/cursor.
let _winCache = { at: null, size: null, ts: 0 };
export async function getGaze() {
  const now = Date.now();
  if (now - _winCache.ts > 1500) {
    const w = await findWindow();
    _winCache = w ? { at: w.at, size: w.size, ts: now } : { at: null, size: null, ts: now };
  }
  if (!_winCache.at) return null;
  const cursor = await getCursor();
  if (!cursor) return null;
  const [wx, wy] = _winCache.at;
  const [ww, wh] = _winCache.size;
  const centerX = wx + ww / 2;
  const eyeY = wy + wh * 0.32;          // altura aproximada de los ojos en la ventana
  const K = 1.4;                         // qué tan lejos "satura" la mirada
  const nx = Math.max(-1, Math.min(1, (cursor.x - centerX) / (ww * K)));
  const ny = Math.max(-1, Math.min(1, (eyeY - cursor.y) / (wh * K)));   // arriba+ (pantalla y crece hacia abajo)
  return { x: nx, y: ny };
}

// En qué monitor está la ventana, por su posición REAL en píxeles (la verdad visual).
// Robusto para layouts escalonados con huecos:
// 1) punto-en-rect usando el CENTRO de la ventana (no la esquina, que en fullscreen cae
//    justo en el borde entre dos monitores y se resuelve al equivocado);
// 2) el monitor MÁS CERCANO por distancia de centros (nunca fallback ciego a monitors[0]).
// NOTA: NO usamos el campo `monitor` del compositor: puede quedar desactualizado tras un
// move (visto en Hyprland: ventana ya en HDMI pero monitor seguía reportando DP-3).
function monitorOf(win, monitors) {
  const cx = win.at[0] + win.size[0] / 2;
  const cy = win.at[1] + win.size[1] / 2;
  const inside = monitors.find((m) => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
  if (inside) return inside;
  let best = monitors[0], bestD = Infinity;
  for (const m of monitors) {
    const dx = (m.x + m.width / 2) - cx, dy = (m.y + m.height / 2) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

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

// Detecta un comando de movimiento en lo que dijo el usuario (ES/EN) y devuelve un spec
// canónico para moveWindow(), o null. Determinista -> no depende de que el LLM acierte.
export function parseMoveIntent(text) {
  const s = (text || '').toLowerCase();
  const hasVerb = /\b(mu[eé]vete|mu[eé]vase|vete|ve|ponte|p[oó]nte|colócate|ub[ií]cate|ll[eé]vate|and[aá]te|p[aá]sate|regr[eé]sate|mueve|ponla|hazte|agr[aá]ndate|ach[ií]cate|minim|maxim|move|go|put yourself|move yourself|resize|make yourself|shrink|grow|switch|jump)\b/.test(s);
  const hasScreenNoun = /(pantalla completa|full ?screen|otra pantalla|otro monitor|siguiente pantalla|next screen|other screen|other monitor|switch screen|esquina|corner|widget|centro|center|middle|al medio|en medio|small|tiny)/.test(s);
  if (!hasVerb && !hasScreenNoun) return null;

  if (/(pantalla completa|full ?screen|maxim|toda la pantalla|whole screen|ll[eé]nala|agr[aá]ndate|hazte grande|make yourself big|get big)/.test(s)) {
    return /(otra|otro|siguiente|next|other)/.test(s) ? 'next-screen full' : 'fullscreen';
  }
  if (/(otra pantalla|otro monitor|siguiente pantalla|next screen|other screen|other monitor|switch screen|cambia de pantalla|p[aá]sate de pantalla|de pantalla|move screens)/.test(s)) {
    return 'next-screen full';
  }
  if (/(centro|en medio|al medio|center|middle)/.test(s)) return 'center';

  const vert = /(abajo|inferior|de abajo|bottom|baja)/.test(s) ? 'bottom'
    : (/(arriba|superior|de arriba|top|sube)/.test(s) ? 'top' : '');
  const horz = /(izquierda|izq\b|left)/.test(s) ? 'left'
    : (/(derecha|der\b|right)/.test(s) ? 'right' : '');
  if (vert && horz) return `${vert}-${horz}`;
  if (vert) return `${vert}-right`;
  if (horz && /(pantalla|monitor|lado|screen|side|mu[eé]vete|vete|p[aá]sate|move|go)/.test(s)) return `${horz} screen full`;
  if (horz) return `top-${horz}`;
  if (/(pequeñ|chica|chiquit|widget|esquina|rinc[oó]n|ach[ií]cate|minim|small|tiny|shrink|corner)/.test(s)) return 'top-right';
  return null;
}

// Ejecuta un spec de movimiento. "fullscreen", "next-screen full", "bottom-left",
// "center", "screen 2 full", "left screen full"…
export async function moveWindow(spec = '') {
  const s = String(spec).toLowerCase().trim();
  const win = await findWindow();
  if (!win) return false;                 // sin adaptador/ventana -> no-op
  const monitors = await adGetMonitors();
  if (!monitors?.length) return false;

  const cur = monitorOf(win, monitors);
  const cornerName = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].find((c) => s.includes(c));

  // Cambio de monitor SOLO en specs de pantalla; las esquinas se quedan en el actual.
  // Orden ESPACIAL izquierda->derecha para que "pantalla 1/2/3" y "siguiente" sean intuitivos.
  const ordered = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  let target = cur;
  if (!cornerName) {
    if (/(next|other|another)[\s-]*(screen|monitor|pantalla)/.test(s) || s === 'next' || s === 'next-screen') {
      const i = ordered.indexOf(cur);
      target = ordered[(i + 1) % ordered.length];
    } else {
      const byName = monitors.find((m) => s.includes(m.name.toLowerCase())
        || s.includes(m.name.toLowerCase().replace(/-a?-?\d+$/, '')));
      const mScreen = s.match(/(?:screen|monitor|pantalla)\s*(\d)/);
      if (byName) target = byName;
      else if (mScreen) target = ordered[Math.min(ordered.length - 1, parseInt(mScreen[1], 10) - 1)] || cur;
      else if (s.includes('left')) target = ordered[0];
      else if (s.includes('right')) target = ordered[ordered.length - 1];
    }
  }

  const changedMonitor = target !== cur;
  const wantsFull = /\bfull|fill|whole|entire|toda|completa|maximiza|fullscreen\b/.test(s)
    || (!cornerName && (changedMonitor || /screen|monitor|pantalla/.test(s)));

  if (wantsFull) {
    await place(win, target.x, target.y, target.width, target.height);
    logger.info('window fill', { spec: s, monitor: target.name });
  } else {
    const [x, y] = cornerXY(target, cornerName || 'top-right', COMPACT);
    await place(win, x, y, COMPACT[0], COMPACT[1]);
    logger.info('window corner', { spec: s, monitor: target.name, corner: cornerName || 'top-right' });
  }
  return true;
}
