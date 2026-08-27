# sidecar/sense/sensors/__init__.py
"""El catálogo de sensores y la escalera de detección (plan VIGILANCE §6).

El contrato de un sensor vive en `base.py`; acá está qué escalones existen, cuál
implementa cada uno y cuáles puede armar ESTA máquina hoy.

La regla del catálogo de macros, aplicada a la escalera: **un escalón que no se
puede cumplir no se anuncia.** El backend arma el vocabulario de `[WATCH:]` con
`capabilities()` (M5.1.3), así que anunciar un escalón sin su herramienta es
hacer que Hannah prometa una vigilancia que después no arma. Es la diferencia
entre "no puedo vigilar eso" dicho antes y una falla dicha después.
"""
import capability
import paths

from .base import (  # noqa: F401  (superficie pública del módulo `sensors`)
    CORROBORATED,
    DETERMINISTIC,
    HEURISTIC,
    Completed,
    DeniedPath,
    Sample,
    Sensor,
    SensorError,
    SensorFault,
    SpecError,
    SENSORS,
    build,
    classify_path,
    register,
    run_argv,
)
# Importados por su efecto: cada módulo se registra en SENSORS al importarse.
from . import file, gpu, logmatch, port, proc, unit  # noqa: F401,E402

# La escalera, en orden y con el kind que la implementa. R0 (el exit code de un
# wrapper que arrancó Hannah) NO está, y no es un olvido: en una fase de solo
# observar el sidecar no arranca nada, así que no hay wrapper cuyo exit code
# mirar. El contrato sense.v1 fija el enum de ids en R1..R10, así que la fila no
# se emite; la razón está escrita en capability.R0_ABSENT_REASON y en el README.
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
    "R6b": "el caso remoto llega en P5.3 y está apagado (SENSE_SSH_ENABLED)",
    "R7": "AT-SPI llega en P5.6 y depende del spike de cobertura",
    "R8": "la pantalla llega en P5.5 y se entrega apagada (SENSE_SCREEN_ENABLED)",
    "R9": "la pantalla llega en P5.5; además tesseract no está instalado",
    "R10": "la pantalla llega en P5.5 y depende de VRAM libre y de un modelo bajado",
}

#: Escalones que necesitan clasificar una ruta antes de mirarla. Sin la tabla del
#: agente no pueden armar (fallan cerrado), así que tampoco se anuncian.
_NEEDS_PATHS = frozenset({"R2", "R3"})


def _reason(rung_id: str, kind: str, resolve: capability.Resolver | None,
            no_paths: str | None) -> str | None:
    """La razón por la que el escalón no está disponible, o None si está.

    El orden de las razones es el orden en que el operador las puede accionar:
    primero "no existe todavía" (nada que hacer), después "solo corrobora" (es
    una regla, no una falta), después "falta esta herramienta" (instalable) y por
    último "falta la tabla de rutas" (configurable).
    """
    if kind not in SENSORS:
        return _PENDING.get(rung_id, "sensor no disponible en esta máquina")
    if SENSORS[kind].corroborating_only:
        # R4 no puede armar sola por diseño (ver gpu.py). Anunciarla como
        # disponible haría que Hannah ofreciera un watch de GPU que el POST
        # rechaza con 400: prometido y no cumplido, que es justo lo que la regla
        # del catálogo prohíbe.
        return "solo corrobora otro escalón: todavía no hay watch multi-sensor (P5.2)"
    gap = capability.tool_reason(rung_id, resolve)
    if gap:
        return gap
    if rung_id in _NEEDS_PATHS and no_paths:
        return no_paths
    return None


def capabilities(resolve: capability.Resolver | None = None) -> dict[str, object]:
    """Lo que ESTA máquina puede vigilar hoy, en la forma del contrato sense.v1.

    `rungs[].available` es la autoridad sobre qué se puede armar. `sensors` es el
    enum CERRADO de kinds que el proceso conoce, que no es lo mismo: `gpu` está
    en la lista y su escalón no está disponible, porque el kind existe (P5.2 lo
    va a usar para corroborar) y armar un watch de GPU sola no.

    `resolve` es inyectable para los tests: leer el estado real de la máquina en
    un fixture es lo que hace que un test pase donde se escribió y falle en la
    máquina de al lado.
    """
    no_paths = paths.unavailable()
    rungs = []
    for rung_id, kind, _summary in LADDER:
        reason = _reason(rung_id, kind, resolve, no_paths)
        entry: dict[str, object] = {"id": rung_id, "available": reason is None}
        if reason:
            entry["reason"] = reason
        rungs.append(entry)
    return {"rungs": rungs, "sensors": sorted(SENSORS)}


def rung_of(kind: str) -> str | None:
    """Escalón que le corresponde a un kind, o None (el stub no tiene)."""
    sensor = SENSORS.get(kind)
    return sensor.rung if sensor else None
