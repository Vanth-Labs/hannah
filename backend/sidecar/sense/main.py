# sidecar/sense/main.py
"""hannah-sense: el quinto sidecar, en 127.0.0.1:8007. Los ojos, no las manos.

Regla R1 del plan VIGILANCE: este proceso OBSERVA y no cambia la máquina nunca.
Toda acción correctiva es una tarea del agente (:8006), que ya tiene el carril
único, la política dura, los tiers de riesgo, la aprobación, la redacción y el
audit trail. Un segundo ejecutor acá sería un segundo lugar donde mirar cuando
algo pasó, y dos modelos de seguridad que se separan con el tiempo.

Las rutas y los guardias están portados de la fachada del agente
(agent/packages/agent/src/hannah/facade/routes.ts): mismo orden, mismos códigos.
AUDIT C1, C3 y C4 eran todos el mismo hecho (un socket de loopback es alcanzable
desde el navegador de la misma máquina); esto es ese hecho aplicado una vez más.
"""
import json
import logging
import re
import secrets
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

import sensors
from config import KEEPALIVE_SECONDS, MAX_BODY_BYTES, MAX_WATCHES, TOKEN, VERSION
from events import EventBus, now_ms
from registry import Registry, parse_create
from scheduler import Scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

registry = Registry()
bus = EventBus()
scheduler = Scheduler(registry, bus)


@asynccontextmanager
async def lifespan(_: FastAPI):
    loaded = registry.load()
    # Asunción A4: vuelven SUSPENDIDOS, nunca armados. Re-armar solo porque el
    # proceso reinició no es consentimiento, y un watch que el usuario cree
    # armado y no lo está es la peor falla que tiene esta feature.
    logger.info(f"hannah-sense {VERSION} listo; {loaded} watch(es) cargados como suspended")
    if not TOKEN:
        logger.warning("HANNAH_SENSE_TOKEN vacío: todas las rutas menos /health responden 401")
    yield
    await scheduler.shutdown()


app = FastAPI(
    title="Hannah Sense Sidecar",
    version="1.0.0",
    lifespan=lifespan,
    # Sin /docs ni /openapi.json: superficie que nadie usa en un control plane
    # cuyo único cliente es el backend.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


def json_response(body: Any, status: int = 200, headers: dict[str, str] | None = None):
    return JSONResponse(body, status_code=status,
                        headers={"cache-control": "no-store", **(headers or {})})


_BEARER = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)


def authorized(request: Request) -> bool:
    """Compara el bearer en tiempo constante.

    Se compara en CADA request y un `==` filtra largo y prefijo por timing.
    A diferencia de la fachada, un token vacío NO abre el sidecar: falla cerrado.
    La fachada hace `if (!token) return true` porque el backend puede arrancarla
    sin token en desarrollo; acá el control plane de las vigilancias es la
    primera primitiva del sistema que corre sin ninguna frase del usuario
    (plan §9), así que arrancar sin token tiene que ser inútil, no abierto.
    """
    if not TOKEN:
        return False
    match = _BEARER.match((request.headers.get("authorization") or "").strip())
    return bool(match) and secrets.compare_digest(TOKEN, match.group(1))


@app.middleware("http")
async def guards(request: Request, call_next):
    path = request.url.path

    # /health sin token a propósito: el backend y `hannah doctor` lo consultan
    # para saber si el sidecar existe, y un 401 ahí es indistinguible de "mal
    # configurado" justo en el momento en que hace falta la diferencia.
    if path == "/health" and request.method == "GET":
        return await call_next(request)

    if not authorized(request):
        return json_response({"error": "unauthorized"}, 401, {"www-authenticate": "Bearer"})

    # Navegadores, nunca. Una página web alcanza 127.0.0.1:8007 con un request
    # "simple" (text/plain, sin preflight); el backend es el único cliente y no
    # manda Origin. Cierra CSRF desde cualquier pestaña abierta en esta máquina.
    if "origin" in request.headers:
        return json_response({"error": "forbidden"}, 403)

    if request.method in ("POST", "PUT"):
        # Solo JSON, por lo mismo: un form o un text/plain es por definición algo
        # que no es el backend, y es la única forma que tiene el navegador de
        # postear sin preflight.
        content_type = request.headers.get("content-type", "")
        if not re.match(r"^application/json\b", content_type, re.IGNORECASE):
            return json_response({"error": "content-type must be application/json"}, 415)

        # Rechazo temprano por content-length; el tope real lo aplica read_body()
        # leyendo de a chunks, porque un cuerpo chunked no declara largo.
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return json_response({"error": "invalid request", "reason": "cuerpo mayor a 256 KiB"}, 400)

    return await call_next(request)


async def read_body(request: Request) -> bytes | None:
    """Lee el cuerpo con tope. Devuelve None si se pasa de MAX_BODY_BYTES.

    Se lee por stream y no con request.body(): buffear primero y medir después
    es un DoS de memoria de una línea contra un proceso que tiene que seguir
    vigilando.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


# ── Rutas ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Sin ruta de home, sin nombre de usuario, sin lista de watches.

    AUDIT M22 sigue abierto sobre el /health del agente (filtra el home y el
    usuario); no se repite acá.
    """
    return json_response({
        "healthy": True,
        "version": VERSION,
        "watches": registry.counters(),
    })


@app.get("/v1/capabilities")
async def capabilities():
    return json_response(sensors.capabilities())


@app.post("/v1/watches")
async def create_watch(request: Request):
    raw = await read_body(request)
    if raw is None:
        return json_response({"error": "invalid request", "reason": "cuerpo mayor a 256 KiB"}, 400)
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return json_response({"error": "invalid request", "reason": "JSON inválido"}, 400)

    try:
        watch = parse_create(payload)
    except sensors.DeniedPath as exc:
        # Misma cadena que produce la denegación del agente: el usuario escucha
        # una sola explicación, pida leer el archivo o pida vigilarlo.
        return json_response({"error": "forbidden", "reason": str(exc)}, 403)
    except sensors.SpecError as exc:
        return json_response({"error": "invalid request", "reason": str(exc)}, 400)

    # El tope cuenta los que están tiqueando. Ni las filas terminales (que quedan
    # para que el HUD muestre por qué se desarmó una) ni las suspendidas de un
    # reinicio anterior ocupan cupo: no muestrean nada.
    if len(registry.sampling()) >= MAX_WATCHES:
        return json_response({"error": "too many watches"}, 409)

    for evicted in registry.add(watch):
        # El contador `seq` del watch desalojado se olvida acá y no en el
        # registro: si no, `_seq` crece para siempre en un proceso que corre
        # semanas (es la misma clase de fuga que AUDIT M16).
        bus.forget(evicted)
    scheduler.arm(watch)
    return json_response({"watchId": watch.watch_id}, 201)


@app.get("/v1/watches")
async def list_watches():
    return json_response({"watches": [w.row() for w in registry.all()]})


@app.get("/v1/watches/{watch_id}")
async def get_watch(watch_id: str):
    watch = registry.get(watch_id)
    return json_response(watch.row()) if watch else json_response({"error": "watch not found"}, 404)


@app.delete("/v1/watches/{watch_id}")
async def delete_watch(watch_id: str):
    watch = registry.get(watch_id)
    if not watch:
        return json_response({"error": "watch not found"}, 404)
    await scheduler.disarm(watch, reason="user")
    return json_response({"disarmed": True})


@app.get("/v1/events")
async def events(request: Request):
    """El stream global. Una conexión lleva todos los watches.

    `Last-Event-ID` (o `?after=`) reanuda desde el anillo, igual que la fachada:
    un backend que reconecta en medio de una vigilancia perdería si no el trip
    que estaba por narrar. Cuando el replay no es la continuación exacta de lo
    que se pidió se dice con un comentario `sense.resume` en vez de fingir que
    fue completo, y el comentario lleva el `boot` del anillo: el sidecar reinicia
    solo y su cursor vuelve a 0, así que un cursor de otro arranque es el caso
    normal y no la excepción (ver `EventBus.since`).
    """
    header = request.headers.get("last-event-id") or request.query_params.get("after") or ""
    try:
        cursor = max(int(header), 0)
    except ValueError:
        cursor = 0

    # Suscribir ANTES de calcular el replay: al revés, un evento publicado entre
    # ambos pasos no está ni en el replay ni en la cola y se pierde para siempre.
    queue = bus.subscribe()
    replay, truncated = bus.since(cursor)
    # La marca de agua sale del ANILLO y nunca del cursor del cliente: con
    # `else cursor` un Last-Event-ID de un arranque anterior se leía como "esto
    # ya se envió" y filtraba todos los eventos siguientes, con la conexión
    # abierta y el backend diciendo `up`. Ver EventBus.watermark.
    watermark = bus.watermark(replay)

    def frame(stored):
        return ServerSentEvent(data=json.dumps(stored.envelope, ensure_ascii=False),
                               id=str(stored.cursor))

    async def stream():
        try:
            if cursor > 0:
                yield ServerSentEvent(comment=(
                    f"sense.resume from={cursor} replayed={len(replay)} "
                    f"truncated={'true' if truncated else 'false'} "
                    f"boot={bus.boot_id()}"))
            else:
                yield ServerSentEvent(
                    comment=f"sense.v1 connected cursor={bus.cursor()} boot={bus.boot_id()}")
            for stored in replay:
                yield frame(stored)
            while True:
                stored = await queue.get()
                # El replay y la cola se solapan por un instante; el cursor dice
                # cuál ya salió.
                if stored.cursor > watermark:
                    yield frame(stored)
        finally:
            bus.unsubscribe(queue)

    return EventSourceResponse(
        stream(),
        sep="\n",
        ping=KEEPALIVE_SECONDS,
        # Proxies y detectores de inactividad matan conexiones calladas, y un
        # watch sano puede no emitir nada durante horas (plan §10: cuatro horas
        # tranquilas son nada, ni un latido).
        ping_message_factory=lambda: ServerSentEvent(comment=f"keep-alive {now_ms()}"),
    )
