// hannah-desktop/preload.js
// Puente seguro renderer<->main. Expone __HANNAH_DESKTOP__ para que el frontend:
// (1) se detecte como overlay (isOverlay), (2) reciba la mirada global del OS, (3) mueva
// la ventana. También necesita hablar con el backend por URL absoluta (no hay proxy Vite).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__HANNAH_DESKTOP__', {
  isDesktop: true,
  backendBase: 'http://localhost:3001',   // el frontend usa esto en vez de rutas relativas
  onGaze: (cb) => ipcRenderer.on('hannah:gaze', (_e, g) => cb(g)),
  moveWindow: (spec) => ipcRenderer.invoke('hannah:move', spec),
  getMonitors: () => ipcRenderer.invoke('hannah:monitors'),
});
