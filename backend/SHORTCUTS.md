# Voice shortcuts — opening/closing apps and pages

Hannah opens apps and pages when you ask her by voice or text:

- **«abre youtube»**, **«ábreme el navegador»**, **«abre github.com»**
- **«cierra el navegador»**, **«ciérrame youtube»**, **«cierra la terminal»**

The **shortcuts** (which word opens what) are **editable**. No need to touch code.

## How to add your own

**Easy option — from the app:** open the **⚙ Ajustes → «Atajos de voz»** panel, add a
row (key → target) and hit **Guardar**. It applies instantly, no restart.

**By hand:** edit `data/shortcuts.json` (it's created automatically on first run, with several defaults).
Format:

```json
{
  "sites": {
    "youtube": "youtube.com",
    "mi blog": "ejemplo.com/blog"
  },
  "apps": {
    "navegador": "browser",
    "terminal": "terminal",
    "editor": "code"
  }
}
```

- **`sites`**: `spoken key → domain`. Saying «abre <key>» opens that site in the
  browser. The key can contain spaces («mercado libre»). No `http://` needed.
- **`apps`**: `spoken key → app key`. The value **must exist** in the backend's
  allowlist (`config.tools.appAllowlist` in `src/config.js`: `browser`, `firefox`, `chrome`,
  `terminal`, `code`, `vscode`, `files`). This is on purpose: the real command is fixed, so
  voice input can never inject arbitrary commands.

If you want a new app (e.g. the Spotify desktop app), first add its command to the
allowlist in `src/config.js` and then map the spoken key in `apps`.

## Notes

- `data/shortcuts.json` is **gitignored** (it's your personal copy, like `.env`). The
  defaults are baked into `src/state/shortcuts.js`, so deleting the file just regenerates
  it.
- **Closing** works the same way, but matches on window title/class; the browser and
  terminal aliases (for «cierra el navegador») live in `src/pipeline/tools.js`
  (`CLOSE_ALIAS`).
- If you say an explicit domain («abre notion.so») it works even if it isn't in the list.
