# hannah-desktop

Hannah's **Electron** app: the floating overlay, and the universal path to making it behave the
same on Windows, macOS and every Linux desktop (GNOME, KDE, XFCE, Cinnamon, Hyprland…).

It loads the frontend and handles what a web page cannot do on its own: **float above
everything**, show up on every workspace, move between monitors, and follow the cursor **even
when it is outside the window**.

```bash
npm install
npm run start:dev     # uses the Vite dev server on :5173 (started by ./hannah)
npm start             # serves the packaged dist; first: (cd ../hannah-frontend && npm run build)
npm run lint
npm run build:linux   # .AppImage / .deb
npm run build:win     # .exe  — requires Windows or Wine
npm run build:mac     # .dmg  — requires macOS
```

It needs the **backend on `localhost:3001`**. Normally you don't start it by hand: `./hannah`
(Super+H) brings up the whole stack and opens this app.

---

## Why XWayland, and why it is not negotiable

**Under native Wayland no application can put itself above the others or move itself.** This is
not a bug, nor an Electron limitation: the protocol forbids it by design. `alwaysOnTop` becomes a
no-op and `setBounds` does nothing. The route used by waybar-style overlays (`wlr-layer-shell`)
is not implemented by Mutter/GNOME and is not spoken by Chromium.

The only common denominator is **X11/EWMH**, and you reach it by running the app under
**XWayland**. There the window is a real X11 window and every compositor honors
`_NET_WM_STATE_ABOVE`. With that, the same code floats everywhere.

That is why the app **forces `--ozone-platform=x11`**. Do not remove it: Electron ≤33 picked
XWayland on its own, but **since Electron 38 the default is native Wayland**, so an upgrade would
silently break the overlay.

> **What is NOT possible** (so nobody wastes time trying): an overlay under *native* Wayland.

## Flags belong in argv, not in `appendSwitch`

By the time `main.js` runs, Chromium **has already forked the zygote and already picked a
platform**. From there, `app.commandLine.appendSwitch(...)` arrives too late and has no effect.
The symptom is misleading:

- Without `--no-sandbox` in argv: the renderer dies with a **FATAL about `/dev/shm` permissions**
  that sends you down the wrong path, because the system's `/dev/shm` is perfectly fine. The real
  problem is that the child process cannot create shared memory **anywhere**.
- Without `--ozone-platform` in argv: `hyprctl clients` reports `xwayland=false`, i.e. native
  Wayland, where the window's size and position are simply ignored.

So the flags live in `scripts/run.js` (which assembles them **per operating system**, to avoid
applying Linux patches on Windows and macOS) and in `build.linux.executableArgs` for packages.

| Flag | Why | Escape hatch |
|---|---|---|
| `--no-sandbox` | Chromium's sandbox needs SUID/namespaces; this is a trusted local app | — |
| `--ozone-platform=x11` | See above | `HANNAH_OZONE=wayland` |
| `--in-process-gpu` | On an RTX 5070 Ti the GPU process kept dying with SIGSEGV and the window never got mapped | `HANNAH_GPU=separate` |

## Geometry comes from the compositor, not from Electron

Under XWayland **the geometry Electron reports is not the compositor's**. Measured on a machine
with three monitors:

- `screen.getCursorScreenPoint()` **hangs** if no window exists yet, and once a window exists it
  **returns garbage** (values glued to the window's origin, with the real cursor 1500px away).
  It also only answers while the pointer is **over the app's own window**: outside it, it freezes.
- `screen.getDisplayNearestPoint()` returns the wrong monitor for points that fall squarely
  inside another one.
- `win.getBounds()` was off by **1080px in y** from what the compositor saw.
- `screen.getPrimaryDisplay()` returned a monitor that did not exist in the layout: the list
  **changes between runs**.

With that data the window opened outside every screen, unreachable with the mouse. So monitors,
cursor and window position are queried from the **compositor** (on Hyprland, through its control
socket: ~0.01ms versus ~2.8ms for spawning `hyprctl`), and the window is placed through it.
Off Hyprland it falls back to Electron's APIs, always validating that the point lands inside a
known monitor.

**The deliberate exception is the gaze**: it is a *relative* direction between cursor and window,
and as long as both values come from the same coordinate space the offset cancels out. Mixing the
two spaces there is exactly what breaks it.

## Placement: float, then place, then verify

Order matters. On a **tiling** WM (Hyprland, sway, i3) the window gets tiled and the requested
size is ignored: you have to ask for floating **first** and **re-apply** the bounds (the
compositor assigns its own geometry *after* answering the command). On stacking WMs (GNOME, KDE,
XFCE) windows already float and only the always-on-top is needed.

At the end it always **verifies** that the window ended up inside some monitor and, if not,
relocates it. That is the safety net: a window off-screen cannot be recovered with the mouse.

Two traps that cost time and are worth not repeating:

- **`hyprctl dispatch` answers `ok` and exits 0 ALWAYS**, whether or not it found the window. Its
  exit code is useless as a success signal: you have to locate the window in `hyprctl clients` and
  dispatch by address.
- **The title is the key** that `wmctrl`/`kdotool`/`hyprctl` use to find the window. It is pinned
  to `Hannah` and the page is prevented from changing it; if the frontend's `<title>` overwrote
  it, the whole reinforcement would stop finding the window and fail silently.

## Window behavior

- **400×620 widget** in the bottom-right corner of the monitor where the cursor is. It remembers
  where you left it (`userData/window-bounds.json`), in compositor coordinates.
- **"Fullscreen" is not persisted**: it is a temporary state requested by voice. If it were saved,
  Hannah would reopen covering an entire monitor, always on top and on every workspace.
- **Single instance**: pressing Super+H again brings the window to the front instead of opening a
  second Hannah (two avatars, two sessions, two microphones fighting each other).
- **Closing the window shuts down the whole stack** when the launcher started it
  (`HANNAH_STOP_ON_EXIT=1`), delegating to `./hannah stop`. Sidecars and loaded models hold VRAM
  for as long as they live: without this, ~14GB stayed taken with nothing using them. Starting the
  app by hand does **not** shut anything down, so it won't take out services you were using.
- **Voice-driven moves**: the backend moves the window with its own adapter and only delegates to
  the app when it couldn't (Windows, macOS, or Linux without `hyprctl`/`wmctrl`). If both moved
  it, a relative command like "go to the other screen" would skip a monitor.

## Environment variables

| Variable | Purpose |
|---|---|
| `HANNAH_DEV=1` | Load the Vite dev server (`:5173`) instead of the packaged `dist` |
| `HANNAH_STOP_ON_EXIT=1` | On window close, shut down the stack. Set by the launcher |
| `HANNAH_OZONE` | Ozone platform (default `x11`) |
| `HANNAH_GPU=separate` | Don't force the in-process GPU |
| `HANNAH_DEBUG=1` | Placement trace: cursor, monitors, requested and actual bounds |

## Packaging

When packaged, the app serves `dist` with its own tiny static server on a random port, **with no
Vite proxy** — which is why the frontend talks to the backend through an absolute URL
(`window.__HANNAH_DESKTOP__.backendBase`, see the frontend's `src/lib/api.js`).

The app is **only the overlay**: it still needs the backend, Ollama and the sidecars running.
Packaging the backend as a service is future work.

See also `../README.md` (workspace map) and `../SETUP.md` (bringing everything up on a new
machine, with the per-desktop matrix and the `./hannah doctor` diagnostic).
