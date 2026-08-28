# sidecar/sense/sensors/port.py
"""R5 — algo sigue escuchando en un puerto (`ss`; `lsof` en macOS; psutil en Windows).

Cinco milisegundos y una respuesta binaria. Su falso positivo es el servicio que
tarda en bindear: por eso el predicado se lee de vuelta al armar y por eso el
debounce del scheduler existe, porque un arranque lento no es una caída.
"""
import asyncio
import socket
from typing import Any, Mapping

import capability
from .base import DETERMINISTIC, Sample, Sensor, SensorFault, SpecError, register, run_argv


@register
class PortSensor(Sensor):
    """`{ "kind": "port", "port": N }` — sano mientras alguien escuche ahí."""

    kind = "port"
    rung = "R5"
    confidence = DETERMINISTIC

    def __init__(self, port: int, tool: str | None, strategy: str = "ss") -> None:
        self._port = port
        self._tool = tool            # ss, lsof, o None (psutil)
        self._strategy = strategy    # "ss" | "lsof" | "psutil"

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "PortSensor":
        port = spec.get("port")
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            # El rango se valida acá y no en el filtro de ss: es lo que hace que
            # el filtro sea siempre sintácticamente válido, así que un error de
            # ss pasa a significar "ss falló" y nunca "el usuario escribió mal".
            raise SpecError("port tiene que ser un entero entre 1 y 65535")
        try:
            which = capability.platform()
            if which == "win32":
                capability.require("python:psutil", "vigilar un puerto (R5)")
                return cls(port, None, "psutil")
            if which == "darwin":
                return cls(port, capability.require("lsof", "vigilar un puerto (R5)"), "lsof")
            return cls(port, capability.require("ss", "vigilar un puerto (R5)"), "ss")
        except LookupError as exc:
            raise SpecError(str(exc)) from exc

    def _count_psutil(self) -> int:
        """Windows: sockets locales en el puerto, TCP en LISTEN o UDP (sin estado)."""
        import psutil  # noqa: PLC0415
        count = 0
        for conn in psutil.net_connections(kind="inet"):
            if not conn.laddr or conn.laddr.port != self._port:
                continue
            if conn.type == socket.SOCK_DGRAM or conn.status == psutil.CONN_LISTEN:
                count += 1
        return count

    async def sample(self) -> Sample:
        if self._strategy == "psutil":
            try:
                listeners = await asyncio.to_thread(self._count_psutil)
            except Exception as exc:  # noqa: BLE001
                raise SensorFault(f"psutil falló: {exc.__class__.__name__}") from exc
            return Sample(healthy=listeners > 0, detail={"listening": listeners > 0, "sockets": listeners})
        if self._strategy == "lsof":
            # macOS: -t solo PIDs (una línea por socket, sin direcciones: regla R2), -n -P sin
            # resolver nombres ni puertos. TCP en LISTEN y UDP por separado, porque UDP no tiene
            # estado. lsof sale 1 cuando no encuentra nada: eso es "nadie escucha", no una falla.
            tcp = await run_argv([self._tool, "-t", "-n", "-P", f"-iTCP:{self._port}", "-sTCP:LISTEN"])
            udp = await run_argv([self._tool, "-t", "-n", "-P", f"-iUDP:{self._port}"])
            if tcp.code not in (0, 1) or udp.code not in (0, 1):
                raise SensorFault(f"lsof terminó en {tcp.code}/{udp.code}")
            listeners = len([l for l in (tcp.out + "\n" + udp.out).splitlines() if l.strip()])
            return Sample(healthy=listeners > 0, detail={"listening": listeners > 0, "sockets": listeners})
        # -H sin encabezado, -l sólo escuchando, -n sin resolver nombres (una
        # resolución DNS colgada convertiría el sample en un timeout), -t -u TCP
        # y UDP. El filtro va como UN argumento: es sintaxis de ss, no de shell.
        done = await run_argv([self._tool, "-H", "-l", "-n", "-t", "-u", f"sport = :{self._port}"])
        if done.code != 0:
            raise SensorFault(f"ss terminó en {done.code}")
        # Se cuentan líneas y no se devuelve ninguna: una fila de ss lleva
        # direcciones, y una dirección es un host (regla R2).
        listeners = len([line for line in done.out.splitlines() if line.strip()])
        return Sample(healthy=listeners > 0, detail={"listening": listeners > 0, "sockets": listeners})
