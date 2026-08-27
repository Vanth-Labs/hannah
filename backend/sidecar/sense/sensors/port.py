# sidecar/sense/sensors/port.py
"""R5 — algo sigue escuchando en un puerto (`ss`).

Cinco milisegundos y una respuesta binaria. Su falso positivo es el servicio que
tarda en bindear: por eso el predicado se lee de vuelta al armar y por eso el
debounce del scheduler existe, porque un arranque lento no es una caída.
"""
from typing import Any, Mapping

import capability
from .base import DETERMINISTIC, Sample, Sensor, SensorFault, SpecError, register, run_argv


@register
class PortSensor(Sensor):
    """`{ "kind": "port", "port": N }` — sano mientras alguien escuche ahí."""

    kind = "port"
    rung = "R5"
    confidence = DETERMINISTIC

    def __init__(self, port: int, ss: str) -> None:
        self._port = port
        self._ss = ss

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "PortSensor":
        port = spec.get("port")
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            # El rango se valida acá y no en el filtro de ss: es lo que hace que
            # el filtro sea siempre sintácticamente válido, así que un error de
            # ss pasa a significar "ss falló" y nunca "el usuario escribió mal".
            raise SpecError("port tiene que ser un entero entre 1 y 65535")
        try:
            ss = capability.require("ss", "vigilar un puerto (R5)")
        except LookupError as exc:
            raise SpecError(str(exc)) from exc
        return cls(port, ss)

    async def sample(self) -> Sample:
        # -H sin encabezado, -l sólo escuchando, -n sin resolver nombres (una
        # resolución DNS colgada convertiría el sample en un timeout), -t -u TCP
        # y UDP. El filtro va como UN argumento: es sintaxis de ss, no de shell.
        done = await run_argv([self._ss, "-H", "-l", "-n", "-t", "-u", f"sport = :{self._port}"])
        if done.code != 0:
            raise SensorFault(f"ss terminó en {done.code}")
        # Se cuentan líneas y no se devuelve ninguna: una fila de ss lleva
        # direcciones, y una dirección es un host (regla R2).
        listeners = len([line for line in done.out.splitlines() if line.strip()])
        return Sample(healthy=listeners > 0, detail={"listening": listeners > 0, "sockets": listeners})
