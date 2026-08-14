# Atajos de voz — abrir/cerrar apps y páginas

Hannah abre apps y páginas cuando se lo pedís por voz o texto:

- **«abre youtube»**, **«ábreme el navegador»**, **«abre github.com»**
- **«cierra el navegador»**, **«ciérrame youtube»**, **«cierra la terminal»**

Los **atajos** (qué palabra abre qué) son **editables**. No hace falta tocar código.

## Cómo agregar los tuyos

**Opción fácil — desde la app:** abrí el panel **⚙ Ajustes → «Atajos de voz»**, agregá una
fila (clave → destino) y **Guardar**. Aplica al instante, sin reiniciar.

**A mano:** editá `data/shortcuts.json` (se crea solo la primera vez con varios defaults).
Formato:

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

- **`sites`**: `clave hablada → dominio`. Al decir «abre <clave>» se abre esa web en el
  navegador. La clave puede tener espacios («mercado libre»). Sin `http://` hace falta.
- **`apps`**: `clave hablada → clave de app`. El valor **debe existir** en el allowlist del
  backend (`config.tools.appAllowlist` en `src/config.js`: `browser`, `firefox`, `chrome`,
  `terminal`, `code`, `vscode`, `files`). Esto es a propósito: el comando real es fijo, así
  la voz nunca inyecta comandos arbitrarios.

Si querés una app nueva (p.ej. Spotify de escritorio), agregá primero su comando al
allowlist en `src/config.js` y luego mapeá la clave hablada en `apps`.

## Notas

- `data/shortcuts.json` está **gitignored** (es tu copia personal, como `.env`). Los
  defaults viven horneados en `src/state/shortcuts.js`, así que si borrás el archivo se
  regenera.
- **Cerrar** usa el mismo criterio pero por título/clase de ventana; los alias de navegador
  y terminal (para «cierra el navegador») están en `src/pipeline/tools.js` (`CLOSE_ALIAS`).
- Si decís un dominio explícito («abre notion.so») funciona aunque no esté en la lista.
