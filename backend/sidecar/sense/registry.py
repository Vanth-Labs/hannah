# sidecar/sense/registry.py
"""El registro de watches en memoria, su validación de entrada y su persistencia.

Los watches son del PROCESO, no de la sesión: `SESSION_TTL_MINUTES` son 30 y se
refresca al usarla, así que un watch atado a la sesión sobreviviría si la
conversación es charlatana y se moriría en el caso sano (silencio). El
`sessionId` que llega al armar es una PREFERENCIA DE ENTREGA, no la vida del
watch (plan §10).

Persistencia (asunción A4): lo que se guarda vuelve como `suspended`, jamás
armado. Re-armar solo porque el proceso reinició no es consentimiento.
"""
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Mapping

import sensors
from config import (
    DEBOUNCE_N,
    MAX_DEBOUNCE_N,
    MAX_LABEL_CHARS,
    MAX_NARRATION_CHARS,
    MAX_PERIOD_MS,
    MAX_SESSION_ID_CHARS,
    MAX_TERMINAL_ROWS,
    MAX_TTL_MS,
    MIN_PERIOD_MS,
    STATE_DIR,
    WATCHES_FILE,
)

logger = logging.getLogger(__name__)

# Estados. `degraded` no es un estado: es el contador de /health para un watch al
# que se le bajó el tier de acción, y en esta fase (solo observar) siempre es 0.
# El campo se mantiene para que la forma no cambie cuando P5.2 lo use.
ACTIVE_STATES = frozenset({"armed", "blind", "suspended"})
TERMINAL_STATES = frozenset({"expired", "disarmed", "faulted"})

# En esta fase el sidecar solo observa (regla R1: las manos son del agente).
# Viaja en watch.armed para que el HUD y la voz digan lo mismo que el usuario eligió.
OBSERVE_TIER = "observe"

# base32 en minúsculas, sin 0/1/8/9 para que no se confundan al dictarlas.
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"


def new_watch_id() -> str:
    return "w_" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(24))


def now_ms() -> int:
    return int(time.time() * 1000)


def _clean_text(value: Any, field_name: str, max_chars: int) -> str:
    """Texto del usuario: string, sin caracteres de control, acotado.

    Los de control se rechazan acá y no donde se muestran: `label` termina en un
    log, en el sobre SSE y en una línea hablada, y un \\r o un \\x1b en el medio
    ensucia las tres a la vez.
    """
    if not isinstance(value, str):
        raise sensors.SpecError(f"{field_name} tiene que ser texto")
    text = value.strip()
    if not text:
        raise sensors.SpecError(f"{field_name} no puede estar vacío")
    if len(text) > max_chars:
        raise sensors.SpecError(f"{field_name} supera {max_chars} caracteres")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        raise sensors.SpecError(f"{field_name} tiene caracteres de control")
    return text


@dataclass
class Watch:
    watch_id: str
    label: str
    sensor_spec: dict[str, Any]
    sensor_kind: str
    rung: str | None
    period_ms: int
    debounce_n: int
    expires_at: int
    session_id: str | None
    #: La frase que Hannah leyó de vuelta al armar. Se guarda y NO se devuelve en
    #: ninguna fila: la escribió el usuario, la lee el backend, y la fila del
    #: contrato no la lleva.
    narration: str | None
    state: str = "suspended"
    created_at: int = field(default_factory=now_ms)
    last_sample_at: int | None = None
    last_ok_at: int | None = None
    samples_ok: int = 0
    samples_failed: int = 0
    fires: int = 0
    #: Muestras no sanas seguidas. Llega a debounce_n y recién ahí hay trip.
    streak: int = 0
    #: Por qué falló el último sample, en vocabulario fijo (nunca el texto de la
    #: excepción: eso lleva rutas). Alimenta el `reason` de watch.blind.
    last_error: str | None = None
    disarm_reason: str | None = None

    def row(self) -> dict[str, Any]:
        """La fila del contrato. NUNCA lleva un valor de muestra, una línea de log,
        una ruta ni un host: `watchStatus()` se arma con esto y se pega al system
        prompt de cada turno con acciones, así que contenido acá sería un punto de
        inyección permanente mientras el watch esté armado (plan §10, T9)."""
        return {
            "watchId": self.watch_id,
            "label": self.label,
            "state": self.state,
            "rung": self.rung,
            "sensorKind": self.sensor_kind,
            # Último intento de muestra, exitoso o no: dice que el scheduler
            # sigue tiqueando. Para "¿está leyendo bien?" están `samplesOk` y el
            # estado `blind`, que es el que se narra.
            "lastSampleAt": self.last_sample_at,
            "samplesOk": self.samples_ok,
            "samplesFailed": self.samples_failed,
            "fires": self.fires,
            "expiresAt": self.expires_at,
            "sessionId": self.session_id,
        }

    def persisted(self) -> dict[str, Any]:
        return {
            "watchId": self.watch_id,
            "label": self.label,
            "sensor": self.sensor_spec,
            "periodMs": self.period_ms,
            "debounceN": self.debounce_n,
            "expiresAt": self.expires_at,
            "sessionId": self.session_id,
            "narration": self.narration,
            "createdAt": self.created_at,
            "fires": self.fires,
        }


def parse_create(payload: Any) -> Watch:
    """Valida el cuerpo de POST /v1/watches y devuelve el watch (todavía sin armar).

    Levanta SpecError (-> 400) o DeniedPath (-> 403). Construir el sensor acá y
    no en el scheduler es lo que hace que una ruta denegada se rechace ANTES de
    que el watch exista: un watch que se arma y recién en el primer sample
    descubre que no puede leer ya le mintió al usuario.
    """
    if not isinstance(payload, Mapping):
        raise sensors.SpecError("el cuerpo tiene que ser un objeto")

    label = _clean_text(payload.get("label"), "label", MAX_LABEL_CHARS)

    spec = payload.get("sensor")
    sensor = sensors.build(spec)

    period_ms = payload.get("periodMs")
    if not isinstance(period_ms, int) or isinstance(period_ms, bool):
        raise sensors.SpecError("periodMs tiene que ser un entero en milisegundos")
    if period_ms < MIN_PERIOD_MS:
        # El piso no es cosmético: cinco watches a 15 s ya son veinte subprocesos
        # por minuto, para siempre, en una máquina con cuatro sidecars encima.
        raise sensors.SpecError(f"periodMs por debajo del mínimo ({MIN_PERIOD_MS} ms)")
    if period_ms > MAX_PERIOD_MS:
        raise sensors.SpecError(f"periodMs por encima del máximo ({MAX_PERIOD_MS} ms)")

    debounce_n = payload.get("debounceN", DEBOUNCE_N)
    if not isinstance(debounce_n, int) or isinstance(debounce_n, bool):
        raise sensors.SpecError("debounceN tiene que ser un entero")
    if debounce_n < 1 or debounce_n > MAX_DEBOUNCE_N:
        raise sensors.SpecError(f"debounceN tiene que estar entre 1 y {MAX_DEBOUNCE_N}")

    expires_at = payload.get("expiresAt")
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        # Asunción A3: no hay watches abiertos para siempre. La expiración es
        # obligatoria porque es lo que Hannah lee en voz alta al armar.
        raise sensors.SpecError("expiresAt es obligatorio (epoch en milisegundos)")
    now = now_ms()
    if expires_at <= now:
        raise sensors.SpecError("expiresAt ya pasó")
    if expires_at - now > MAX_TTL_MS:
        raise sensors.SpecError(f"expiresAt supera el máximo ({MAX_TTL_MS} ms)")
    if expires_at - now < period_ms:
        raise sensors.SpecError("expiresAt llega antes del primer sample")

    session_id = payload.get("sessionId")
    if session_id is not None:
        session_id = _clean_text(session_id, "sessionId", MAX_SESSION_ID_CHARS)

    narration = payload.get("narration")
    if narration is not None:
        narration = _clean_text(narration, "narration", MAX_NARRATION_CHARS)

    return Watch(
        watch_id=new_watch_id(),
        label=label,
        sensor_spec=dict(spec),
        sensor_kind=sensor.kind,
        rung=sensor.rung,
        period_ms=period_ms,
        debounce_n=debounce_n,
        expires_at=expires_at,
        session_id=session_id,
        narration=narration,
        state="armed",
    )


class Registry:
    """Los watches vivos, en memoria, con un espejo en disco."""

    def __init__(self) -> None:
        self._watches: dict[str, Watch] = {}

    def add(self, watch: Watch) -> list[str]:
        """Agrega un watch y devuelve los ids de las filas terminales desalojadas."""
        self._watches[watch.watch_id] = watch
        return self._evict_terminal()

    def get(self, watch_id: str) -> Watch | None:
        return self._watches.get(watch_id)

    def all(self) -> list[Watch]:
        return list(self._watches.values())

    def active(self) -> list[Watch]:
        """Los que no terminaron: incluye `suspended`, que es lo que se persiste."""
        return [w for w in self._watches.values() if w.state in ACTIVE_STATES]

    def sampling(self) -> list[Watch]:
        """Los que de verdad están tiqueando; es contra esto que se mide el cupo.

        `suspended` NO ocupa cupo: son los que volvieron de un reinicio y no
        muestrean nada. Contarlos haría que dos vigilancias muertas de ayer
        impidieran armar una hoy, que es un 409 imposible de explicar.
        """
        return [w for w in self._watches.values() if w.state in ("armed", "blind")]

    def counters(self) -> dict[str, int]:
        """Los cuatro contadores de /health. `degraded` es siempre 0 en esta fase."""
        counts = {"armed": 0, "degraded": 0, "blind": 0, "suspended": 0}
        for watch in self._watches.values():
            if watch.state in counts:
                counts[watch.state] += 1
        return counts

    def _evict_terminal(self) -> list[str]:
        """Las filas terminales se conservan (el HUD quiere ver por qué se desarmó)
        pero acotadas: si no, un proceso de una semana acumula filas muertas."""
        terminal = [w for w in self._watches.values() if w.state in TERMINAL_STATES]
        if len(terminal) <= MAX_TERMINAL_ROWS:
            return []
        terminal.sort(key=lambda w: w.created_at)
        evicted = []
        for watch in terminal[: len(terminal) - MAX_TERMINAL_ROWS]:
            self._watches.pop(watch.watch_id, None)
            evicted.append(watch.watch_id)
        return evicted

    # ── Persistencia ────────────────────────────────────────────────────────
    def save(self) -> None:
        """Escribe los watches vivos. 0700 la carpeta, 0600 el archivo, igual que
        el idioma de backend/src/state/dataDir.js.

        Reemplazo atómico: un corte de luz en el medio de un writeFile deja un
        JSON roto, y un JSON roto acá es un watch que el usuario cree armado.
        """
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(STATE_DIR, 0o700)
            payload = {"v": 1, "savedAt": now_ms(),
                       "watches": [w.persisted() for w in self.active()]}
            tmp = WATCHES_FILE.with_suffix(".json.tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.replace(tmp, WATCHES_FILE)
            os.chmod(WATCHES_FILE, 0o600)
        except OSError as exc:
            logger.error(f"no se pudo persistir watches.json: {exc.__class__.__name__}")

    def load(self) -> int:
        """Trae lo persistido como `suspended`. Devuelve cuántos cargó.

        NUNCA re-arma (asunción A4). Un watch que vuelve solo después de un
        reinicio es una vigilancia que el usuario no pidió esta vez.
        """
        try:
            if not WATCHES_FILE.exists():
                return 0
            data = json.loads(WATCHES_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.error(f"no se pudo leer watches.json: {exc.__class__.__name__}")
            return 0

        loaded = 0
        now = now_ms()
        for entry in data.get("watches", []) if isinstance(data, Mapping) else []:
            try:
                # Un watch cuya expiración pasó mientras el proceso estaba caído
                # ya terminó: el usuario dijo "hasta las ocho" y son las diez.
                # Volver a mostrarlo sería una vigilancia que nadie pidió.
                if int(entry["expiresAt"]) <= now:
                    continue
                sensor = sensors.build(entry.get("sensor"))
                watch = Watch(
                    watch_id=str(entry["watchId"]),
                    label=str(entry["label"]),
                    sensor_spec=dict(entry["sensor"]),
                    sensor_kind=sensor.kind,
                    rung=sensor.rung,
                    period_ms=int(entry["periodMs"]),
                    debounce_n=int(entry["debounceN"]),
                    expires_at=int(entry["expiresAt"]),
                    session_id=entry.get("sessionId"),
                    narration=entry.get("narration"),
                    state="suspended",
                    created_at=int(entry.get("createdAt", now_ms())),
                    fires=int(entry.get("fires", 0)),
                )
            except (KeyError, TypeError, ValueError, sensors.SpecError) as exc:
                # Una fila podrida no puede impedir que carguen las demás.
                logger.warning(f"watch persistido inválido, lo salteo: {exc.__class__.__name__}")
                continue
            self._watches[watch.watch_id] = watch
            loaded += 1
        return loaded
