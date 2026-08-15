# hannah-desktop

App **Electron** de Hannah: el overlay flotante, la vía universal para que se comporte igual en
Windows, macOS y en cualquier escritorio de Linux (GNOME, KDE, XFCE, Cinnamon, Hyprland…).

Carga el frontend y se encarga de lo que una página web no puede hacer sola: **flotar encima de
todo**, aparecer en todos los escritorios, moverse entre monitores y seguir el cursor **aunque
esté fuera de la ventana**.

```bash
npm install
npm run start:dev     # usa el servidor de Vite en :5173 (lo levanta ./hannah)
npm start             # sirve el dist empaquetado; antes: (cd ../hannah-frontend && npm run build)
npm run lint
npm run build:linux   # .AppImage / .deb
npm run build:win     # .exe  — requiere Windows o Wine
npm run build:mac     # .dmg  — requiere macOS
```

Necesita el **backend en `localhost:3001`**. Lo habitual es no arrancarla a mano: `./hannah`
(Super+H) levanta todo el stack y abre esta app.

---

## Por qué XWayland, y por qué no es negociable

**En Wayland nativo ninguna aplicación puede ponerse encima de las demás ni moverse sola.** No es
un bug ni una limitación de Electron: el protocolo lo prohíbe por diseño. `alwaysOnTop` queda en
no-op y `setBounds` no hace nada. La vía de los overlays tipo waybar (`wlr-layer-shell`) no la
implementa Mutter/GNOME ni la habla Chromium.

El único denominador común es **X11/EWMH**, y se alcanza corriendo la app bajo **XWayland**. Ahí
la ventana es X11 real y todos los compositores respetan `_NET_WM_STATE_ABOVE`. Con eso, el mismo
código flota igual en todos lados.

Por eso la app **fuerza `--ozone-platform=x11`**. No quitarlo: Electron ≤33 elegía XWayland solo,
pero **desde Electron 38 el default es Wayland nativo**, así que una actualización rompería el
overlay en silencio.

> **Lo que NO se puede** (para no perder tiempo intentándolo): overlay en Wayland *nativo*.

## Los flags van en argv, no en `appendSwitch`

Cuando corre `main.js`, Chromium **ya bifurcó el zygote y ya eligió plataforma**. Desde ahí,
`app.commandLine.appendSwitch(...)` llega tarde y no surte efecto. El síntoma es engañoso:

- Sin `--no-sandbox` en argv: el renderer muere con un **FATAL sobre permisos de `/dev/shm`**
  que despista mucho, porque el `/dev/shm` del sistema está perfecto. El problema real es que el
  proceso hijo no puede crear memoria compartida **en ningún lado**.
- Sin `--ozone-platform` en argv: `hyprctl clients` reporta `xwayland=false`, o sea Wayland
  nativo, donde el tamaño y la posición de la ventana simplemente se ignoran.

Por eso los flags viven en `scripts/run.js` (que los arma **según el sistema operativo**, para no
aplicar parches de Linux en Windows y macOS) y en `build.linux.executableArgs` para los paquetes.

| Flag | Por qué | Escape |
|---|---|---|
| `--no-sandbox` | El sandbox de Chromium necesita SUID/namespaces; es una app local de confianza | — |
| `--ozone-platform=x11` | Ver arriba | `HANNAH_OZONE=wayland` |
| `--in-process-gpu` | En una RTX 5070 Ti el proceso GPU moría por SIGSEGV en bucle y la ventana no llegaba a mapearse | `HANNAH_GPU=separate` |

## La geometría sale del compositor, no de Electron

Bajo XWayland **la geometría que reporta Electron no es la del compositor**. Medido en una máquina
con tres monitores:

- `screen.getCursorScreenPoint()` **se cuelga** si todavía no existe ninguna ventana, y con
  ventana **devuelve basura** (valores pegados al origen de la ventana, con el cursor real a
  1500px de distancia). Además solo responde mientras el puntero está **encima de la propia
  ventana**: fuera de ella se congela.
- `screen.getDisplayNearestPoint()` devuelve el monitor equivocado para puntos que caen de lleno
  dentro de otro.
- `win.getBounds()` llegó a diferir **1080px en y** de lo que veía el compositor.
- `screen.getPrimaryDisplay()` devolvió un monitor que no existía en el layout: la lista **cambia
  entre arranques**.

Con esos datos la ventana abría fuera de todas las pantallas, inalcanzable con el mouse. Así que
monitores, cursor y posición se consultan al **compositor** (en Hyprland, por su socket de
control: ~0.01ms contra ~2.8ms de lanzar `hyprctl`), y la ventana se coloca por ahí. Fuera de
Hyprland se cae a las APIs de Electron, validando siempre que el punto caiga dentro de un monitor
conocido.

**La excepción deliberada es la mirada**: es una dirección *relativa* entre cursor y ventana, y
mientras ambos valores salgan del mismo espacio de coordenadas el desfase se cancela. Mezclar los
dos espacios ahí es justo lo que la rompe.

## Colocación: flotar, después colocar, después verificar

El orden importa. En un WM **tiling** (Hyprland, sway, i3) la ventana se tilea y el tamaño pedido
se ignora: hay que pedir que flote **primero** y **re-aplicar** los bounds (el compositor asigna
su propia geometría *después* de responder al comando). En los WM stacking (GNOME, KDE, XFCE) las
ventanas ya flotan y solo hace falta el always-on-top.

Al final siempre se **verifica** que la ventana quedó dentro de algún monitor y, si no, se
reubica. Es la red de seguridad: una ventana fuera de pantalla no se puede recuperar con el mouse.

Dos trampas que costaron tiempo y conviene no repetir:

- **`hyprctl dispatch` responde `ok` y sale 0 SIEMPRE**, encuentre o no la ventana. Su código de
  salida no sirve como señal de éxito: hay que ubicar la ventana en `hyprctl clients` y despachar
  por dirección.
- **El título es la llave** con la que `wmctrl`/`kdotool`/`hyprctl` encuentran la ventana. Se fija
  a `Hannah` y se impide que la página lo cambie; si el `<title>` del frontend lo pisara, todo el
  refuerzo dejaría de encontrarla y fallaría en silencio.

## Comportamiento de la ventana

- **Widget de 400×620** en la esquina inferior derecha del monitor donde está el cursor. Recuerda
  dónde la dejaste (`userData/window-bounds.json`), en coordenadas del compositor.
- **No se persiste "pantalla completa"**: es un estado temporal que se pide por voz. Si se
  guardara, Hannah reabriría tapando un monitor entero, siempre encima y en todos los escritorios.
- **Instancia única**: apretar Super+H otra vez trae la ventana al frente en vez de abrir una
  segunda Hannah (dos avatares, dos sesiones, dos micrófonos peleando).
- **Cerrar la ventana apaga todo el stack** cuando la lanzó el launcher (`HANNAH_STOP_ON_EXIT=1`),
  delegando en `./hannah stop`. Los sidecars y los modelos retienen VRAM mientras viven: sin esto
  quedaban ~14GB tomados sin nada usándolos. Arrancarla a mano **no** apaga nada, para no llevarse
  puestos servicios que estabas usando.
- **Movimiento por voz**: el backend mueve la ventana con su propio adaptador y solo delega en la
  app si no pudo (Windows, macOS, o Linux sin `hyprctl`/`wmctrl`). Si movieran los dos, un comando
  relativo como "andá a la otra pantalla" saltearía un monitor.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `HANNAH_DEV=1` | Cargar el servidor de Vite (`:5173`) en vez del `dist` empaquetado |
| `HANNAH_STOP_ON_EXIT=1` | Al cerrar la ventana, apagar el stack. Lo pone el launcher |
| `HANNAH_OZONE` | Plataforma de ozone (default `x11`) |
| `HANNAH_GPU=separate` | No forzar el GPU en proceso |
| `HANNAH_DEBUG=1` | Traza de la colocación: cursor, monitores, bounds pedidos y reales |

## Empaquetado

En modo empaquetado la app sirve el `dist` con un mini servidor estático propio en un puerto
aleatorio, **sin proxy de Vite** — por eso el frontend habla con el backend por URL absoluta
(`window.__HANNAH_DESKTOP__.backendBase`, ver `src/lib/api.js` del frontend).

La app es **solo el overlay**: sigue necesitando el backend, Ollama y los sidecars corriendo.
Empaquetar el backend como servicio es trabajo futuro.

Ver también `../README.md` (mapa del workspace) y `../SETUP.md` (levantar todo en una máquina
nueva, con la matriz por escritorio y el diagnóstico `./hannah doctor`).
