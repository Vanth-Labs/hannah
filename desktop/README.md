# hannah-desktop

App de escritorio **Electron** de Hannah: el overlay flotante universal (Windows / macOS
/ Linux). Chromium-based (se eligió sobre webkit por sus bugs con NVIDIA/Wayland). Carga el frontend
y hace el overlay con APIs cross-platform (always-on-top, mover entre pantallas, mirada
global por el cursor del OS).

```bash
npm install
# antes de cualquier build/start: generar el dist que esta app empaqueta
(cd ../hannah-frontend && npm install --legacy-peer-deps && npm run build)
npm start             # correr en dev
npm run lint
npm run build:linux   # .AppImage / .deb
npm run build:win     # .exe  — requiere Windows o Wine
npm run build:mac     # .dmg  — requiere macOS
```

En modo empaquetado la app sirve el `dist` con un mini servidor estático propio (puerto
aleatorio), **sin proxy de Vite**: por eso el frontend habla con el backend por URL absoluta
(`window.__HANNAH_DESKTOP__.backendBase`, ver `src/lib/api.js`).

Necesita el **backend de Hannah** corriendo en `localhost:3001` (ver el README maestro
del proyecto). Ver también `../README.md`.
