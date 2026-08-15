// hannah-desktop/main.js
// Overlay universal (Win/Mac/Linux) con Electron (Chromium). La ventana carga el frontend;
// el OVERLAY (flotar encima, mover entre pantallas, mirada global) se hace aquí con APIs
// cross-platform de Electron — no depende de hyprctl/xdotool.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const net = require('net');

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
// Traza de la colocación (HANNAH_DEBUG=1). Ubicar una ventana acá resultó tener varias capas
// que se pisan (Electron, XWayland y el compositor), y sin verlas es puro adivinar.
const DEBUG = process.env.HANNAH_DEBUG === '1';
const dbg = (...a) => { if (DEBUG) console.error('[dbg]', ...a); };
let win = null;
let desired = null;   // bounds que queremos; los WM tiling los pisan y hay que re-aplicarlos
let settled = false;
let lastGazeLog = 0;  // ¿ya terminó la colocación inicial? (antes, los resize son del WM)

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
// Solo LEE lo guardado. La comprobación de si sigue a la vista la hace targetRect contra los
// monitores del compositor: acá se validaba con la geometría de Electron, que está en otro
// espacio de coordenadas, así que descartaba posiciones buenas y aceptaba malas.
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (!Number.isFinite(b?.x) || !Number.isFinite(b?.y)) return null;
    return { x: b.x, y: b.y, width: b.width || COMPACT.w, height: b.height || COMPACT.h };
  } catch { return null; }   // primera vez o archivo inválido
}

// Rectángulo donde debe quedar el overlay: lo guardado si sigue siendo visible, si no la
// esquina del monitor donde está el cursor, y si nada de eso es fiable, el primer monitor.
// TODO se calcula con la geometría del compositor (ver placeAt).
async function targetRect() {
  const mons = await monitorRects();
  const saved = savedBounds();
  if (saved && mons.some((m) => saved.x < m.x + m.width && saved.x + saved.width > m.x
    && saved.y < m.y + m.height && saved.y + saved.height > m.y)) return saved;
  const pt = await cursorPoint(mons);
  const home = (pt && monitorContaining(pt, mons)) || mons[0];
  dbg('objetivo: cursor', JSON.stringify(pt), 'monitor', JSON.stringify(home));
  return home ? cornerOf(home) : null;
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

// Hyprland expone un socket de control. Preguntar por ahí cuesta ~0.01ms; lanzar el binario
// `hyprctl` cuesta ~2.8ms (medido acá). Con un sondeo cada 150ms para la mirada, esa es la
// diferencia entre un widget que no se nota y uno que quema CPU sin hacer nada.
function hyprSocket() {
  const rt = process.env.XDG_RUNTIME_DIR, sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  return rt && sig ? path.join(rt, 'hypr', sig, '.socket.sock') : null;
}

function hyprAsk(cmd) {
  return new Promise((resolve) => {
    const sp = hyprSocket();
    if (!sp) return resolve(null);
    let data = '';
    const s = net.connect(sp);
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => done(null));
    s.on('connect', () => s.write(cmd));
    s.on('data', (d) => { data += d; });
    s.on('end', () => done(data || null));
    s.on('error', () => done(null));
  });
}

// Consulta a Hyprland: socket si está, y si no el binario (que siempre funciona).
async function hyprQuery(cmd, json = false) {
  return (await hyprAsk(json ? `j/${cmd}` : cmd)) || out('hyprctl', json ? [cmd, '-j'] : [cmd]);
}

// `hyprctl dispatch` responde "ok" y sale 0 SIEMPRE, encuentre o no la ventana: su código de
// salida no sirve como señal de éxito. Hay que ubicarla primero y despachar por dirección.
async function hyprAddress() {
  const j = await hyprQuery('clients', true);
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

// Apaga el stack del proyecto (backend, sidecars, Vite, Ollama) delegando en `./hannah stop`,
// que es quien sabe qué levantó y tiene los candados de seguridad. Solo se hace si nos lanzó
// el launcher (HANNAH_STOP_ON_EXIT=1): si arrancaste la app a mano para probar, cerrarla no
// tiene por qué llevarse servicios que estabas usando.
function stopStack() {
  const script = path.join(__dirname, '..', 'hannah');
  if (!fs.existsSync(script)) return;
  try {
    // detached: sobrevive a nuestra salida y arranca en su propia sesión, así el apagado no
    // se alcanza a sí mismo al matar procesos.
    spawn(script, ['stop'], { detached: true, stdio: 'ignore' }).unref();
    console.log('[hannah] cerrando: apagando servicios del proyecto');
  } catch (e) {
    console.error('[hannah] no se pudo apagar el stack:', e.message);
  }
}

// ── Posición del cursor: la de Electron NO sirve en Linux ──────────────────────────────
// `screen.getCursorScreenPoint()` bajo XWayland se CUELGA si todavía no hay ninguna ventana
// y, con ventana, DEVUELVE BASURA: medido (210,210) y (310,310) —siempre x==y, pegado al
// origen de la ventana recién creada— mientras el cursor real estaba en (1832,948). Con ese
// dato la esquina se calcula sobre el monitor equivocado y la ventana termina donde caiga
// (llegó a abrir en x=-1806, fuera de todas las pantallas).
// Por eso se le pregunta al compositor y SOLO se acepta el valor si cae dentro de un monitor.
async function cursorPoint(mons) {
  if (process.platform === 'linux') {
    const hypr = await hyprQuery('cursorpos');                    // "1832, 948"
    const h = hypr && hypr.match(/(-?\d+)\s*,\s*(-?\d+)/);
    if (h) { const pt = { x: +h[1], y: +h[2] }; if (monitorContaining(pt, mons)) return pt; }
    const xdo = await out('xdotool', ['getmouselocation', '--shell']);
    const mx = xdo && xdo.match(/X=(-?\d+)/), my = xdo && xdo.match(/Y=(-?\d+)/);
    if (mx && my) { const pt = { x: +mx[1], y: +my[1] }; if (monitorContaining(pt, mons)) return pt; }
    // Último recurso: la API de Electron. En X11 NATIVO (GNOME, KDE, XFCE, Cinnamon…) es
    // correcta; bajo XWayland puede mentir, por eso se acepta solo si cae dentro de un
    // monitor. Sin esto, un escritorio sin hyprctl ni xdotool abría siempre en mons[0].
    try {
      const pt = screen.getCursorScreenPoint();
      if (monitorContaining(pt, mons)) return pt;
    } catch { /* la API puede fallar: se sigue sin cursor */ }
    return null;              // nada fiable: el que llama se queda en el primer monitor
  }
  try { return screen.getCursorScreenPoint(); } catch { return null; }
}

// Coloca la ventana por la vía que DE VERDAD manda en este entorno. En Hyprland (XWayland) las
// coordenadas de Electron no coinciden con las del compositor —medido: Electron decía (1480,420)
// y el compositor veía (1437,1500), 1080px de diferencia en y— así que ahí se mueve con
// hyprctl. En el resto, setBounds es lo correcto.
async function placeAt(rect) {
  desired = rect;
  const addr = await hyprAddress();
  if (!addr) { win.setBounds(rect); return; }
  await run('hyprctl', ['dispatch', 'resizewindowpixel', `exact ${rect.width} ${rect.height},address:${addr}`]);
  await run('hyprctl', ['dispatch', 'movewindowpixel', `exact ${rect.x} ${rect.y},address:${addr}`]);
}

// Monitores y rectángulo de la ventana SEGÚN EL COMPOSITOR (que es la verdad), con la vista
// de Electron como respaldo.
// ¿Qué monitor CONTIENE este punto? Se calcula acá a propósito: screen.getDisplayNearestPoint()
// devolvió el monitor equivocado para un punto que caía de lleno dentro de otro (medido: el
// punto (2400,1400), dentro de DP-2, le daba HDMI-A-1, y la ventana se abría en la pantalla
// de al lado).
function monitorContaining(pt, mons) {
  return mons.find((m) => pt.x >= m.x && pt.x < m.x + m.width
    && pt.y >= m.y && pt.y < m.y + m.height) || null;
}

let monsCache = null, monsAt = 0;
async function monitorRects() {
  if (monsCache && Date.now() - monsAt < 10000) return monsCache;   // cambian muy de vez en cuando
  const j = await hyprQuery('monitors', true);
  try {
    // width/height vienen en píxeles del MODO; el layout usa tamaño lógico (dividido por la
    // escala), y con la pantalla rotada se intercambian. Sin esto, en monitores HiDPI o
    // verticales la esquina se calcula fuera de la pantalla.
    const ms = JSON.parse(j).map((m) => {
      const k = m.scale || 1;
      const girado = [1, 3, 5, 7].includes(m.transform);
      return {
        x: m.x, y: m.y,
        width: Math.round((girado ? m.height : m.width) / k),
        height: Math.round((girado ? m.width : m.height) / k),
      };
    });
    if (ms.length) { monsCache = ms; monsAt = Date.now(); return ms; }
  } catch { /* sin hyprland */ }
  return screen.getAllDisplays().map((d) => d.bounds);
}

async function actualRect() {
  const j = await hyprQuery('clients', true);
  try {
    const c = JSON.parse(j).find((w) => (w.title || '') === TITLE);
    if (c) return { x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1] };
  } catch { /* sin hyprland */ }
  return win && !win.isDestroyed() ? win.getBounds() : null;
}

// Red de seguridad: si la ventana quedó fuera de TODAS las pantallas, no hay forma de
// alcanzarla con el mouse. Se comprueba contra el compositor y se reubica.
async function ensureOnScreen() {
  if (!win || win.isDestroyed()) return;
  const rect = await actualRect();
  const mons = await monitorRects();
  if (!rect || !mons.length) return;
  const visible = mons.some((m) => rect.x < m.x + m.width && rect.x + rect.width > m.x
    && rect.y < m.y + m.height && rect.y + rect.height > m.y);
  dbg('compositor ve la ventana en', JSON.stringify(rect), '| electron cree', JSON.stringify(win.getBounds()), '| visible:', visible);
  if (visible) return;
  const pt = await cursorPoint(mons);
  const home = (pt && monitorContaining(pt, mons)) || mons[0];
  const fix = cornerOf(home);
  console.error(`[overlay] la ventana quedó fuera de pantalla (${rect.x},${rect.y}); reubicando en ${fix.x},${fix.y}`);
  await placeAt(fix);
}

function createWindow() {
  // OJO — NO consultar el cursor acá arriba. `screen.getCursorScreenPoint()` se CUELGA (y
  // vuelca core) mientras no exista ninguna ventana: el proceso queda vivo, sin ventana y sin
  // un solo mensaje de error, o sea "la app no arranca". Medido en Hyprland/XWayland, y pasa
  // igual con ozone x11 y wayland; con una ventana ya creada responde normal.
  // Por eso: se abre en el monitor primario y RECIÉN DESPUÉS se mueve al monitor del cursor.
  const saved = savedBounds();
  const start = saved || cornerOf(screen.getPrimaryDisplay().bounds);
  dbg('arranque: guardado =', JSON.stringify(saved), '| inicial =', JSON.stringify(start));
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
  // Recordar dónde la dejó el usuario (posición y tamaño) para el próximo arranque.
  // OJO con `settled`: hasta que el overlay quede colocado, los eventos de resize NO son del
  // usuario sino del WM tileando la ventana. Sin esta guarda se guardaba el tamaño impuesto
  // por el tiling como si fuera el deseado, y el refuerzo lo re-aplicaba: la ventana nunca
  // llegaba a 400x620 (medido: se quedaba en 613x1048, el tamaño del tile).
  const saveSoon = debounce(async () => {
    if (!settled) return;
    const rect = await actualRect();   // la posición del COMPOSITOR: es el espacio real
    if (!rect) return;
    desired = rect;
    // "Pantalla completa" es un estado TEMPORAL (se pide por voz), no dónde vive el widget.
    // Si se guardara, Hannah reabriría tapando un monitor entero, siempre encima y en todos
    // los escritorios. Se recuerda la última geometría de widget, no el llenado.
    const mons = await monitorRects();
    if (mons.some((m) => rect.width >= m.width * 0.9 && rect.height >= m.height * 0.9)) return;
    saveBounds(rect);
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
  // Orden que importa: 1) flotar (si no, un WM tiling ignora el tamaño), 2) recién entonces
  // colocar y 3) comprobar que quedó a la vista.
  let settling = false;
  const settleWindow = async () => {
    if (settling) return;
    settling = true;
    // Los reintentos existen porque la ventana tarda en aparecer para el compositor; fuera de
    // Linux no hay refuerzo posible y esperar 3s solo retrasa la colocación.
    const intentos = process.platform === 'linux' ? 6 : 1;
    let via = null;
    for (let i = 0; i < intentos && !via; i++) {
      via = await reinforceOverlay();
      if (!via && i < intentos - 1) await new Promise((r) => setTimeout(r, 500));
    }
    console.log(via ? `[overlay] reforzado con ${via}`
      : '[overlay] sin refuerzo externo (Electron/XWayland debería alcanzar)');
    const target = await targetRect();
    if (target) {
      await placeAt(target);
      await new Promise((r) => setTimeout(r, 250));   // el compositor aplica su propia geometría
      await placeAt(target);                          // por eso se re-aplica una vez
    }
    await ensureOnScreen();   // nunca dejarla donde el mouse no la alcance
    settled = true;   // desde acá, mover/redimensionar SÍ es decisión del usuario: se guarda
  };
  win.once('ready-to-show', () => setTimeout(settleWindow, 600));
  setTimeout(settleWindow, 2500);

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
  // Mirada GLOBAL: tiene que seguir al cursor aunque esté LEJOS de la ventana. Para eso la API
  // de Electron no alcanza bajo XWayland: solo devuelve una posición válida mientras el puntero
  // está encima de la propia ventana, así que al salir de ella la mirada se congela. (Antes no
  // se notaba porque el overlay en modo navegador ocupaba el monitor entero.)
  // Se le pregunta al compositor y se compara contra `desired`, que está en SU mismo espacio.
  // Fuera de Linux (o sin hyprctl) se cae a la API de Electron, que ahí sí es global.
  let lastCursor = null;
  const cursorPoll = setInterval(() => {
    monitorRects()
      .then((mons) => cursorPoint(mons))
      .then((pt) => { if (pt) lastCursor = pt; })
      .catch(() => {});
  }, 150);

  const gaze = setInterval(() => {
    // Si el renderer se cayó, `send` tira "Render frame was disposed" 12 veces por segundo y
    // tapa la consola justo cuando hay que leerla. Se comprueba antes y se ignora el resto.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    let c = lastCursor, b = desired;
    if (!c || !b) {                        // sin vía por el compositor: la de Electron
      try { c = screen.getCursorScreenPoint(); b = win.getBounds(); } catch { return; }
    }
    const K = 1.4, centerX = b.x + b.width / 2, eyeY = b.y + b.height * 0.32;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    // La escala se toma del MONITOR, no de la ventana. Dividir por los 400px del widget satura
    // la mirada apenas el cursor se aleja un palmo (medido: 1.00 en casi toda la pantalla), y
    // Hannah queda bizca mirando siempre al extremo. Normalizando por el monitor el barrido es
    // suave de una punta a la otra — que es como se sentía cuando el overlay ocupaba todo.
    const m = monsCache && monitorContaining({ x: centerX, y: b.y + b.height / 2 }, monsCache);
    const spanW = (m ? m.width : b.width) * K, spanH = (m ? m.height : b.height) * K;
    const g = {
      x: clamp((c.x - centerX) / spanW),
      y: clamp((eyeY - c.y) / spanH),
    };
    if (DEBUG && Date.now() - lastGazeLog > 700) {
      lastGazeLog = Date.now();
      dbg('mirada: cursor', `${c.x},${c.y}`, 'ventana', `${b.x},${b.y}`, '->', `${g.x.toFixed(2)},${g.y.toFixed(2)}`);
    }
    win.webContents.send('hannah:gaze', g);
  }, 80);
  win.on('closed', () => { clearInterval(gaze); clearInterval(cursorPoll); win = null; });
}

// Mover/redimensionar el overlay según un spec (mismo vocabulario que el backend).
// Toda la geometría sale del COMPOSITOR, igual que la colocación inicial: usar
// screen.getAllDisplays()/getBounds() acá mandaba la ventana al monitor equivocado, o fuera de
// la pantalla, en cuanto XWayland reportaba un layout distinto al real.
async function doMove(spec) {
  if (!win || win.isDestroyed()) return;
  const s = String(spec || '').toLowerCase();
  const mons = await monitorRects();
  if (!mons.length) return;
  const ordered = [...mons].sort((a, b) => a.x - b.x || a.y - b.y);
  const rect = (await actualRect()) || desired || ordered[0];
  const cur = monitorContaining({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, ordered)
    || ordered[0];
  const iCur = ordered.indexOf(cur);
  const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].find((c) => s.includes(c));

  let t = cur;
  if (!corner) {
    if (/\b(next|other|another|siguiente|otra|otro)\b/.test(s)) {
      t = ordered[(iCur + 1) % ordered.length];
    } else if (/(screen|monitor|pantalla)\s*(\d)/.test(s)) {
      const n = +s.match(/(screen|monitor|pantalla)\s*(\d)/)[2];
      t = ordered[Math.min(ordered.length - 1, n - 1)] || cur;
    } else if (s.includes('left')) t = ordered[0];
    else if (s.includes('right')) t = ordered[ordered.length - 1];
  }
  const wantsFull = /\b(full|fill|whole|toda|completa|maxim|fullscreen)\b/.test(s)
    || (!corner && (t !== cur || /screen|monitor|pantalla/.test(s)));

  if (wantsFull) {
    await placeAt({ x: t.x, y: t.y, width: t.width, height: t.height });
    return;
  }
  const { w, h } = COMPACT, M = MARGIN;
  const map = {
    'top-left': [t.x + M, t.y + M],
    'top-right': [t.x + t.width - w - M, t.y + M],
    'bottom-left': [t.x + M, t.y + t.height - h - M],
    'bottom-right': [t.x + t.width - w - M, t.y + t.height - h - M],
    'center': [Math.round(t.x + (t.width - w) / 2), Math.round(t.y + (t.height - h) / 2)],
  };
  const [x, y] = map[corner || 'top-right'];
  await placeAt({ x, y, width: w, height: h });
}

ipcMain.handle('hannah:move', async (_e, spec) => {
  await doMove(spec);
  await ensureOnScreen();   // ni siquiera un movimiento pedido puede dejarla inalcanzable
  return true;
});
ipcMain.handle('hannah:monitors', () => screen.getAllDisplays().map((d, i) => ({ index: i + 1, name: d.label || `screen ${i + 1}` })));

// Instancia única: Super+H se aprieta muchas veces. La segunda vez hay que traer la ventana
// al frente, no abrir una segunda Hannah (dos avatares, dos sesiones, dos micrófonos).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Si la instancia previa quedó viva pero sin ventana, hay que RECREARLA. Si acá se
    // devolvía sin más, Super+H no hacía absolutamente nada y no había forma de saber por qué.
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(true, 'screen-saver');   // por si el WM se lo bajó mientras tanto
    win.focus();
  });

  // Fallar RUIDOSAMENTE: sin esto, un error al crear la ventana dejaba el proceso vivo, sin
  // ventana y sin un solo mensaje — el arranque parecía "no hacer nada" y no había por dónde
  // agarrarlo. Lo mismo con la carga del frontend: si el dev server no está, hay que decirlo.
  app.whenReady().then(createWindow).catch((e) => {
    console.error('[hannah] no se pudo crear la ventana:', e);
    app.quit();
  });

  // Cerrar la ventana = apagar Hannah entera (si nos lanzó el launcher). Va solo en la
  // instancia primaria: una segunda instancia sale enseguida y no debe apagarle nada a la
  // que está corriendo.
  app.on('will-quit', () => {
    if (process.env.HANNAH_STOP_ON_EXIT === '1') stopStack();
  });
}
process.on('uncaughtException', (e) => console.error('[hannah] excepción no capturada:', e));
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

