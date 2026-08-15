# Skills — enseñarle capacidades a Hannah

Una **skill** es una capacidad que Hannah puede usar (correr un comando, abrir una web,
buscar). Es **estilo Claude Code**: un archivo `SKILL.md` que describe la habilidad. Es
**model-agnóstico** — funciona con cualquier LLM (local o por API): el modelo lee el índice
de skills y decide cuál usar; **el backend la ejecuta** (el modelo no inventa el comando).

## Dónde viven

- Defaults de fábrica: `hannah-backend/skills/<nombre>/SKILL.md` (vienen en el repo).
- Las tuyas: `hannah-backend/data/skills/<nombre>/SKILL.md` (gitignored, privadas). Una skill
  tuya con el mismo nombre **pisa** a la incluida.

## Cómo agregar una

**Desde la app:** ⚙ Ajustes → sección **Skills** → «+ nueva skill», editás el `SKILL.md` y
Guardás. Aplica sin reiniciar.

**A mano:** creás `data/skills/mi-skill/SKILL.md`.

## Formato

```markdown
---
name: ping
description: Ver si un host responde
run: ping -c 3 {arg}          # UNA acción: run | open | search
phrases: ["hacé ping a", "ping a"]   # opcional (ver abajo)
confirm: false                 # opcional
---
Cuándo usarla y un ejemplo. Este texto lo lee el modelo para decidir.
Ejemplo: "hacé ping a google.com" -> arg = google.com
```

- **Una** acción por skill:
  - `run: <comando>` — lo corre y captura la salida (comando que termina rápido).
  - `terminal: <comando>` — abre el **panel de terminal** y escribe el comando; vos seguís la
    sesión. Para **interactivos**: `ssh`, `python`, `htop`, `top`, `vim`… (con `run` no sirven,
    porque no "terminan").
  - `open: <url>` — abre la web en el navegador (ventana visible).
  - `search: <query>` — busca en internet y te trae resultados (sin abrir navegador).
- **Cross-platform** — cualquier acción acepta variante por sistema operativo; se elige por
  `process.platform`:
  ```
  run.linux:   free -h
  run.mac:     vm_stat
  run.windows: Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory
  ```
  Si ponés solo `run:` (sin sufijo) se usa en todos. En Windows el shell es PowerShell.
- **`{arg}`** (o cualquier `{...}`) se reemplaza por lo que dijiste después de la frase / el
  input que pasa el modelo. Si la skill no lleva input, no pongas `{arg}`.
- **`description`**: una línea; es lo que ve el modelo en su índice de skills.

## Dos formas de dispararse

1. **El modelo decide** (siempre): ve tus skills en su prompt y emite
   `[SKILL: nombre | input]` cuando encaja. Funciona con cualquier modelo; mejor cuanto
   mejor el modelo.
2. **Determinista por `phrases`** (opcional, 100% fiable): si el texto contiene una de las
   `phrases`, la skill se ejecuta sí o sí, sin depender del modelo. Lo que sigue a la frase
   es el `{arg}`. Útil para que ande parejo hasta en modelos chicos.

## Las dos vías conviven (no hay que elegir)

La capa determinista corre **siempre primero**: si lo que dijiste matchea una `phrase` (o un
intent del backend), se ejecuta y listo — fiable hasta con el 7B local. Si **nada** matchea, el
turno sigue al modelo, que puede usar `[SKILL:]` o `[RUN:]` para cosas no pre-definidas. Con un
modelo mejor (Claude/GPT/Groq-70b) esa segunda vía acierta más; con uno chico, las `phrases` son
tu red.

## Referencia de comandos (además de las skills)

Para comandos sueltos no hace falta crear una skill por cada uno: `hannah-backend/reference/*.md`
son **cheat-sheets** (`linux.md`, `git.md`, `red.md`) con "intención → comando" y notas por SO,
que se inyectan en el prompt para que el modelo escriba el `[RUN:]` correcto. Agregás un comando
con **una línea**; las tuyas van en `data/reference/*.md`. Las skills quedan para lo que tiene
mecanismo propio (sesión interactiva, abrir navegador, buscar) o lo que quieras 100% fiable.

## Seguridad

Las acciones `run` y `terminal` **exigen `TOOLS_SYSTEM_CONTROL=true`** (off por defecto; el
mismo flag que el panel ⌨). No hay allowlist de comandos: con el flag activo corre cualquier
cosa. La única red es el guard `DANGER` — los destructivos (`rm`, `dd`, `mkfs`, `shutdown`,
`git --force`, …) piden confirmación en un modal antes de ejecutarse (best-effort, no es una
barrera de seguridad; ver `tests/unit/danger.test.js`). Aun así, como el
`{arg}` viene de la conversación y entra al comando, **revisá qué skills creás** (es tu
máquina; `TOOLS_SYSTEM_CONTROL` es opt-in). No pongas skills con comandos que no quieras que
se ejecuten con un argumento arbitrario.

## Ejemplos incluidos

Vienen 11 skills en `hannah-backend/skills/`, útiles como plantilla:

- **run** (captura la salida): `hostname`, `memory`, `diskspace`, `iplocal`, `topproc`
- **terminal** (sesión interactiva en el panel): `ssh`, `python`, `monitor`, `salir`
- **open** (navegador): `youtube` · **search** (lee resultados): `buscar-web`

Notas del formato: si un SKILL.md no declara ninguna acción, se ignora; el frontmatter lo parsea
un lector propio y mínimo (`src/state/skills.js`, no YAML completo); al guardar desde el panel el
nombre se sanitiza a `[a-z0-9_-]`; y tus skills viven en `data/`, que está **gitignored** (no se
suben al repo).
