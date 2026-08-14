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

## ¿Quién dispara las skills? (frases vs modelo)

En ⚙ Ajustes → Skills hay un toggle **"Dejar que el modelo decida"**:

- **Apagado (default)** — DETERMINISTA: las `phrases` y el parseo del backend disparan. Fiable
  en **cualquier** modelo (hasta el 7B local), pero solo hace lo pre-definido y puede arrastrar
  ruido de la voz.
- **Encendido** — CONFIÁS EN EL MODELO: se apaga la capa determinista; el modelo decide y llena
  los argumentos (más inteligente, y puede hacer cosas **no** pre-definidas usando `[RUN:]`/
  `[SKILL:]`). Requiere un modelo capaz (Claude/GPT/Groq-70b); con el 7B local falla más.

## Seguridad

La acción `run` pasa por el mismo guard que el resto: comandos destructivos (`rm -rf`, `dd`,
`mkfs`, `sudo rm`, …) piden confirmación en un modal antes de ejecutarse. Aun así, como el
`{arg}` viene de la conversación y entra al comando, **revisá qué skills creás** (es tu
máquina; `TOOLS_SYSTEM_CONTROL` es opt-in). No pongas skills con comandos que no quieras que
se ejecuten con un argumento arbitrario.

## Ejemplos incluidos

`ping` (run), `diskspace` (run), `weather` (run, `wttr.in`), `youtube` (open). Miralos como
plantilla en `hannah-backend/skills/`.
