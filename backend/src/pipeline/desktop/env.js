// src/pipeline/desktop/env.js
// Detección ÚNICA del entorno de escritorio: qué sesión (X11/Wayland), qué escritorio
// (GNOME/KDE/XFCE/Hyprland/…) y qué herramientas hay para controlar ventanas. Lo consumen
// los adaptadores, el diagnóstico y los logs, para no repetir la detección en cada lugar.
//
// CONTEXTO (por qué esto importa): en Wayland NATIVO el protocolo prohíbe por diseño que una
// app controle su z-order o su posición, así que el overlay solo es posible (a) si la ventana
// corre bajo XWayland — entonces valen las herramientas X11 — o (b) por la vía propia del
// compositor (hyprctl, kdotool). GNOME no expone ninguna vía nativa sin extensión.
import { sh } from './sh.js';

let _cache = null;

const hasBin = async (bin) => !!(await sh(`command -v ${bin}`));

/** Info del entorno (cacheada: no cambia mientras corre el proceso). */
export async function detectEnv() {
  if (_cache) return _cache;

  const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();   // x11 | wayland | tty
  const desktopRaw = process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '';
  const d = desktopRaw.toLowerCase();

  const desktop = d.includes('hyprland') ? 'hyprland'
    : (d.includes('kde') || d.includes('plasma')) ? 'kde'
      : d.includes('gnome') ? 'gnome'
        : d.includes('xfce') ? 'xfce'
          : d.includes('cinnamon') ? 'cinnamon'
            : d.includes('mate') ? 'mate'
              : d.includes('sway') ? 'sway'
                : (d || 'desconocido');

  const [xdotool, wmctrl, kdotool, hyprctl, gdbus, swaymsg] = await Promise.all(
    ['xdotool', 'wmctrl', 'kdotool', 'hyprctl', 'gdbus', 'swaymsg'].map(hasBin));

  _cache = {
    sessionType: sessionType || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'),
    desktop,
    desktopRaw,
    // Hay servidor X (nativo o XWayland) al que se le pueden mandar comandos X11.
    hasX: !!process.env.DISPLAY,
    isWayland: !!process.env.WAYLAND_DISPLAY || sessionType === 'wayland',
    tools: { xdotool, wmctrl, kdotool, hyprctl, gdbus, swaymsg },
  };
  return _cache;
}

/**
 * Veredicto legible para el usuario: ¿va a poder flotar el overlay acá, y por qué vía?
 * Lo usa `hannah doctor` y se loguea al arrancar. Devuelve { level, via, detail, tips[] }.
 *   level: 'full'  -> flota y se puede mover
 *          'basic' -> flota (vía X11) pero conviene instalar algo
 *          'none'  -> se degrada a ventana normal, con el motivo
 */
export async function overlayReport() {
  const e = await detectEnv();
  const t = e.tools;
  const tips = [];

  if (e.desktop === 'hyprland' && t.hyprctl) {
    return { level: 'full', via: 'hyprctl', detail: 'Hyprland: flotar + fijar encima nativo.', tips };
  }
  if (e.desktop === 'sway' && t.swaymsg) {
    return { level: 'full', via: 'swaymsg', detail: 'Sway: floating + sticky por IPC.', tips };
  }
  if (e.desktop === 'kde' && t.kdotool) {
    return { level: 'full', via: 'kdotool', detail: 'KDE Plasma: always-on-top vía KWin.', tips };
  }
  if (e.hasX && (t.wmctrl || t.xdotool)) {
    const via = t.wmctrl ? 'wmctrl' : 'xdotool';
    if (!t.wmctrl) tips.push('Instalá `wmctrl` para el always-on-top más confiable.');
    return {
      level: 'full',
      via,
      detail: e.isWayland
        ? `Sesión Wayland (${e.desktop}): la ventana corre bajo XWayland y se controla con ${via}.`
        : `Sesión X11 (${e.desktop}): control de ventanas estándar con ${via}.`,
      tips,
    };
  }

  // Sin herramientas: la app Electron igual flota sola (usa XWayland), pero el backend no
  // podrá moverla por voz.
  if (e.hasX) {
    tips.push('Instalá `wmctrl` (o `xdotool`) para poder mover/fijar la ventana por voz.');
    if (e.desktop === 'kde') tips.push('En KDE, `kdotool` es la opción más robusta.');
    return {
      level: 'basic',
      via: 'electron',
      detail: 'Hay servidor X (XWayland): la app de escritorio flota por sí sola, pero faltan herramientas para moverla.',
      tips,
    };
  }

  tips.push('Usá la app de escritorio (hannah-desktop): fuerza XWayland y flota sin herramientas extra.');
  if (e.desktop === 'gnome') {
    tips.push('GNOME en Wayland nativo no permite always-on-top a las apps (es decisión de diseño de GNOME).');
  }
  return {
    level: 'none',
    via: null,
    detail: `Wayland nativo sin vía de control (${e.desktop}): la ventana no puede fijarse encima.`,
    tips,
  };
}
