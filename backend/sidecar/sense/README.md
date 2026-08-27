# hannah-sense — el quinto sidecar (127.0.0.1:8007)

Los ojos de Hannah para la máquina: mantiene *vigilancias* (watches) que muestrean
una señal cada N segundos y avisan cuando algo dejó de estar como estaba. Es el
hito **M5.1.1** del plan `docs/VIGILANCE.md`; en esta fase solo **observa**.

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

## Agregar un sensor

`sensors.py` tiene el contrato y un ejemplo en el docstring del módulo. Lo mínimo:
heredar de `Sensor`, declarar `kind`/`rung`/`confidence`, validar todo en `parse()`
(incluida la clasificación de cada ruta, que hoy falla cerrado hasta M5.1.2) y
devolver un `Sample` desde `sample()`. La diferencia entre `SensorError` (no pude
leer) y `SensorFault` (el sensor está roto) importa: **un sample fallado nunca es un
trip**, porque un sensor que no puede leer no tiene derecho a decir que el
entrenamiento se paró.

Hoy hay un solo kind, `stub`, que siempre reporta sano y no toca la máquina. Los
reales (`proc`, `file`, `logmatch`, `gpu`, `port`, `unit`) llegan en M5.1.2.
