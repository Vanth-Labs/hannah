# hannah-sense — el quinto sidecar (127.0.0.1:8007)

Los ojos de Hannah para la máquina: mantiene *vigilancias* (watches) que muestrean
una señal cada N segundos y avisan cuando algo dejó de estar como estaba. Son los
hitos **M5.1.1** (el esqueleto) y **M5.1.2** (la sonda de capacidades y los
sensores reales) del plan `docs/VIGILANCE.md`; en esta fase solo **observa**.

## La regla que manda sobre todas

> **Este proceso nunca cambia la máquina.**

Regla R1 del plan. Toda acción correctiva es una tarea del agente (`:8006`), que ya
tiene el carril único, la política dura, los tiers de riesgo, la aprobación humana,
la redacción y el audit trail. Poner un segundo ejecutor acá sería un segundo lugar
donde mirar cuando algo pasó, y dos modelos de seguridad que se separan con el tiempo.

Dos consecuencias que se ven en el código:

- **Un sensor es un objeto tipado, nunca un string de comando** (regla R2). Lo que
  entra es `{"kind": "proc", "pattern": "..."}`, y cada clase valida sus campos.
  Aceptar un comando libre convertiría este proceso en una primitiva de lectura que
  se saltea la denylist del agente entera.
- **Nada de lo observado sale de acá** (regla R3). Una muestra devuelve booleanos,
  contadores y offsets: nunca la línea de log que matcheó, ni una ruta, ni un host,
  ni la salida de un comando. Una línea de log es texto que escribió otro, y la fila
  de un watch termina pegada al system prompt de la persona.

## Cómo se corre

```bash
cd backend/sidecar/sense
python3 -m venv --system-site-packages .venv     # venv PROPIO, ver requirements.txt
.venv/bin/pip install -r requirements.txt
```

```bash
cd backend && npm run sidecar:sense               # uvicorn en 127.0.0.1:8007
```

Sin `--reload`, a diferencia de asr/tts/vision: el reload reinicia el proceso ante
cualquier cambio de archivo, y acá reiniciar el proceso desarma todas las vigilancias.

El venv es propio y **no** el compartido de `sidecar/.venv`: ese pinea numpy y
onnxruntime-gpu para faster-whisper, Kokoro y YOLO, y agregarle
`--system-site-packages` (que este necesita para `gi`/`dbus` en P5.5/P5.6) rompería
en silencio los dos servicios sin los cuales el producto no habla ni escucha.

Perillas (plan §13), todas por entorno y leídas en un solo lugar, `config.py`:

| variable | default | qué hace |
| --- | --- | --- |
| `HANNAH_SENSE_TOKEN` | vacío | bearer del control plane. **Vacío = todo 401** menos `/health` |
| `SENSE_MAX_WATCHES` | `2` | watches vivos simultáneos |
| `SENSE_MIN_PERIOD_MS` | `15000` | piso del período de muestreo |
| `SENSE_DEBOUNCE_N` | `3` | muestras no sanas seguidas antes de un trip |
| `SENSE_BLIND_MS` | `120000` | sin muestras buenas por más de esto, el watch se declara ciego |
| `HANNAH_SENSE_STATE_DIR` | `~/.local/share/hannah-sense` | **solo para tests**: mueve el estado fuera de la denylist del agente |
| `HANNAH_AGENT_FIXTURES` | `../../agent/docs/fixtures` | dónde está el asset de rutas denegadas del agente (ver más abajo) |
| `HANNAH_AGENT_DENY_DIRS` | vacío | directorios que esta máquina deniega además de la tabla; el launcher le pasa `backend/data` |

## Las rutas

`/health` es abierta; todo lo demás exige `Authorization: Bearer $HANNAH_SENSE_TOKEN`,
responde **403 a cualquier request que traiga `Origin`**, **415** a un `POST` que no
sea `application/json` y **400** a un cuerpo de más de 256 KiB. Los guardias están
portados de la fachada del agente (`facade/routes.ts`), en el mismo orden.

| ruta | qué devuelve |
| --- | --- |
| `GET /health` | `{healthy, version, watches:{armed,degraded,blind,suspended}}`. Sin ruta de home ni nombre de usuario (AUDIT M22) |
| `GET /v1/capabilities` | `{rungs:[{id,available,reason}], sensors:[kind]}` — la escalera R1..R10 de esta máquina |
| `POST /v1/watches` | `201 {watchId}`. `400` malformado o período bajo el mínimo, `403` ruta denegada, `409` no hay cupo |
| `GET /v1/watches` | una fila por watch: label, estado, escalón, contadores. **Nunca un valor de muestra** |
| `GET /v1/watches/{id}` | la fila, o `404` |
| `DELETE /v1/watches/{id}` | `{disarmed:true}`, o `404` |
| `GET /v1/events` | SSE. `Last-Event-ID` (o `?after=`) reanuda desde el anillo; keep-alive cada 15 s |

Los eventos son siete y no hay otros: `watch.armed`, `watch.tripped`, `watch.blind`,
`watch.recovered`, `watch.expired`, `watch.disarmed`, `watch.faulted`. **No existe
`watch.sample` ni un evento de latido**: "cuatro horas tranquilas" son *nada*
(plan §10), y si querés saber si sigue viva se pregunta `GET /v1/watches` y se mira
`lastSampleAt`. Todo watch que sale del conjunto vivo emite exactamente un
`watch.disarmed` como último evento, precedido por el que dice por qué.

Igual que la fachada, una conexión sin `Last-Event-ID` recibe el anillo entero: el
backend deduplica por `seq`, que es por watch y arranca en 1.

## Estado en disco

`~/.local/share/hannah-sense/watches.json`, carpeta `0700` y archivo `0600`, escrito
con reemplazo atómico. La ruta es literal a propósito: la lleva escrita la denylist
del agente, así que respetar `XDG_DATA_HOME` sacaría el archivo de esa lista.

Al arrancar, lo persistido vuelve como **`suspended`, jamás armado** (asunción A4:
re-armar solo porque el proceso reinició no es consentimiento), y lo que ya venció
mientras el proceso estaba caído no vuelve.

## La escalera y lo que puede esta máquina

`GET /v1/capabilities` no es una lista fija: es lo que **esta** máquina puede
vigilar hoy. `capability.py` resuelve cada herramienta en `PATH` mirando el bit de
ejecución, con la misma forma que `which`/`whichFirst` de
`agent/packages/agent/src/hannah/env.ts`, y un escalón sin su herramienta se
reporta `available: false` con una razón que se puede decir en voz alta. Es la
regla del catálogo de macros: **Hannah no aprende la palabra de una vigilancia
que no puede armar**, así que no la promete.

| escalón | kind | necesita | estado hoy |
| --- | --- | --- | --- |
| **R1** | `proc` | `pgrep` | el proceso está vivo (`pgrep -c -f -- <patrón>`) |
| **R2** | `file` | nada (es un `stat`) | el mtime no avanza hace `stallSeconds` |
| **R3** | `logmatch` | nada (es un `read`) | un patrón **aparece** en lo escrito desde que se armó |
| **R4** | `gpu` | `nvidia-smi` | **corrobora, no dispara**: no puede armar sola |
| **R5** | `port` | `ss` | algo sigue escuchando |
| **R6** | `unit` | `systemctl` | la unidad está `active`/`activating`/`reloading` |
| **R6b** | `ssh` | — | P5.3, apagado |
| **R7 R8 R9 R10** | a11y, pantalla | — | P5.5 / P5.6 |

**R0 no está, y no es un olvido.** R0 es el exit code de un wrapper que arrancó
Hannah, y en una fase de solo observar ella no arranca nada, así que no hay
wrapper cuyo código mirar. El enum de ids del contrato `sense.v1` es R1..R10, así
que la fila no se emite; la razón vive en `capability.R0_ABSENT_REASON`.

Dos reglas que están en el código y no en un comentario, porque son las que
evitan que la vigilancia mienta:

- **R4 nunca dispara sola.** `base.build()` rechaza cualquier watch cuyo único
  sensor sea corroborante. Checkpointing y un dataloader lento leen los dos 0 %:
  un watch de GPU sola relanzaría un entrenamiento que está guardando la época 12
  y, en una placa de 4 GB, eso son dos entrenamientos peleándose la memoria.
- **Un trip es una transición.** Después de disparar, el watch no vuelve a
  disparar hasta que lee una muestra sana. Un entrenamiento muerto sigue muerto:
  sin esto emitía un `watch.tripped` cada `debounceN` muestras, o sea ochenta
  avisos de lo mismo a las 3am. Acotar un *crash-loop* (transiciones de verdad,
  muchas y seguidas) es otra cosa y es el trabajo de `maxFires` en M5.2.3.

## Las rutas: la tabla es del agente

Observar es ejecutar. Un sidecar que acepta rutas libres es una primitiva de
lectura que se saltea la denylist del agente entera, así que **toda ruta se
clasifica antes de tocarla** y una ruta denegada es un `403` **al armar**, con la
misma cadena que dice el agente cuando le piden leer ese mismo archivo.

**Y se clasifica de nuevo en cada muestra**, porque una ruta es un *nombre*:
entre el arme y la muestra número doscientos pasan horas, y en el medio un
`live.log` se puede volver un symlink a un `.env` (que es, además, la forma que
tiene una rotación de logs). El sensor guarda la ruta **cruda** y la abre por
`open_watched()`, que hace tres cosas y no una: clasifica de nuevo, abre con
`O_NOFOLLOW` (el último componente no se sigue) y `O_NONBLOCK` (un FIFO no
cuelga el `open`), y después le pregunta al kernel **qué archivo abrió de
verdad** y lo clasifica también — que es lo que tapa el cambio de un directorio
del *medio*, que `O_NOFOLLOW` no mira. Lo que queda abierto (la ventana existe,
pero adentro no se lee nada; un hardlink no se ve; hace falta `/proc`) está
escrito en el docstring de `open_watched`, y ahí tiene que seguir: creer que no
quedaba nada es como se llegó al agujero.

La tabla **no se copia a mano**: `paths.py` lee el asset generado
`agent/docs/fixtures/policy-paths.json`, que sale de
`packages/agent/src/hannah/policy/paths.ts`. Lo que sí está duplicado es el
algoritmo de `classify()`, y por eso el asset trae casos *golden* con el veredicto
que produjo el TypeScript: `tests/test_paths_golden.py` los exige uno por uno, así
que las dos implementaciones no pueden separarse en silencio.

Se busca el asset en `HANNAH_AGENT_FIXTURES`, después en `../../hannah-agent/`
(el layout que crea el instalador) y después en `../../agent/` (un checkout de
desarrollo) — el mismo orden que `backend/tests/unit/agentBridge.test.js`. **Sin
asset se falla cerrado**: R2 y R3 se reportan no disponibles y cualquier watch con
ruta responde 403.

Un agregado propio, que no está en la tabla compartida: **`backend/data`**,
resuelto desde `__file__` igual que `DATA_DIR` en `backend/src/state/dataDir.js`.
Es el residual del bug B2 (la regla compilada nombra `hannah-backend/data`, que es
la carpeta del layout instalado); el launcher se lo pasa al agente por
`HANNAH_AGENT_DENY_DIRS`, pero un sidecar arrancado a mano no recibe nada y
`settings.json` (todas las claves de los proveedores en claro) quedaría vigilable.

## Los tests

```bash
cd backend/sidecar/sense
.venv/bin/pip install -r requirements.txt      # trae pytest
.venv/bin/python -m pytest tests -q
```

No hace falta ninguna variable: `tests/conftest.py` manda el estado a un temporal
y **borra `HANNAH_AGENT_DENY_DIRS`** antes de importar nada, porque los casos
golden declaran cada uno el valor que quieren y una variable heredada del shell
cambiaría medio veredicto sin que se vea. Lo que sí hace falta es el repo del
agente al lado (o `HANNAH_AGENT_FIXTURES`), porque la mitad de la suite compara
contra su asset.

## Agregar un sensor

`sensors/base.py` tiene el contrato y un ejemplo en el docstring del módulo; los
seis reales están al lado, uno por archivo. Lo mínimo: heredar de `Sensor`,
declarar `kind`/`rung`/`confidence`, validar **todo** en `parse()` (la ruta con
`classify_path()`, la herramienta con `capability.require()`) y devolver un
`Sample` desde `sample()`.

Dos cosas que no son opcionales:

- **Todo lo que se ejecuta sale por `run_argv()`**: lista de argumentos,
  `shell=False`, sin stdin. No existe la rama de código donde un string de comando
  llegue a un shell, así que no hay nada que inyectar ni aunque el patrón del
  usuario sea `; rm -rf ~`. `tests/test_sensors.py` lo afirma barriendo el
  paquete: `create_subprocess_exec` aparece en un solo archivo.
- **`SensorError` (no pude leer) no es `SensorFault` (el sensor está roto)**. Un
  sample fallado nunca es un trip: un sensor que no puede leer no tiene derecho a
  decir que el entrenamiento se paró. Si no puede leer por más de
  `SENSE_BLIND_MS`, el watch pasa a `blind` y Hannah lo dice. Un sensor roto
  termina el watch como `faulted`, que es otra cosa y se narra distinto.

`stub` sigue existiendo: siempre reporta sano y no toca la máquina, y es con lo
que se arma el brazo de control del demo de salida de P5.1 (el hijo que nunca se
mata, cero trips).
