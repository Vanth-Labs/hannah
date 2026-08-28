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

Cinco reglas que el scheduler da por sentadas y que no se pueden romper:

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
5. Un sensor con ruta guarda la ruta CRUDA (la que escribió el usuario), NO la
   resuelta que devolvió `classify_path()` al armar, y la abre por
   `open_watched()`, que la clasifica de nuevo en cada muestra. Una ruta es un
   NOMBRE, y entre el arme y la muestra número doscientos pasan horas: guardar la
   resuelta no cierra la ventana, porque la resuelta también es un nombre que
   `open()` va a seguir. Ver el docstring de `open_watched()`.
"""
import asyncio
import errno
import logging
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, ClassVar, Iterator, Mapping, NamedTuple, Sequence

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
    #: Andamio de la suite, no una capacidad de la máquina. Ver `allow_test_sensors()`.
    test_only: ClassVar[bool] = False

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


#: Si los sensores de andamio se pueden armar. Apagado en el proceso real y sin
#: perilla de entorno a propósito: una variable la puede tener puesta el shell
#: que arrancó el sidecar, y entonces el catálogo depende de cómo se lanzó.
_TEST_SENSORS = False


def allow_test_sensors(enabled: bool = True) -> None:
    """La costura de la suite: habilita los sensores `test_only` EN ESTE PROCESO.

    La regla del catálogo de macros dice que una capacidad que no es real es una
    que Hannah no aprende, porque el vocabulario de `[WATCH:]` se arma con
    `/v1/capabilities` y nombrar `stub` sería enseñarle a prometer una vigilancia
    que no mira nada y que además ocupa uno de los dos cupos de
    `SENSE_MAX_WATCHES`. El contrato `sense.v1` nombra exactamente
    proc/file/logmatch/gpu/port/unit para esta fase.

    El andamio sigue existiendo porque el scheduler, la persistencia y el SSE se
    prueban sin tocar la máquina, y el brazo de control del demo de salida (el
    hijo que nunca se mata, cero trips) se arma con él. Lo llama `conftest.py`;
    nada que venga de HTTP puede llegar acá.
    """
    global _TEST_SENSORS
    _TEST_SENSORS = bool(enabled)


def test_sensors_allowed() -> bool:
    return _TEST_SENSORS


def public_kinds() -> list[str]:
    """El enum de kinds que se anuncia por cable, ordenado.

    No es `sorted(SENSORS)`: el registro tiene además el andamio. Los dos números
    tienen que poder ser distintos, porque lo que existe en el proceso y lo que
    la máquina ofrece vigilar no son la misma lista.
    """
    return sorted(kind for kind, cls in SENSORS.items()
                  if not cls.test_only or _TEST_SENSORS)


def build(spec: Any) -> Sensor:
    """Construye el sensor desde el spec del POST. Levanta SpecError/DeniedPath."""
    if not isinstance(spec, Mapping):
        raise SpecError("sensor tiene que ser un objeto")
    kind = spec.get("kind")
    cls = SENSORS.get(kind) if isinstance(kind, str) else None
    if cls is None or (cls.test_only and not _TEST_SENSORS):
        # No se lista qué kinds existen: eso lo contesta /v1/capabilities, que
        # ya pasó por el token. Y un kind de andamio contesta EXACTAMENTE lo
        # mismo que uno inventado: una razón distinta ("ese kind es solo para
        # tests") le confirmaría a quien prueba que existe y que hay una perilla
        # que lo abre.
        raise SpecError("sensor.kind desconocido")
    sensor = cls.parse(spec)
    if sensor.corroborating_only:
        # ACÁ es donde R4 no puede disparar solo, y por eso está en código y no en
        # un comentario: un watch de GPU sola vería 0% en un checkpoint y en un
        # dataloader lento, y relanzaría un entrenamiento que estaba andando bien.
        # Mientras no exista el watch multi-sensor (P5.2), no se puede armar.
        raise SpecError(f"{kind} solo corrobora: no puede ser el único sensor de un watch")
    return sensor


def classify_path(value: Any, field_name: str = "path") -> str:
    """Clasifica una ruta y devuelve la RESUELTA que se clasificó.

    Esto contesta "¿esta ruta está denegada AHORA?" y nada más. NO cierra la
    ventana hasta el `open()`, y decir que sí (como decía este docstring) es lo
    que dejó pasar el symlink: la resuelta también es un nombre, y un nombre es
    lo que `open()` sigue. Quien tiene que cerrar la ventana es `open_watched()`,
    que llama a esto en cada muestra y además verifica lo que abrió.

    Se usa en `parse()` para que una ruta denegada sea un 403 AL ARMAR, que es
    donde el usuario puede escuchar la razón.

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


# ── La ruta vigilada, en cada muestra ───────────────────────────────────────
# Lo que se dice cuando la ruta dejó de ser observable. Vocabulario FIJO y NO la
# razón de la denegación: esa lleva la ruta adentro ("/home/.../.ssh is a
# protected directory") y viajaría en `watch.faulted.error` hasta una frase
# hablada, y las rutas no salen de este proceso (regla R2). La razón entera queda
# en el log local, que es donde el operador la necesita.
PATH_TURNED_DENIED = "la ruta vigilada ya no se puede observar"
NOT_A_FILE = "lo vigilado no es un archivo"
UNVERIFIABLE = "no pude verificar qué archivo abrí"

#: El kernel le pega esto al nombre de /proc/self/fd/N cuando el inodo se
#: desenlazó después del open.
_DELETED = " (deleted)"


class Watched(NamedTuple):
    """Un descriptor ya verificado y el `fstat` de lo que se abrió DE VERDAD.

    Se devuelve el fstat del descriptor y no un `stat()` por ruta para que el
    sensor mida el inodo que va a leer y no el que en este milisegundo tiene ese
    nombre.
    """
    fd: int
    info: os.stat_result


@contextmanager
def open_watched(raw_path: Any, *, allow_directory: bool = False,
                 field_name: str = "path") -> Iterator[Watched]:
    """Abre lo vigilado para ESTA muestra, clasificándolo de nuevo.

    Un sensor con ruta guarda la ruta CRUDA y pasa por acá en cada `sample()`.
    Clasificar una sola vez al armar no alcanza, y no es teoría: se reprodujo en
    vivo de dos formas contra el sidecar corriendo, y las dos terminaban con el
    sensor leyendo un `.env`.

      (a) el symlink colgado. `paths.resolve()` camina al ancestro que EXISTE,
          así que un link cuyo destino todavía no existe se resuelve a sí mismo y
          pasa la clasificación con su propio basename inocente; cuando el
          destino aparece, el sensor lo sigue.
      (b) la rotación. Se arma sobre un archivo de verdad y después alguien lo
          reemplaza por un symlink. No hace falta ningún link colgado, y es
          exactamente la forma que tiene una rotación de logs.

    Acá pesa más que en el agente, cuyo `classify()` corre milisegundos antes de
    cada lectura: el sidecar convierte la carrera en una lectura PROGRAMADA y
    repetida, una por período, durante horas.

    Re-clasificar es la mitad obvia y sola no cierra nada: entre `classify()` y
    `open()` hay dos syscalls y ahí adentro se puede cambiar un directorio del
    medio. Por eso son tres cosas y no una:

      1. se clasifica la ruta cruda de nuevo, ahora;
      2. se abre con O_NOFOLLOW, que hace fallar el open si el ÚLTIMO componente
         se volvió un symlink en el medio; y con O_NONBLOCK, para que un FIFO no
         cuelgue el open para siempre (un watch colgado es un watch que el
         usuario cree armado);
      3. se clasifica lo que DE VERDAD se abrió, preguntándole al kernel el
         nombre del descriptor, y recién ahí se lee. Esto es lo que tapa el
         cambio de un directorio del MEDIO, que O_NOFOLLOW no mira.

    Lo que QUEDA abierto, escrito acá para que nadie vuelva a creer que no queda
    nada (creerlo es como llegamos a esto):

      * la ventana entre clasificar y abrir sigue existiendo. Lo que cambia es
        que adentro de la ventana no se lee nada: lo que se lee sale del
        descriptor y el descriptor se clasifica DESPUÉS de abrirlo, así que
        perder la carrera es un `SensorFault` y no una lectura.
      * un hardlink no se ve. La denylist es por NOMBRE y un hardlink le da al
        mismo inodo un segundo nombre inocente. Es un agujero del modelo de
        políticas del agente entero, no de este archivo, y se cierra donde se
        decidió que la política fuera por ruta.
      * un bind mount tampoco, y es la MISMA clase que el hardlink: `mount --bind
        ~/.ssh/id_rsa /home/yo/train.log` le da al archivo denegado un nombre
        permitido, y /proc confirma ese nombre porque es el que tiene. Hoy no es
        alcanzable sin privilegios (CAP_SYS_ADMIN, o un user namespace propio),
        así que no cambia el modelo de amenazas de esta fase; está escrito por lo
        mismo que los otros: esta lista existe para que nadie vuelva a concluir
        que no queda nada.
      * hace falta /proc. Sin él no hay con qué saber qué se abrió, y entonces el
        sensor falla CERRADO, que es la dirección segura.
    """
    resolved = _classify_now(raw_path, field_name)
    fd = _open_nofollow(resolved)
    try:
        info = os.fstat(fd)
        if not (stat.S_ISREG(info.st_mode) or (allow_directory and stat.S_ISDIR(info.st_mode))):
            # Un FIFO, un socket o un device no son lo que nadie quiso vigilar, y
            # leerlos tiene efectos (un FIFO consume lo que otro escribió).
            raise SensorFault(NOT_A_FILE)
        _verify_opened(fd, field_name)
        yield Watched(fd, info)
    finally:
        os.close(fd)


def _classify_now(raw_path: Any, field_name: str) -> str:
    """La clasificación de esta muestra. Denegada AHORA es sensor roto, no error.

    `SensorFault` y no `SensorError` a propósito: "no pude leer" es transitorio y
    deja el watch tiqueando, o sea reintentando la misma lectura denegada cada
    período. Que la ruta vigilada pase a apuntar a un archivo denegado no se
    arregla solo y no se debe reintentar: el watch termina y se dice por qué.
    """
    try:
        return classify_path(raw_path, field_name)
    except DeniedPath as exc:
        # La razón entera (con la ruta) va al log y NO a la excepción: ver el
        # comentario de PATH_TURNED_DENIED.
        logger.warning(f"la ruta de un watch quedó denegada en pleno vuelo: {exc}")
        raise SensorFault(PATH_TURNED_DENIED) from exc
    except SpecError as exc:
        # La tabla se cayó (AssetMissing) o la ruta dejó de ser una ruta. Sin
        # tabla no hay con qué decidir, así que no se lee.
        logger.warning(f"no se pudo clasificar la ruta de un watch: {exc}")
        raise SensorFault(PATH_TURNED_DENIED) from exc


def _open_nofollow(resolved: str) -> int:
    """Abre sin seguir el último componente y sin poder colgarse."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    try:
        return os.open(resolved, flags)
    except FileNotFoundError as exc:
        # Transitorio a propósito: una rotación de logs deja el archivo sin
        # existir por un instante. Si de verdad no vuelve, el watch se declara
        # `blind` y lo dice, que es lo honesto; decir "se paró" sería afirmar algo
        # que este sensor no pudo ver.
        raise SensorError("el archivo no está") from exc
    except PermissionError as exc:
        # Esto no se arregla solo: el sensor no va a poder leer nunca.
        raise SensorFault("sin permiso para leer el archivo") from exc
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            # El último componente es un symlink. O alguien lo cambió justo en la
            # ventana, o se armó sobre un link colgado (que no resuelve a nada, y
            # entonces no hay nada que vigilar). Las dos son "no pude leer": no se
            # leyó ni un byte, la próxima muestra vuelve a resolver, y si sigue
            # así el watch se declara ciego, que es la verdad.
            raise SensorError("la ruta pasó a ser un symlink") from exc
        raise SensorError(f"no se pudo leer: {exc.__class__.__name__}") from exc


def _verify_opened(fd: int, field_name: str) -> None:
    """Clasifica lo que se abrió DE VERDAD, que es lo único que se va a leer.

    El nombre sale del kernel (/proc/self/fd/N), no de lo que se pidió abrir, así
    que un directorio del medio cambiado entre `classify()` y `open()` aparece
    acá con su nombre real.
    """
    try:
        actual = os.readlink(f"/proc/self/fd/{fd}")
    except OSError as exc:
        raise SensorFault(UNVERIFIABLE) from exc
    if actual.endswith(_DELETED):
        # Sin sacar el sufijo, las reglas por basename (`.env`, `id_rsa`) dejan de
        # matchear y un unlink bien puesto saltea esta verificación entera.
        actual = actual[: -len(_DELETED)]
    _classify_now(actual, field_name)


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

    NO se anuncia y NO se puede armar por HTTP: `test_only` lo saca de
    `public_kinds()` y hace que `build()` lo trate como un kind inventado, salvo
    que la suite abra la costura con `allow_test_sensors()`. Sin eso aparecía en
    `/v1/capabilities`, o sea en el vocabulario que Hannah aprende, y un POST con
    `kind: "stub"` devolvía 201 y se comía uno de los dos cupos.
    """

    kind = "stub"
    rung = None
    confidence = DETERMINISTIC
    test_only = True

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "StubSensor":
        return cls()

    async def sample(self) -> Sample:
        return Sample(healthy=True, detail={"stub": True})
