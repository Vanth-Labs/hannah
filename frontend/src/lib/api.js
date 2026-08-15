// src/lib/api.js
// Única fuente de verdad para hablar con el backend desde el frontend.
// - Navegador (Vite dev): rutas relativas ('') → el proxy de Vite las manda al backend.
// - App Electron: NO hay proxy → hay que usar la URL absoluta que expone el preload
//   (window.__HANNAH_DESKTOP__.backendBase). Todos los fetch deben prefijar API_BASE.
export const DESKTOP = typeof window !== 'undefined' ? window.__HANNAH_DESKTOP__ : null;
export const API_BASE = DESKTOP ? DESKTOP.backendBase : '';
