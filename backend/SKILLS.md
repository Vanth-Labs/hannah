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
  - `run: <comando>` — lo corre en la terminal real (pty).
  - `open: <url>` — abre la web en el navegador (ventana visible).
  - `search: <query>` — busca en internet y te trae resultados.
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

## Seguridad

La acción `run` pasa por el mismo guard que el resto: comandos destructivos (`rm -rf`, `dd`,
`mkfs`, `sudo rm`, …) piden confirmación en un modal antes de ejecutarse. Aun así, como el
`{arg}` viene de la conversación y entra al comando, **revisá qué skills creás** (es tu
máquina; `TOOLS_SYSTEM_CONTROL` es opt-in). No pongas skills con comandos que no quieras que
se ejecuten con un argumento arbitrario.

## Ejemplos incluidos

`ping` (run), `diskspace` (run), `weather` (run, `wttr.in`), `youtube` (open). Miralos como
plantilla en `hannah-backend/skills/`.
