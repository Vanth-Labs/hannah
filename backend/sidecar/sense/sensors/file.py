# sidecar/sense/sensors/file.py
"""R2 — el mtime de un archivo dejó de avanzar.

El escalón que contesta "el entrenamiento se paró" sin saber nada del
entrenamiento: si el log o el checkpoint no crecen hace cinco minutos, algo pasó.
Es el predicado que Hannah lee de vuelta en voz alta al armar (asunción A1), así
que `stallSeconds` lo elige el usuario y no un default escondido.

Sin subproceso: es un `stat`, no un programa. El plan lo escribe como
`stat -c %Y` porque describe el costo, no la implementación; un fork por sample
por watch para leer un st_mtime que la libc ya sabe contestar sería gasto puro.
Por eso R2 no pide ninguna herramienta en capability.TOOLS.
"""
import os
import time
from typing import Any, Mapping

from .base import DETERMINISTIC, Sample, Sensor, SensorError, SensorFault, SpecError, classify_path, register

# Cotas de stallSeconds. El piso evita el watch que dispara con cualquier pausa
# normal de escritura; el techo (un día) evita el que nunca dispara y que el
# usuario cree armado.
MIN_STALL_SECONDS = 5
MAX_STALL_SECONDS = 24 * 60 * 60


@register
class FileSensor(Sensor):
    """`{ "kind": "file", "path": "...", "stallSeconds": N }`."""

    kind = "file"
    rung = "R2"
    confidence = DETERMINISTIC

    def __init__(self, path: str, stall_seconds: int) -> None:
        self._path = path
        self._stall_seconds = stall_seconds
        #: Piso de "última señal de vida" que impone una re-basificación.
        self._floor: float = 0.0

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "FileSensor":
        path = classify_path(spec.get("path"))
        stall = spec.get("stallSeconds")
        if not isinstance(stall, int) or isinstance(stall, bool):
            raise SpecError("stallSeconds tiene que ser un entero en segundos")
        if stall < MIN_STALL_SECONDS or stall > MAX_STALL_SECONDS:
            raise SpecError(f"stallSeconds tiene que estar entre {MIN_STALL_SECONDS} y {MAX_STALL_SECONDS}")
        return cls(path, stall)

    def rebaseline(self) -> None:
        """Después de una suspensión, el instante de despertar cuenta como señal
        de vida.

        Sin esto el laptop que duerme dos horas despierta con `now - mtime` de
        dos horas y el watch dispara en cuanto junta debounceN muestras, aunque
        el proceso vigilado también estuviera congelado y esté por seguir. Con
        esto el trabajo tiene sus `stallSeconds` completos para volver a escribir.
        """
        self._floor = time.time()

    async def sample(self) -> Sample:
        try:
            info = os.stat(self._path)
        except FileNotFoundError as exc:
            # Transitorio a propósito: una rotación de logs deja el archivo sin
            # existir por un instante. Si de verdad no vuelve, el watch se
            # declara `blind` y lo dice, que es lo honesto; decir "se paró"
            # sería afirmar algo que este sensor no pudo ver.
            raise SensorError("el archivo no está") from exc
        except PermissionError as exc:
            # Esto no se arregla solo: el sensor no va a poder leer nunca.
            raise SensorFault("sin permiso para leer el archivo") from exc
        except OSError as exc:
            raise SensorError(f"no se pudo leer: {exc.__class__.__name__}") from exc

        now = time.time()
        # El piso de re-basificación compite con el mtime: gana el más reciente.
        last_progress = max(info.st_mtime, self._floor)
        idle = max(0.0, now - last_progress)
        # `idleSeconds` es una duración, no un contenido: no dice qué archivo es
        # ni qué tiene adentro (regla R2).
        return Sample(healthy=idle < self._stall_seconds,
                      detail={"idleSeconds": round(idle, 1), "stallSeconds": self._stall_seconds})
