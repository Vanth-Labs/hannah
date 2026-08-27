# sidecar/sense/sensors/unit.py
"""R6 — una unidad de systemd sigue activa (`systemctl show`).

El escalón sin falsos positivos de la tabla del plan §6: systemd sabe si la
unidad está corriendo, no hay que adivinarlo.

Se usa `show` y no `is-active` por una razón que es justo la distinción que esta
milestone tiene que dejar bien puesta: `systemctl is-active loquesea.service`
contesta "inactive" tanto para una unidad que se cayó como para una que NUNCA
EXISTIÓ, y las dos cosas no son lo mismo. Una unidad caída es un trip; un nombre
mal escrito es un sensor roto, o sea `watch.faulted`. `show` devuelve LoadState y
ActiveState de una sola pasada y permite separarlas.

Alcance: el bus del sistema. El contrato sense.v1 fija el spec en
`{ kind: "unit", unit }` sin campo de alcance, así que una unidad `--user` no se
puede vigilar en esta fase; cuando haga falta es un campo nuevo en el contrato,
no una adivinanza acá.
"""
import re
from typing import Any, Mapping

import capability
from .base import DETERMINISTIC, Sample, Sensor, SensorError, SensorFault, SpecError, register, run_argv

# Nombre de unidad de systemd: lo que systemd.unit(5) acepta, más el sufijo.
# Se valida al armar para que un nombre raro sea un 400 y no una llamada rara.
_UNIT = re.compile(r"^[A-Za-z0-9:_.\\@-]{1,200}"
                   r"\.(service|socket|timer|target|mount|path|slice|scope|device|swap)$")

# Estados que cuentan como "la unidad está haciendo lo suyo". `activating` está
# adentro a propósito: un servicio que arranca lento no se cayó, y contarlo como
# caído es exactamente el falso positivo que el debounce no alcanza a tapar
# cuando el arranque tarda más que period * debounceN.
HEALTHY_STATES = frozenset({"active", "activating", "reloading"})


@register
class UnitSensor(Sensor):
    """`{ "kind": "unit", "unit": "algo.service" }`."""

    kind = "unit"
    rung = "R6"
    confidence = DETERMINISTIC

    def __init__(self, unit: str, systemctl: str) -> None:
        self._unit = unit
        self._systemctl = systemctl

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "UnitSensor":
        unit = spec.get("unit")
        if not isinstance(unit, str) or not _UNIT.match(unit.strip()):
            raise SpecError("unit tiene que ser un nombre de unidad de systemd (por ejemplo docker.service)")
        try:
            systemctl = capability.require("systemctl", "vigilar una unidad (R6)")
        except LookupError as exc:
            raise SpecError(str(exc)) from exc
        return cls(unit.strip(), systemctl)

    async def sample(self) -> Sample:
        done = await run_argv([self._systemctl, "show", self._unit,
                               "--property=LoadState", "--property=ActiveState"])
        if done.code != 0:
            raise SensorError(f"systemctl terminó en {done.code}")
        fields = dict(
            line.split("=", 1) for line in done.out.splitlines() if "=" in line
        )
        load_state = fields.get("LoadState", "").strip()
        active_state = fields.get("ActiveState", "").strip()
        if not load_state or not active_state:
            raise SensorError("systemctl no devolvió LoadState/ActiveState")
        if load_state == "not-found":
            # El sensor está roto: la unidad que se nombró no existe. Decir que
            # "se cayó" sería llorar lobo por un error de tipeo.
            raise SensorFault("la unidad no existe")
        if load_state == "masked":
            raise SensorFault("la unidad está enmascarada")
        # Los dos estados son enums de systemd, no texto de nadie: se pueden
        # devolver sin violar la regla R2.
        return Sample(healthy=active_state in HEALTHY_STATES,
                      detail={"activeState": active_state, "loadState": load_state})
