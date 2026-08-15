// hannah-desktop/main.js
// Overlay universal (Win/Mac/Linux) con Electron (Chromium). La ventana carga el frontend;
// el OVERLAY (flotar encima, mover entre pantallas, mirada global) se hace aquí con APIs
// cross-platform de Electron — no depende de hyprctl/xdotool.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');

// El sandbox de Chromium necesita SUID/namespaces; para una app local de confianza se apaga.
// OJO: desde acá NO alcanza. Cuando corre este archivo, Chromium ya bifurcó el zygote, y el
// hijo se queda sin poder crear memoria compartida: muere el renderer con un FATAL sobre
// /dev/shm que despista (el /dev/shm del sistema está perfecto). El flag TIENE que venir en
// argv: va en el script `start` y, para los builds, en linux.executableArgs (package.json).
// Esto queda como red de seguridad para los procesos hijos que se lanzan después.
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
// El título es la LLAVE por la que wmctrl/kdotool/hyprctl/swaymsg encuentran la ventana. Se
// fija acá y se impide que la página lo cambie: si el <title> del frontend lo pisara, todo el
// refuerzo del overlay dejaría de encontrarla (y fallaría en silencio).
const TITLE = 'Hannah';
let win = null;
let desired = null;   // bounds que queremos; los WM tiling los pisan y hay que re-aplicarlos
let settled = false;  // ¿ya terminó la colocación inicial? (antes, los resize son del WM)

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

// Esquina inferior derecha de un monitor.
function cornerOf(d) {
  return {
    width: COMPACT.w, height: COMPACT.h,
    x: d.x + d.width - COMPACT.w - MARGIN,
    y: d.y + d.height - COMPACT.h - MARGIN,
  };
}

// Bounds guardados, si todavía caen dentro de algún monitor conectado (si no, null).
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (!Number.isFinite(b?.x) || !Number.isFinite(b?.y)) return null;
    const visible = screen.getAllDisplays().some((d) =>
      b.x + b.width > d.bounds.x && b.x < d.bounds.x + d.bounds.width
      && b.y + b.height > d.bounds.y && b.y < d.bounds.y + d.bounds.height);
    return visible ? { width: b.width || COMPACT.w, height: b.height || COMPACT.h, x: b.x, y: b.y } : null;
  } catch { return null; }   // primera vez o archivo inválido
}

// Mueve el overlay a la esquina del monitor donde está el cursor.
// SOLO es seguro llamarla con una ventana ya creada (ver la nota en createWindow).
function moveToCursorMonitor() {
  try {
    desired = cornerOf(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds);
    win.setBounds(desired);
  } catch (e) {
    console.error('[hannah] no se pudo ubicar según el cursor:', e.message);
  }
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Refuerzo del overlay por escritorio (best-effort) ──────────────────────────────────
// Son DOS problemas distintos, no uno:
//  1. WM TILING (Hyprland, sway, i3): el compositor TILEA la ventana e IGNORA el tamaño y la
//     posición que pide Electron. Medido acá: pedí 400x620 en (2120,420) y quedó 620x1050 en
//     (0,0). Hay que pedirle al compositor que la haga flotante y RE-APLICAR los bounds
//     después (además, el `pin` de Hyprland solo tiene efecto sobre ventanas flotantes).
//  2. WM stacking (GNOME, KDE, XFCE, Cinnamon…): ahí las ventanas ya flotan; solo hace falta
//     el always-on-top, que Electron pide, reforzado por la vía nativa del entorno.
// Todo es best-effort y silencioso: si la herramienta no está, se pasa a la siguiente.
function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { timeout: 3000 }, (e) => res(!e)));
}
function out(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { timeout: 3000 }, (e, so) => res(e ? null : so)));
}

// `hyprctl dispatch` responde "ok" y sale 0 SIEMPRE, encuentre o no la ventana: su código de
// salida no sirve como señal de éxito. Hay que ubicarla primero y despachar por dirección.
async function hyprAddress() {
  const j = await out('hyprctl', ['clients', '-j']);
  try {
    return JSON.parse(j).find((c) => (c.title || '') === TITLE)?.address || null;
  } catch { return null; }
}

// Devuelve la vía usada, o null si no se pudo (el que llama reintenta y loguea).
async function reinforceOverlay() {
  if (process.platform !== 'linux' || !win || win.isDestroyed()) return null;
  const de = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();

  // 1) Tiling: flotar ANTES, o el tamaño de widget no se respeta.
  if (de.includes('hyprland')) {
    const addr = await hyprAddress();
    if (!addr) return null;                                        // todavía no está mapeada
    await run('hyprctl', ['dispatch', 'setfloating', `address:${addr}`]);
    await run('hyprctl', ['dispatch', 'pin', `address:${addr}`]);  // pin: solo si es flotante
    // Hyprland le asigna SU geometría de flotante, y lo hace después de responder al dispatch:
    // si se re-aplican los bounds enseguida, los pisa igual y la ventana queda del tamaño
    // equivocado. Por eso se espera y se re-aplica (medido: sin esto quedaba 630x1060).
    for (const ms of [150, 400]) {
      await new Promise((r) => setTimeout(r, ms));
      win.setBounds(desired);
    }
    return 'hyprctl (flotante + pin)';
  }
  if (de.includes('sway') || de.includes('i3')) {
    const cli = de.includes('sway') ? 'swaymsg' : 'i3-msg';
    if (await run(cli, [`[title="^${TITLE}$"] floating enable, sticky enable`])) {
      win.setBounds(desired);
      return `${cli} (flotante + sticky)`;
    }
  }

  // 2) Stacking (GNOME, KDE, XFCE, Cinnamon…): ahí ya flotan, solo falta el always-on-top.
  if (de.includes('kde') || de.includes('plasma')) {
    const id = (await out('kdotool', ['search', '--name', `^${TITLE}$`]) || '').trim().split('\n').filter(Boolean).pop();
    if (id && await run('kdotool', ['windowstate', '--add', 'above', id])) return 'kdotool';
  }
  // Genérico X11/XWayland: GNOME, XFCE, Cinnamon, MATE, y KDE/GNOME sobre X11.
  // (wmctrl SÍ sale distinto de 0 cuando no encuentra la ventana, así que acá el código sirve.)
  if (await run('wmctrl', ['-r', TITLE, '-b', 'add,above,sticky,skip_taskbar,skip_pager'])) return 'wmctrl';
  return null;
}

function createWindow() {
  // OJO — NO consultar el cursor acá arriba. `screen.getCursorScreenPoint()` se CUELGA (y
  // vuelca core) mientras no exista ninguna ventana: el proceso queda vivo, sin ventana y sin
  // un solo mensaje de error, o sea "la app no arranca". Medido en Hyprland/XWayland, y pasa
  // igual con ozone x11 y wayland; con una ventana ya creada responde normal.
  // Por eso: se abre en el monitor primario y RECIÉN DESPUÉS se mueve al monitor del cursor.
  const saved = savedBounds();
  const start = saved || cornerOf(screen.getPrimaryDisplay().bounds);
  desired = { ...start };
  win = new BrowserWindow({
    ...start,
    title: TITLE,
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
  win.on('page-title-updated', (e) => e.preventDefault());   // el título es la llave, ver TITLE
  if (!saved) moveToCursorMonitor();   // ya hay ventana: ahora sí se puede preguntar el cursor
  // Recordar dónde la dejó el usuario (posición y tamaño) para el próximo arranque.
  // OJO con `settled`: hasta que el overlay quede colocado, los eventos de resize NO son del
  // usuario sino del WM tileando la ventana. Sin esta guarda se guardaba el tamaño impuesto
  // por el tiling como si fuera el deseado, y el refuerzo lo re-aplicaba: la ventana nunca
  // llegaba a 400x620 (medido: se quedaba en 613x1048, el tamaño del tile).
  const saveSoon = debounce(() => {
    if (!settled) return;
    desired = win.getBounds();
    saveBounds(desired);
  }, 500);
  win.on('moved', saveSoon);
  win.on('resize', saveSoon);
  // Refuerzo por escritorio: si Electron no alcanzara, se pide el always-on-top por la vía
  // nativa del entorno (wmctrl / kdotool / hyprctl). Silencioso si la herramienta no está.
  // Se dispara con lo que ocurra primero: `ready-to-show` normalmente, o un temporizador de
  // respaldo — porque si el frontend no carga (dev server caído, renderer trabado) ese evento
  // NO llega, y sin refuerzo la ventana se queda tileada y del tamaño equivocado.
  // Se reintenta porque la ventana tarda en aparecer para el compositor: al primer intento
  // puede no existir todavía.
  let reinforced = false;
  const reinforceOnce = async () => {
    if (reinforced) return;
    reinforced = true;
    for (let i = 0; i < 6; i++) {
      const via = await reinforceOverlay();
      if (via) { console.log(`[overlay] reforzado con ${via}`); break; }
      await new Promise((r) => setTimeout(r, 500));
      if (i === 5) console.log('[overlay] sin refuerzo externo (Electron/XWayland debería alcanzar)');
    }
    settled = true;   // desde acá, mover/redimensionar SÍ es decisión del usuario: se guarda
  };
  win.once('ready-to-show', () => setTimeout(reinforceOnce, 600));
  setTimeout(reinforceOnce, 2500);

  // Si el frontend no carga, la ventana queda transparente y vacía: es indistinguible de "la
  // app no arrancó". Decir qué pasó y mostrarla igual, así el fallo se ve.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[hannah] no cargó ${url} (${code} ${desc})`);
    if (DEV) console.error('[hannah] ¿está corriendo el frontend? -> cd hannah-frontend && npm run dev');
    if (!win.isVisible()) win.show();
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[hannah] el renderer murió:', d.reason));

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
    // Si el renderer se cayó, `send` tira "Render frame was disposed" 12 veces por segundo y
    // tapa la consola justo cuando hay que leerla. Se comprueba antes y se ignora el resto.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    let c;
    try { c = screen.getCursorScreenPoint(); } catch { return; }   // sin mirada, pero sin morir
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

// Fallar RUIDOSAMENTE: sin esto, un error al crear la ventana dejaba el proceso vivo, sin
// ventana y sin un solo mensaje — el arranque parecía "no hacer nada" y no había por dónde
// agarrarlo. Lo mismo con la carga del frontend: si el dev server no está, hay que decirlo.
app.whenReady().then(createWindow).catch((e) => {
  console.error('[hannah] no se pudo crear la ventana:', e);
  app.quit();
});
process.on('uncaughtException', (e) => console.error('[hannah] excepción no capturada:', e));
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
