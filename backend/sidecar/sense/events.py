# sidecar/sense/events.py
"""El bus de eventos y su anillo de resume, portado de facade/store.ts.

Dos contadores, como en la fachada:
  * `seq` es por watch y arranca en 1, para que el backend pueda deduplicar sin
    guardar el evento entero;
  * `cursor` es global y monotónico, y es el campo `id:` del SSE, porque el
    resume necesita UN orden y `seq` no lo da.

Lo que NO hay, a propósito (plan §10, "Cuatro horas tranquilas: nada"): no existe
`watch.sample` ni evento de latido. La vida del watch se contesta preguntando
GET /v1/watches y mirando lastSampleAt. Un stream que tiquea una vez por minuto
durante seis horas es exactamente lo que el plan rechazó.
"""
import asyncio
import logging
import time
from typing import Any, NamedTuple

from config import EVENT_BUFFER, VERSION

logger = logging.getLogger(__name__)

# Tipos de evento. Cerrado: si no está acá, no se emite.
EVENT_TYPES = frozenset({
    "watch.armed",
    "watch.tripped",
    "watch.blind",
    "watch.recovered",
    "watch.expired",
    "watch.disarmed",
    "watch.faulted",
})

# Cola por suscriptor. Si se llena, se corta la conexión en vez de bloquear al
# scheduler: el cliente reconecta con Last-Event-ID y el anillo le devuelve lo
# que se perdió. Un consumidor lento no puede frenar una vigilancia.
SUBSCRIBER_QUEUE = 256


class Stored(NamedTuple):
    cursor: int
    envelope: dict[str, Any]


def now_ms() -> int:
    return int(time.time() * 1000)


class EventBus:
    def __init__(self, buffer_size: int = EVENT_BUFFER) -> None:
        self._events: list[Stored] = []
        self._buffer_size = buffer_size
        self._cursor = 0
        self._seq: dict[str, int] = {}
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, watch_id: str, type_: str, data: dict[str, Any]) -> Stored:
        """Agrega un evento, le pone los dos contadores y lo reparte."""
        if type_ not in EVENT_TYPES:
            raise ValueError(f"tipo de evento fuera del contrato: {type_}")
        seq = self._seq.get(watch_id, 0) + 1
        self._seq[watch_id] = seq
        self._cursor += 1

        stored = Stored(
            cursor=self._cursor,
            envelope={
                "v": VERSION,
                "watchId": watch_id,
                "seq": seq,
                "ts": now_ms(),
                "type": type_,
                "data": data,
            },
        )
        self._events.append(stored)
        if len(self._events) > self._buffer_size:
            del self._events[: len(self._events) - self._buffer_size]

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(stored)
            except asyncio.QueueFull:
                # Suscriptor colgado: se lo saca y su stream termina.
                self._subscribers.discard(queue)
                logger.warning("suscriptor SSE atrasado; lo desconecto")
        # Solo metadata: el label lo escribió el usuario, pero data puede llevar
        # campos de un sensor y esto no se loguea nunca entero.
        logger.info(f"event {type_} watch={watch_id} seq={seq} cursor={stored.cursor}")
        return stored

    def since(self, cursor: int) -> tuple[list[Stored], bool]:
        """Eventos posteriores a `cursor`, para el resume con Last-Event-ID.

        `truncated` dice que el anillo ya había tirado parte de lo que el cliente
        se perdió; el silencio sería la respuesta peligrosa (el backend cree que
        replayeó todo y se come un trip).
        """
        if not self._events:
            return [], False
        oldest = self._events[0].cursor
        truncated = cursor > 0 and cursor < oldest - 1
        return [event for event in self._events if event.cursor > cursor], truncated

    def cursor(self) -> int:
        return self._cursor

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def forget(self, watch_id: str) -> None:
        """Olvida el contador de un watch que ya no existe (si no, `_seq` crece
        para siempre en un proceso que corre semanas)."""
        self._seq.pop(watch_id, None)
