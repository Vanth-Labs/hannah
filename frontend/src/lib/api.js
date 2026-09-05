// src/lib/api.js
// Única fuente de verdad para hablar con el backend desde el frontend.
// - Navegador (Vite dev): rutas relativas ('') → el proxy de Vite las manda al backend.
// - App Electron: NO hay proxy → hay que usar la URL absoluta que expone el preload
//   (window.__HANNAH_DESKTOP__.backendBase). Todos los fetch deben prefijar API_BASE.
export const DESKTOP = typeof window !== 'undefined' ? window.__HANNAH_DESKTOP__ : null;
export const API_BASE = DESKTOP ? DESKTOP.backendBase : '';

// Token de la UI: solo hace falta cuando el navegador NO está en la misma máquina que el
// backend (modo `./hannah services`, acceso por LAN). Llega una vez en la URL (?token=…) —
// el launcher la imprime — y se guarda en sessionStorage (por pestaña; no persiste).
// En la app Electron y en el navegador local no hay token y el backend tampoco lo pide.
function readToken() {
    if (typeof window === 'undefined') return '';
    try {
        const fromUrl = new URLSearchParams(window.location.search).get('token');
        if (fromUrl) { sessionStorage.setItem('hannah_ui_token', fromUrl); return fromUrl; }
        return sessionStorage.getItem('hannah_ui_token') || '';
    } catch { return ''; }
}
export const UI_TOKEN = readToken();

/** fetch al backend con el token (si lo hay). Usar SIEMPRE esto en vez de fetch(`${API_BASE}…`). */
export function apiFetch(path, init = {}) {
    const headers = new Headers(init.headers || {});
    if (UI_TOKEN && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${UI_TOKEN}`);
    return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/** Añade ?token= a una URL que va a pedir el navegador sin cabeceras (WebSocket, <video>, …). */
export function withToken(url) {
    if (!UI_TOKEN) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(UI_TOKEN)}`;
}
