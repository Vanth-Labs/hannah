# Skills — teaching Hannah new capabilities

A **skill** is a capability Hannah can use (run a command, open a website,
search). It follows the **Claude Code style**: a `SKILL.md` file that describes the ability. It is
**model-agnostic** — it works with any LLM (local or through an API): the model reads the skills
index and decides which one to use; **the backend runs it** (the model never invents the command).

## Where they live

- Factory defaults: `hannah-backend/skills/<name>/SKILL.md` (bundled with the repo).
- Yours: `hannah-backend/data/skills/<name>/SKILL.md` (gitignored, private). One of yours
  with the same name **overrides** the bundled one.

## How to add one

**From the app:** ⚙ Settings → **Skills** section → «+ nueva skill», edit the `SKILL.md` and
hit Save. It takes effect without a restart.

**By hand:** create `data/skills/my-skill/SKILL.md`.

## Format

```markdown
---
name: ping
description: Check whether a host responds
run: ping -c 3 {arg}          # ONE action: run | open | search
phrases: ["hacé ping a", "ping a"]   # optional (see below)
confirm: false                 # optional
---
When to use it, plus an example. The model reads this text to decide.
Example: "hacé ping a google.com" -> arg = google.com
```

- **One** action per skill:
  - `run: <command>` — runs it and captures the output (for commands that finish quickly).
  - `terminal: <command>` — opens the **terminal panel** and types the command; you follow the
    session from there. For **interactive** commands: `ssh`, `python`, `htop`, `top`, `vim`…
    (`run` is useless for these, because they never "finish").
  - `open: <url>` — opens the website in the browser (visible window).
  - `search: <query>` — searches the internet and brings back the results (no browser window).
- **Cross-platform** — any action accepts a per-OS variant; it is picked by
  `process.platform`:
  ```
  run.linux:   free -h
  run.mac:     vm_stat
  run.windows: Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory
  ```
  If you only write `run:` (no suffix), it applies to every platform. On Windows the shell is PowerShell.
- **`{arg}`** (or any `{...}`) is replaced by whatever you said after the phrase, or by the
  input the model passes. If the skill takes no input, leave `{arg}` out.
- **`description`**: one line; it is what the model sees in its skills index.

## Two ways to fire

1. **The model decides** (always): it sees your skills in its prompt and emits
   `[SKILL: name | input]` when one fits. Works with any model, and the better the model, the
   better it works.
2. **Deterministic via `phrases`** (optional, 100% reliable): if the text contains one of the
   `phrases`, the skill runs no matter what, with no dependency on the model. Whatever follows
   the phrase becomes the `{arg}`. Handy for consistent behavior even on small models.

## Both paths coexist (no need to choose)

The deterministic layer runs **first, always**: if what you said matches a `phrase` (or a
backend intent), it runs and that's the end of it — reliable even with the local 7B. If **nothing**
matches, the turn falls through to the model, which can use `[SKILL:]` or `[RUN:]` for anything
not pre-defined. With a better model (Claude/GPT/Groq-70b) that second path gets it right more
often; with a small one, `phrases` are your safety net.

## Command reference (on top of skills)

You don't need a skill for every one-off command: `hannah-backend/reference/*.md`
are **cheat-sheets** (`linux.md`, `git.md`, `red.md`) with "intent → command" and per-OS notes,
injected into the prompt so the model writes the right `[RUN:]`. Adding a command takes **one
line**; yours go in `data/reference/*.md`. Leave skills for what needs its own mechanism
(interactive session, opening a browser, searching) or for anything you want 100% reliable.

## Security

The `run` and `terminal` actions **require `TOOLS_SYSTEM_CONTROL=true`** (off by default; the
same flag as the ⌨ panel). There is no command allowlist: with the flag on, anything runs.
The only safety net is the `DANGER` guard — destructive commands (`rm`, `dd`, `mkfs`, `shutdown`,
`git --force`, …) pop up a confirmation modal before running (best-effort, not a
security barrier; see `tests/unit/danger.test.js`). Even so, since the
`{arg}` comes from the conversation and ends up inside the command, **review the skills you create**
(it is your machine; `TOOLS_SYSTEM_CONTROL` is opt-in). Don't add skills whose command you
wouldn't want run with an arbitrary argument.

## Bundled examples

11 skills ship in `hannah-backend/skills/`, useful as templates:

- **run** (captures the output): `hostname`, `memory`, `diskspace`, `iplocal`, `topproc`
- **terminal** (interactive session in the panel): `ssh`, `python`, `monitor`, `salir`
- **open** (browser): `youtube` · **search** (reads results): `buscar-web`

Format notes: a SKILL.md that declares no action is ignored; the frontmatter is parsed by a
minimal custom reader (`src/state/skills.js`, not full YAML); saving from the panel sanitizes the
name to `[a-z0-9_-]`; and your skills live in `data/`, which is **gitignored** (they never get
pushed to the repo).
