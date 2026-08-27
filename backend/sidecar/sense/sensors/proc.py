# sidecar/sense/sensors/proc.py
"""R1 — el proceso sigue vivo (`pgrep -f`).

El escalón más barato que existe y el primero que hay que probar: un milisegundo
y una respuesta que no admite interpretación. Sus dos modos de falsear están en
la tabla del plan §6 y valen la pena decirlos en voz alta al armar: el PID se
puede reusar, y un wrapper vivo alrededor de un hijo muerto se ve sano.
"""
import re
from typing import Any, Mapping

import capability
from .base import DETERMINISTIC, Sample, Sensor, SensorFault, SpecError, register, run_argv

# Cota del patrón: viaja como UN argumento a pgrep, que además tiene su propio
# techo de expresión regular. Un patrón de 10 KB no es una vigilancia, es un
# intento de ver qué se rompe.
MAX_PATTERN_CHARS = 200

# pgrep(1): 0 hubo match, 1 no hubo, 2 error de sintaxis, 3 error fatal.
_NO_MATCH = 1


@register
class ProcSensor(Sensor):
    """`{ "kind": "proc", "pattern": "..." }` — sano mientras algo matchee."""

    kind = "proc"
    rung = "R1"
    confidence = DETERMINISTIC

    def __init__(self, pattern: str, pgrep: str) -> None:
        self._pattern = pattern
        self._pgrep = pgrep

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "ProcSensor":
        pattern = spec.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            raise SpecError("pattern es obligatorio")
        pattern = pattern.strip()
        if len(pattern) > MAX_PATTERN_CHARS:
            raise SpecError(f"pattern supera {MAX_PATTERN_CHARS} caracteres")
        if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in pattern):
            raise SpecError("pattern tiene caracteres de control")
        try:
            # Se compila acá para que un paréntesis sin cerrar sea un 400 al armar
            # y no un watch que se arma y falla en cada sample. No es la misma
            # sintaxis que la de pgrep (POSIX extendida), pero atrapa el 99% de
            # los errores de tipeo, que es de lo que se trata.
            re.compile(pattern)
        except re.error as exc:
            raise SpecError(f"pattern no es una expresión regular válida: {exc.msg}") from exc
        try:
            pgrep = capability.require("pgrep", "vigilar un proceso (R1)")
        except LookupError as exc:
            raise SpecError(str(exc)) from exc
        return cls(pattern, pgrep)

    async def sample(self) -> Sample:
        # `--` para que un patrón que arranca con guión sea un patrón y no una
        # opción de pgrep. Con argv no hay inyección posible, pero sí hay
        # confusión de opciones, que es la otra mitad del mismo problema.
        done = await run_argv([self._pgrep, "-c", "-f", "--", self._pattern])
        if done.code not in (0, _NO_MATCH):
            # 2 y 3 son "pgrep no entendió" o "pgrep no pudo": el sensor está
            # roto. Decir "el proceso murió" acá sería inventar un trip.
            raise SensorFault(f"pgrep terminó en {done.code}")
        count = 0
        if done.code == 0:
            first = done.out.strip().splitlines()[0] if done.out.strip() else "0"
            count = int(first) if first.isdigit() else 0
        # `count` es un contador, no una línea de ps: no lleva el cmdline de
        # nadie (regla R2).
        return Sample(healthy=count > 0, detail={"alive": count > 0, "count": count})
