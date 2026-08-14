// hannah-desktop/main.js
// Overlay universal (Win/Mac/Linux) con Electron (Chromium). La ventana carga el frontend;
// el OVERLAY (flotar encima, mover entre pantallas, mirada global) se hace aquí con APIs
// cross-platform de Electron — no depende de hyprctl/xdotool. En Linux corre bajo XWayland
// por defecto, donde el always-on-top funciona bien.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const DEV = !!process.env.HANNAH_DEV;   // cargar el Vite dev server
const DEV_URL = 'http://localhost:5173/?overlay=1';
const COMPACT = { w: 400, h: 620 };
let win = null;

// Mini servidor estático para el dist (así las rutas absolutas /avatar.glb, /assets/…
// funcionan igual que en un navegador; file:// las rompería).
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.mjs': 'text/javascript' };
function serveDist(distDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(distDir, p);
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function createWindow() {
  win = new BrowserWindow({
    width: COMPACT.w, height: COMPACT.h,
    frame: false, transparent: true, resizable: true, skipTaskbar: false,
    alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false,   // app local de confianza: permite fetch/WS al backend en :3001 sin CORS
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (DEV) {
    win.loadURL(DEV_URL);
  } else {
    const distDir = app.isPackaged
      ? path.join(process.resourcesPath, 'hannah-frontend', 'dist')
      : path.join(__dirname, '..', 'hannah-frontend', 'dist');
    serveDist(distDir).then((port) => win.loadURL(`http://127.0.0.1:${port}/?overlay=1`));
  }

  // Mirada global: empuja la dirección del cursor (relativa a la ventana) al renderer.
  const gaze = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const K = 1.4, centerX = b.x + b.width / 2, eyeY = b.y + b.height * 0.32;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    win.webContents.send('hannah:gaze', {
      x: clamp((c.x - centerX) / (b.width * K)),
      y: clamp((eyeY - c.y) / (b.height * K)),
    });
  }, 80);
  win.on('closed', () => { clearInterval(gaze); win = null; });
}

// Mover/redimensionar el overlay según un spec (mismo vocabulario que el backend).
function doMove(spec) {
  if (!win) return;
  const s = String(spec || '').toLowerCase();
  const ds = screen.getAllDisplays().map((d) => ({ id: d.id, ...d.bounds }));
  const ordered = [...ds].sort((a, b) => a.x - b.x || a.y - b.y);
  const cur = { id: screen.getDisplayMatching(win.getBounds()).id, ...screen.getDisplayMatching(win.getBounds()).bounds };
  const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].find((c) => s.includes(c));

  let t = cur;
  if (!corner) {
    if (/\b(next|other|another|siguiente|otra|otro)\b/.test(s)) {
      const i = ordered.findIndex((m) => m.id === cur.id); t = ordered[(i + 1) % ordered.length];
    } else if (/(screen|monitor|pantalla)\s*(\d)/.test(s)) {
      const n = +s.match(/(screen|monitor|pantalla)\s*(\d)/)[2]; t = ordered[Math.min(ordered.length - 1, n - 1)] || cur;
    } else if (s.includes('left')) t = ordered[0];
    else if (s.includes('right')) t = ordered[ordered.length - 1];
  }
  const wantsFull = /\b(full|fill|whole|toda|completa|maxim|fullscreen)\b/.test(s)
    || (!corner && (t.id !== cur.id || /screen|monitor|pantalla/.test(s)));

  if (wantsFull) {
    win.setBounds({ x: t.x, y: t.y, width: t.width, height: t.height });
  } else {
    const { w, h } = COMPACT, M = 40;
    const map = {
      'top-left': [t.x + M, t.y + M],
      'top-right': [t.x + t.width - w - M, t.y + M],
      'bottom-left': [t.x + M, t.y + t.height - h - M],
      'bottom-right': [t.x + t.width - w - M, t.y + t.height - h - M],
      'center': [Math.round(t.x + (t.width - w) / 2), Math.round(t.y + (t.height - h) / 2)],
    };
    const [x, y] = map[corner || 'top-right'];
    win.setBounds({ x, y, width: w, height: h });
  }
}

ipcMain.handle('hannah:move', (_e, spec) => { doMove(spec); return true; });
ipcMain.handle('hannah:monitors', () => screen.getAllDisplays().map((d, i) => ({ index: i + 1, name: d.label || `screen ${i + 1}` })));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
