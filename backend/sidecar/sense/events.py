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
import secrets
import time
from typing import Any, NamedTuple, Sequence

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
        # Identidad de ESTE arranque del anillo. Un cursor solo quiere decir algo
        # adentro del arranque que lo emitió: acá arranca en 0 cada vez que el
        # proceso levanta, y el backend guarda su `lastId` por la vida de SU
        # proceso, que es mucho más larga. Viaja en el comentario de la conexión
        # para que el cliente pueda notar que cambió y tirar el cursor que tenía.
        self._boot = secrets.token_hex(8)
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

        `truncated` NO quiere decir "faltan eventos": quiere decir que lo que va
        a salir por esta conexión no es la continuación exacta de lo que el
        cliente pidió. El silencio sería la respuesta peligrosa (el backend cree
        que replayeó todo y se come un trip).

        Hay DOS formas de no poder continuar, y la segunda es la que faltaba:

        * el anillo ya tiró parte del hueco (`cursor` por debajo del más viejo);
        * el `cursor` viene ADELANTADO, o sea de otro arranque de este proceso.
          Adentro de un arranque el cursor solo sube, así que pedir desde 500
          cuando el más nuevo es 4 es imposible por construcción. Antes eso se
          contestaba `truncated=false` y se filtraba todo: un resume limpio que
          no entregaba NADA. El backend veía la conexión abierta, decía `up`, y
          el contrato de ceguera no lo agarraba porque sí estaba en contacto.
          Ahora un cursor imposible se trata como una conexión nueva (el anillo
          entero, igual que sin Last-Event-ID) y se dice `truncated=true`.

        Y LO QUE ESTE ANILLO NO PUEDE HACER, dicho acá porque el docstring
        afirmaba lo contrario: no deduplica. "Sin Last-Event-ID" no quiere decir
        "soy nuevo", así que un suscriptor que llega sin cursor se lleva el
        anillo entero como eventos vivos, incluido lo que un proceso anterior
        suyo ya atendió. El `seq` por watch tampoco lo salva: sirve adentro de un
        backend que vio armarse la vigilancia, y uno que acaba de arrancar adopta
        las filas con `seq` 0. Quién sí puede contestar "esto ya lo atendí" es el
        backend, que guarda el par (boot, cursor) y filtra con él
        (senseBridge.js, `alreadyHandled`); acá no hay acuse de entrega y por eso
        no puede decidirse desde este lado.

        Esto se apartó a propósito de `facade/store.ts:224`, de donde está
        portado el resto. Allá la forma alcanza porque la fachada vive DENTRO del
        proceso del agente y muere con su cliente: los dos cursores nacen
        juntos, así que uno adelantado no existe. Acá el sidecar reinicia solo
        (una actualización, un crash, `systemctl restart`) mientras el backend
        sigue vivo con su `lastId` en la mano, y ese caso es el normal.
        """
        if cursor > self._cursor:
            # Imposible dentro de este arranque: el cliente trae el cursor de uno
            # anterior. Se le da lo que hay, que es lo mismo que recibe un
            # cliente sin Last-Event-ID. De más y no de menos, a propósito: lo
            # repetido lo filtra el backend con su par (boot, cursor), y lo que
            # no se entrega no lo recupera nadie.
            return list(self._events), True
        if not self._events:
            return [], False
        oldest = self._events[0].cursor
        truncated = cursor > 0 and cursor < oldest - 1
        return [event for event in self._events if event.cursor > cursor], truncated

    def watermark(self, replay: Sequence[Stored]) -> int:
        """El cursor más alto que YA salió por esta conexión.

        Sale del anillo y JAMÁS del cursor que mandó el cliente. La ruta se
        suscribe antes de calcular el replay, así que un evento publicado en el
        medio queda en los dos lados y hace falta saber hasta dónde se envió;
        pero tomar el cursor del cliente como "esto ya se envió" convierte un
        Last-Event-ID viejo en un filtro que se come TODO lo que venga después,
        para siempre, con la conexión abierta. Con el anillo vacío y un cursor de
        500, el backend quedaba sordo hasta el evento 501.

        Se llama pegado a `since()`: no hay await en el medio, así que las dos
        miran el mismo anillo.
        """
        return replay[-1].cursor if replay else self._cursor

    def cursor(self) -> int:
        return self._cursor

    def boot_id(self) -> str:
        """Identidad de este arranque. Ver `_boot` y el docstring de `since()`."""
        return self._boot

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
