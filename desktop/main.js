// hannah-desktop/main.js
// Overlay universal (Win/Mac/Linux) con Electron (Chromium). La ventana carga el frontend;
// el OVERLAY (flotar encima, mover entre pantallas, mirada global) se hace aquí con APIs
// cross-platform de Electron — no depende de hyprctl/xdotool.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');

// El sandbox de Chromium en AppImage necesita SUID; para una app local de confianza
// lo desactivamos así el usuario no tiene que pasar --no-sandbox.
app.commandLine.appendSwitch('no-sandbox');

// ── LINUX: forzar X11/XWayland. Esto es lo que hace que el overlay funcione IGUAL en
// GNOME, KDE, XFCE, Cinnamon, Hyprland… ────────────────────────────────────────────────
// En Wayland NATIVO el protocolo prohíbe por diseño que una app controle su z-order o su
// posición global: `alwaysOnTop` queda en no-op y `setBounds`/`getCursorScreenPoint` no
// funcionan (no se puede mover entre monitores). Bajo XWayland la ventana es X11 real y
// los compositores respetan _NET_WM_STATE_ABOVE, así que todo anda con un solo código.
// OJO: Electron <=33 elegía XWayland solo; desde Electron 38 el default es Wayland nativo,
// o sea que esto DEBE quedar explícito o el overlay se rompe al actualizar.
// Escape para experimentar: HANNAH_OZONE=wayland (se pierde flotar/mover, ver README).
if (process.platform === 'linux') {
  const ozone = process.env.HANNAH_OZONE || 'x11';
  app.commandLine.appendSwitch('ozone-platform', ozone);
  if (!process.env.ELECTRON_OZONE_PLATFORM_HINT) process.env.ELECTRON_OZONE_PLATFORM_HINT = ozone;
}

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

// ── Posición: recordar dónde quedó; si es la primera vez, esquina del monitor del cursor ──
const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');
const MARGIN = 40;   // mismo margen que usa el backend para las esquinas

function saveBounds(b) {
  try { fs.writeFileSync(boundsFile(), JSON.stringify(b)); } catch { /* no es crítico */ }
}

function startBounds() {
  // 1) lo guardado, si todavía cae dentro de algún monitor conectado
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (Number.isFinite(b?.x) && Number.isFinite(b?.y)) {
      const visible = screen.getAllDisplays().some((d) =>
        b.x + b.width > d.bounds.x && b.x < d.bounds.x + d.bounds.width
        && b.y + b.height > d.bounds.y && b.y < d.bounds.y + d.bounds.height);
      if (visible) return { width: b.width || COMPACT.w, height: b.height || COMPACT.h, x: b.x, y: b.y };
    }
  } catch { /* primera vez o archivo inválido */ }
  // 2) esquina inferior derecha del monitor donde está el cursor
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  return {
    width: COMPACT.w, height: COMPACT.h,
    x: d.x + d.width - COMPACT.w - MARGIN,
    y: d.y + d.height - COMPACT.h - MARGIN,
  };
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Refuerzo del overlay por escritorio (best-effort) ──────────────────────────────────
// Electron bajo XWayland suele bastar, pero algunos entornos necesitan que se pida por su
// propia vía. Se intentan en orden y sin ruido: si el binario no existe, se ignora.
function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { timeout: 3000 }, (e) => res(!e)));
}

async function reinforceOverlay() {
  if (process.platform !== 'linux' || !win || win.isDestroyed()) return;
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const title = win.getTitle() || 'Hannah';
  const tries = [];
  if (de.includes('hyprland')) tries.push(['hyprctl', ['dispatch', 'pin', `title:${title}`]]);
  if (de.includes('kde') || de.includes('plasma')) tries.push(['kdotool', ['search', '--name', title, 'windowstate', '--add', 'above']]);
  // Genérico X11/XWayland: sirve en GNOME, XFCE, Cinnamon, MATE, i3, KDE/GNOME sobre X11.
  tries.push(['wmctrl', ['-r', title, '-b', 'add,above,sticky,skip_taskbar,skip_pager']]);
  for (const [cmd, args] of tries) {
    if (await run(cmd, args)) { console.log(`[overlay] reforzado con ${cmd}`); return; }
  }
  console.log('[overlay] sin refuerzo externo (Electron/XWayland debería alcanzar)');
}

function createWindow() {
  const start = startBounds();
  win = new BrowserWindow({
    ...start,
    frame: false, transparent: true, resizable: true,
    skipTaskbar: true,     // es un widget flotante, no una app de la barra de tareas
    hasShadow: false,      // la sombra del WM delata el rectángulo de la ventana
    alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false,   // app local de confianza: permite fetch/WS al backend en :3001 sin CORS
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Recordar dónde la dejó el usuario (posición y tamaño) para el próximo arranque.
  const saveSoon = debounce(() => saveBounds(win.getBounds()), 500);
  win.on('moved', saveSoon);
  win.on('resize', saveSoon);
  // Refuerzo por escritorio: si Electron no alcanzara, se pide el always-on-top por la vía
  // nativa del entorno (wmctrl / kdotool / hyprctl). Silencioso si la herramienta no está.
  win.once('ready-to-show', () => setTimeout(reinforceOverlay, 600));

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
