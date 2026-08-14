# hannah-desktop

App de escritorio **Electron** de Hannah: el overlay flotante universal (Windows / macOS
/ Linux). Chromium-based (evita los bugs de webkit del intento Tauri). Carga el frontend
y hace el overlay con APIs cross-platform (always-on-top, mover entre pantallas, mirada
global por el cursor del OS).

```bash
npm install
npm run build     # (en hannah-frontend/) genera el dist que esta app carga
npm start         # correr en dev
npm run build:linux   # .AppImage / .deb
npm run build:win     # .exe
npm run build:mac     # .dmg
```

Necesita el **backend de Hannah** corriendo en `localhost:3001` (ver el README maestro
del proyecto). Ver también `../README.md`.
