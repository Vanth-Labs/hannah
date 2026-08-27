# sidecar/sense/sensors.py
"""El contrato de un sensor y el catálogo de escalones (plan VIGILANCE §6).

Un sensor es un objeto TIPADO, nunca un string de comando (regla R2): lo que
llega por HTTP es `{ "kind": "...", ...campos }` y cada clase valida sus propios
campos. Aceptar un comando libre convertiría a este proceso en una primitiva de
lectura que se saltea la denylist del agente entera.

Cómo agregar un sensor (esto es lo que hace M5.1.2 con proc/file/logmatch/gpu/
port/unit):

    @register
    class ProcSensor(Sensor):
        kind = "proc"
        rung = "R1"
        confidence = DETERMINISTIC

        @classmethod
        def parse(cls, spec):
            pattern = spec.get("pattern")
            if not isinstance(pattern, str) or not pattern:
                raise SpecError("pattern es obligatorio")
            return cls(pattern)

        async def sample(self):
            ...  # subprocess con shell=False, argv como lista
            return Sample(healthy=alive, detail={"alive": alive})

Tres reglas que el scheduler da por sentadas y que no se pueden romper:

1. `parse()` valida TODO antes de que exista el watch. Si el spec nombra una
   ruta, la clasifica con `classify_path()` y deja que DeniedPath salga: el
   POST responde 403 con esa misma razón.
2. `sample()` devuelve un Sample o levanta. `SensorError` es "no pude leer"
   (transitorio, cuenta como sample fallado y con el tiempo lleva a `blind`);
   `SensorFault` es "el sensor está roto" (termina el watch como `faulted`).
   La diferencia importa: un sensor que no pudo leer NO tiene derecho a decir
   que el entrenamiento se paró.
3. `Sample.detail` lleva booleanos, contadores y offsets. NUNCA la línea de log
   que matcheó, ni una ruta, ni un host, ni la salida de un comando (regla R2 y
   T9: eso es texto que escribió otro y termina en el prompt de la persona).
"""
from dataclasses import dataclass, field
from typing import Any, ClassVar, Mapping

# Confianza del escalón, no del modelo (plan §4). Un trip `heuristic` puede
# avisar y puede preguntar; nunca puede despachar una acción.
DETERMINISTIC = "deterministic"
CORROBORATED = "corroborated"
HEURISTIC = "heuristic"


class SpecError(ValueError):
    """El spec del sensor es inválido. -> 400 { error, reason }."""


class DeniedPath(SpecError):
    """El spec nombra una ruta denegada. -> 403 { error, reason }.

    `reason` tiene que ser LA MISMA cadena que produce la denegación del agente
    (policy/paths.ts classify()), para que el usuario escuche una sola
    explicación tanto si pidió leer el archivo como si pidió vigilarlo.
    """


class SensorError(RuntimeError):
    """No se pudo tomar la muestra (transitorio)."""


class SensorFault(RuntimeError):
    """El sensor mismo está roto: lo observado ya no es observable."""


@dataclass(frozen=True)
class Sample:
    """Una muestra. `healthy=False` es el aporte del sensor a un trip, no el trip.

    Quien decide es el scheduler (debounceN muestras seguidas en falso); un
    sensor jamás dispara solo, y un escalón corroborante (R4) menos todavía.
    """
    healthy: bool
    detail: Mapping[str, Any] = field(default_factory=dict)


class Sensor:
    """Interfaz que implementa cada tipo de sensor. Ver el docstring del módulo."""

    kind: ClassVar[str] = ""
    #: Escalón de la escalera de detección, o None si no es un escalón real.
    rung: ClassVar[str | None] = None
    confidence: ClassVar[str] = DETERMINISTIC
    #: R4 (GPU) es corroborante: nunca puede ser el único sensor de un watch.
    corroborating_only: ClassVar[bool] = False

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "Sensor":
        raise NotImplementedError

    async def sample(self) -> Sample:
        raise NotImplementedError

    def rebaseline(self) -> None:
        """Olvida la línea de base. Lo llama el scheduler cuando detecta un salto
        de reloj (una suspensión del laptop): un sensor que guarda "el mtime que
        vi la vez pasada" tiene que tirar ese valor, porque comparar contra algo
        de antes de dormir es lo que hace que todo se vea parado al despertar."""


SENSORS: dict[str, type[Sensor]] = {}


def register(cls: type[Sensor]) -> type[Sensor]:
    """Registra un tipo de sensor. El enum de kinds es cerrado: es este dict."""
    if not cls.kind:
        raise ValueError("un sensor necesita kind")
    SENSORS[cls.kind] = cls
    return cls


def build(spec: Any) -> Sensor:
    """Construye el sensor desde el spec del POST. Levanta SpecError/DeniedPath."""
    if not isinstance(spec, Mapping):
        raise SpecError("sensor tiene que ser un objeto")
    kind = spec.get("kind")
    if not isinstance(kind, str) or kind not in SENSORS:
        # No se lista qué kinds existen: eso lo contesta /v1/capabilities, que
        # ya pasó por el token.
        raise SpecError("sensor.kind desconocido")
    sensor = SENSORS[kind].parse(spec)
    if sensor.corroborating_only:
        raise SpecError(f"{kind} solo corrobora: no puede ser el único sensor de un watch")
    return sensor


def classify_path(path: str) -> str:
    """Clasifica una ruta ANTES de usarla; levanta DeniedPath si es sensible.

    M5.1.2 reemplaza el cuerpo por una lectura del asset generado desde
    policy/paths.ts (la lista NO se copia a mano: una copia diverge y la
    divergencia se descubre con una fuga, no con un test).

    Hasta entonces falla CERRADO. Un `return path` provisorio acá sería un
    sensor de archivos que lee ~/.ssh/id_rsa el día que alguien registre el
    primer sensor con ruta y se olvide de este TODO.
    """
    raise DeniedPath("la clasificación de rutas todavía no está disponible (M5.1.2)")


@register
class StubSensor(Sensor):
    """Sensor de andamio: siempre sano, no toca la máquina, no tiene escalón.

    Existe para que M5.1.1 pueda probar el scheduler, la persistencia y el SSE
    sin ningún subproceso, y para que el brazo de control del demo de salida de
    P5.1 (el hijo que nunca se mata, cero trips) tenga con qué armarse.
    M5.1.2 agrega los sensores reales al lado; este no se borra.
    """

    kind = "stub"
    rung = None
    confidence = DETERMINISTIC

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "StubSensor":
        return cls()

    async def sample(self) -> Sample:
        return Sample(healthy=True, detail={"stub": True})


# La escalera, en orden y con el kind que la implementa. R0 (código de salida de
# un wrapper que arrancó Hannah) NO está: en esta fase el sidecar no arranca
# nada, así que no hay wrapper cuyo exit code mirar, y un escalón que no se puede
# cumplir no se anuncia (regla del catálogo de macros: Hannah no promete lo que
# no puede hacer).
LADDER: tuple[tuple[str, str, str], ...] = (
    ("R1", "proc", "pgrep -f: el proceso está vivo"),
    ("R2", "file", "el mtime de un archivo dejó de avanzar"),
    ("R3", "logmatch", "un patrón aparece en la cola del log"),
    ("R4", "gpu", "la GPU cayó por debajo de un porcentaje (solo corrobora)"),
    ("R5", "port", "algo sigue escuchando en un puerto"),
    ("R6", "unit", "systemctl is-failed / journalctl"),
    ("R6b", "ssh", "cualquiera de R1-R6 sobre SSH"),
    ("R7", "a11y", "estado de un widget por AT-SPI"),
    ("R8", "screenhash", "el hash de una región de pantalla dejó de cambiar"),
    ("R9", "ocr", "OCR de una región"),
    ("R10", "vlm", "un VLM local lee la pantalla"),
)

# Por qué un escalón todavía no está. Se contesta el hito que lo trae, no
# "not implemented": el operador que pregunta quiere saber si es un bug o si es
# el calendario.
_PENDING = {
    "R1": "el sensor proc llega en M5.1.2",
    "R2": "el sensor file llega en M5.1.2",
    "R3": "el sensor logmatch llega en M5.1.2",
    "R4": "el sensor gpu llega en M5.1.2",
    "R5": "el sensor port llega en M5.1.2",
    "R6": "el sensor unit llega en M5.1.2",
    "R6b": "el caso remoto llega en P5.3 y está apagado (SENSE_SSH_ENABLED)",
    "R7": "AT-SPI llega en P5.6 y depende del spike de cobertura",
    "R8": "la pantalla llega en P5.5 y se entrega apagada (SENSE_SCREEN_ENABLED)",
    "R9": "la pantalla llega en P5.5; además tesseract no está instalado",
    "R10": "la pantalla llega en P5.5 y depende de VRAM libre y de un modelo bajado",
}


def capabilities() -> dict[str, Any]:
    """Lo que ESTA máquina puede vigilar hoy. Un escalón sin sensor no está disponible.

    El backend arma el vocabulario de `[WATCH:]` con esto (M5.1.3): si acá dice
    que no, la persona nunca aprende la palabra y no puede prometerla.
    """
    rungs = []
    for rung_id, kind, _summary in LADDER:
        available = kind in SENSORS
        entry: dict[str, Any] = {"id": rung_id, "available": available}
        if not available:
            entry["reason"] = _PENDING.get(rung_id, "sensor no disponible en esta máquina")
        rungs.append(entry)
    return {"rungs": rungs, "sensors": sorted(SENSORS)}


def rung_of(kind: str) -> str | None:
    """Escalón que le corresponde a un kind, o None (el stub no tiene)."""
    sensor = SENSORS.get(kind)
    return sensor.rung if sensor else None
