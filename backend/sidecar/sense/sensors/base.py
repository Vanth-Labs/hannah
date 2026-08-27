# sidecar/sense/sensors/base.py
"""El contrato de un sensor: la interfaz, el registro y el runner de subprocesos.

Un sensor es un objeto TIPADO, nunca un string de comando (regla R2): lo que
llega por HTTP es `{ "kind": "...", ...campos }` y cada clase valida sus propios
campos. Aceptar un comando libre convertiría a este proceso en una primitiva de
lectura que se saltea la denylist del agente entera.

Cómo agregar un sensor (así están hechos proc/file/logmatch/gpu/port/unit):

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
            done = await run_argv([self._pgrep, "-f", "--", self._pattern])
            return Sample(healthy=done.code == 0, detail={"alive": done.code == 0})

Cuatro reglas que el scheduler da por sentadas y que no se pueden romper:

1. `parse()` valida TODO antes de que exista el watch. Si el spec nombra una
   ruta, la clasifica con `classify_path()` y deja que DeniedPath salga: el
   POST responde 403 con esa misma razón. Si el escalón necesita una herramienta,
   la resuelve acá: enterarse en el primer sample es un watch ya armado que nunca
   va a poder mirar.
2. `sample()` devuelve un Sample o levanta. `SensorError` es "no pude leer"
   (transitorio, cuenta como sample fallado y con el tiempo lleva a `blind`);
   `SensorFault` es "el sensor está roto" (termina el watch como `faulted`).
   La diferencia importa: un sensor que no pudo leer NO tiene derecho a decir
   que el entrenamiento se paró.
3. `Sample.detail` lleva booleanos, contadores y offsets. NUNCA la línea de log
   que matcheó, ni una ruta, ni un host, ni la salida de un comando (regla R2 y
   T9: eso es texto que escribió otro y termina en el prompt de la persona).
4. Todo lo que se ejecuta sale por `run_argv()`: lista de argumentos, shell=False,
   sin stdin. No hay ningún lugar donde se arme un string de comando, así que no
   hay nada que inyectar; es una propiedad estructural, no una validación que se
   pueda olvidar de aplicar.
"""
import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, ClassVar, Mapping, NamedTuple, Sequence

import paths

logger = logging.getLogger(__name__)

# Confianza del escalón, no del modelo (plan §4). Un trip `heuristic` puede
# avisar y puede preguntar; nunca puede despachar una acción.
DETERMINISTIC = "deterministic"
CORROBORATED = "corroborated"
HEURISTIC = "heuristic"

# Techo propio del runner, por debajo de SAMPLE_TIMEOUT_MS: el scheduler cancela
# la corrutina, pero el que tiene que matar al hijo es quien lo parió. Sin esto,
# un nvidia-smi colgado deja un proceso zombi por sample, para siempre.
ARGV_TIMEOUT_S = 8.0

# Cota de la salida que se lee de un subproceso. Nada de lo que sale de acá viaja
# (regla R2), pero un `ss` con cien mil sockets no puede comerse la RAM del
# proceso que tiene que seguir vigilando.
MAX_OUTPUT_BYTES = 256 * 1024


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
        # ACÁ es donde R4 no puede disparar solo, y por eso está en código y no en
        # un comentario: un watch de GPU sola vería 0% en un checkpoint y en un
        # dataloader lento, y relanzaría un entrenamiento que estaba andando bien.
        # Mientras no exista el watch multi-sensor (P5.2), no se puede armar.
        raise SpecError(f"{kind} solo corrobora: no puede ser el único sensor de un watch")
    return sensor


def classify_path(value: Any, field_name: str = "path") -> str:
    """Clasifica una ruta ANTES de usarla y devuelve la RESUELTA.

    Se devuelve la resuelta y no la cruda porque es la que se clasificó: abrir
    después la cruda dejaría abierta la ventana entre las dos (un symlink que
    cambia de destino entre el arme y el sample).

    Falla CERRADO si no hay tabla: sin la denylist del agente este proceso no
    tiene con qué decidir, y un `return value` provisorio sería un sensor de
    archivos que vigila ~/.ssh/id_rsa.
    """
    if not isinstance(value, str) or not value.strip():
        raise SpecError(f"{field_name} es obligatorio")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        # Un \n en una ruta no es una ruta: es alguien probando si el `$` de una
        # regla ancla al final de la cadena o antes del salto. Se corta acá.
        raise SpecError(f"{field_name} tiene caracteres de control")
    try:
        verdict = paths.classify(value, "/")
    except paths.AssetMissing as exc:
        raise DeniedPath(str(exc)) from exc
    if verdict.sensitive:
        raise DeniedPath(verdict.reason or "ruta denegada")
    # La capa propia del sidecar va DESPUÉS y aparte, para que
    # `paths.classify()` siga siendo un port fiel de PolicyPaths.classify y el
    # test de los casos golden pueda seguir probando que las dos
    # implementaciones contestan igual. Ver paths.local_directories().
    local = paths.locally_denied(verdict.resolved)
    if local:
        raise DeniedPath(local)
    return verdict.resolved


class Completed(NamedTuple):
    """Lo que devolvió un subproceso. `out` no sale nunca de este proceso: se
    parsea acá y lo que viaja es un booleano o un contador."""
    code: int
    out: str
    err: str


async def run_argv(argv: Sequence[str], *, timeout_s: float = ARGV_TIMEOUT_S) -> Completed:
    """Corre un programa por ARGV, sin shell y sin stdin.

    La lista es el punto: no hay concatenación, no hay comillas que escapar y no
    hay metacaracteres que interpretar, así que no hay inyección posible ni
    aunque el patrón del usuario sea `; rm -rf ~`. Es estructural: no existe la
    rama del código donde un string de comando llegue a un shell.

    `stdin` va a /dev/null porque un probe que pide algo por teclado se cuelga
    para siempre en un proceso sin terminal, y un watch colgado es un watch que
    el usuario cree armado.
    """
    if not isinstance(argv, (list, tuple)) or not argv:
        raise SensorFault("argv vacío")
    if any(not isinstance(part, str) for part in argv):
        # Un int o un None acá es un bug del sensor, no del usuario: mejor romper
        # el watch (faulted) que ejecutar algo distinto de lo que dice el spec.
        raise SensorFault("argv tiene que ser una lista de strings")

    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        # La herramienta estaba al armar y ya no está (una actualización del
        # sistema): el sensor está roto, no el entrenamiento.
        raise SensorFault(f"{argv[0]} no está") from exc
    except OSError as exc:
        raise SensorFault(f"no se pudo ejecutar: {exc.__class__.__name__}") from exc

    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        # El hijo se mata acá y no en el scheduler: cancelar la corrutina no mata
        # al proceso, y un probe por watch por período que nunca muere llena la
        # tabla de procesos en horas.
        await _kill(process)
        raise
    return Completed(
        code=process.returncode if process.returncode is not None else -1,
        out=out[:MAX_OUTPUT_BYTES].decode("utf-8", "replace"),
        err=err[:MAX_OUTPUT_BYTES].decode("utf-8", "replace"),
    )


async def _kill(process: "asyncio.subprocess.Process") -> None:
    if process.returncode is not None:
        return
    try:
        process.kill()
    except ProcessLookupError:
        return
    # Se espera al hijo muerto: sin el wait queda zombi hasta que muera el sidecar.
    with_shield = asyncio.shield(process.wait())
    try:
        await asyncio.wait_for(with_shield, timeout=2.0)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        logger.warning("un subproceso no murió después del kill")


@register
class StubSensor(Sensor):
    """Sensor de andamio: siempre sano, no toca la máquina, no tiene escalón.

    Existe para que se pueda probar el scheduler, la persistencia y el SSE sin
    ningún subproceso, y para que el brazo de control del demo de salida de P5.1
    (el hijo que nunca se mata, cero trips) tenga con qué armarse.
    """

    kind = "stub"
    rung = None
    confidence = DETERMINISTIC

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "StubSensor":
        return cls()

    async def sample(self) -> Sample:
        return Sample(healthy=True, detail={"stub": True})
