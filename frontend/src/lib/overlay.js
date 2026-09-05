// src/lib/overlay.js
// ¿Corriendo como OVERLAY (compañera flotante) en vez de una pestaña normal?
// - Electron (global inyectado por el preload) o
// - navegador en modo-app con ?overlay=1
// Único punto de verdad (antes estaba duplicado en HUD/useWebSocket/VrmAvatar).
export const isOverlay = typeof window !== 'undefined'
    && (!!window.__HANNAH_DESKTOP__
        || new URLSearchParams(window.location.search).has('overlay'));
