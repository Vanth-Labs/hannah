# sidecar/sense/sensors/gpu.py
"""R4 — la GPU cayó por debajo de un porcentaje. CORROBORA, NUNCA DISPARA.

Es el único escalón de la escalera con una regla propia, y está en el plan §6 con
nombre y apellido: **checkpointing y un dataloader lento leen los dos 0 %**. Un
watch que dispara con "la GPU está en cero" relanzaría un entrenamiento que está
guardando el checkpoint de la época 12, y en una placa de 4 GB eso son dos
entrenamientos peleándose la memoria: el falso positivo no cuesta un aviso de
más, cuesta el trabajo que estaba andando bien.

Por eso `corroborating_only = True`, y por eso la prohibición vive en
`base.build()`, que rechaza cualquier watch cuyo único sensor sea corroborante,
y no en un comentario que alguien puede no leer. Test:
`test_sensors.py::test_gpu_no_puede_armar_sola`.

El sensor existe igual —y se registra— porque P5.2 arma watches multi-sensor: la
GPU en cero AL LADO de un mtime parado es evidencia, la GPU en cero sola no es
nada.
"""
import time
from typing import Any, Mapping

import capability
from .base import CORROBORATED, Sample, Sensor, SensorError, SensorFault, SpecError, register, run_argv

MAX_INDEX = 15
MIN_FOR_SECONDS = 5
MAX_FOR_SECONDS = 60 * 60


@register
class GpuSensor(Sensor):
    """`{ "kind": "gpu", "index": N, "belowPercent": N, "forSeconds": N }`."""

    kind = "gpu"
    rung = "R4"
    confidence = CORROBORATED
    corroborating_only = True

    def __init__(self, index: int, below_percent: int, for_seconds: int, nvidia_smi: str) -> None:
        self._index = index
        self._below_percent = below_percent
        self._for_seconds = for_seconds
        self._nvidia_smi = nvidia_smi
        #: Desde cuándo está por debajo del umbral, o None si no lo está.
        self._below_since: float | None = None

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "GpuSensor":
        index = spec.get("index", 0)
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= MAX_INDEX:
            raise SpecError(f"index tiene que ser un entero entre 0 y {MAX_INDEX}")
        below = spec.get("belowPercent")
        if not isinstance(below, int) or isinstance(below, bool) or not 0 <= below <= 100:
            raise SpecError("belowPercent tiene que ser un entero entre 0 y 100")
        for_seconds = spec.get("forSeconds")
        if not isinstance(for_seconds, int) or isinstance(for_seconds, bool):
            raise SpecError("forSeconds tiene que ser un entero en segundos")
        if not MIN_FOR_SECONDS <= for_seconds <= MAX_FOR_SECONDS:
            raise SpecError(f"forSeconds tiene que estar entre {MIN_FOR_SECONDS} y {MAX_FOR_SECONDS}")
        try:
            nvidia_smi = capability.require("nvidia-smi", "corroborar con la GPU (R4)")
        except LookupError as exc:
            raise SpecError(str(exc)) from exc
        return cls(index, below, for_seconds, nvidia_smi)

    def rebaseline(self) -> None:
        """Al despertar de una suspensión no se sabe nada de la GPU: la ventana
        de "lleva N segundos en cero" arranca de nuevo."""
        self._below_since = None

    async def sample(self) -> Sample:
        done = await run_argv([
            self._nvidia_smi,
            f"--id={self._index}",
            "--query-gpu=utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        if done.code != 0:
            # Un índice que no existe, el driver que no cargó: el sensor está
            # roto. No es "la GPU está en cero".
            raise SensorFault(f"nvidia-smi terminó en {done.code}")
        first = done.out.strip().splitlines()[0].strip() if done.out.strip() else ""
        if not first.isdigit():
            # "[N/A]" en una GPU sin soporte de utilización, o una salida que
            # cambió de forma: no se pudo leer, no se inventa un número.
            raise SensorError("nvidia-smi no devolvió un porcentaje")
        percent = int(first)

        now = time.time()
        if percent >= self._below_percent:
            self._below_since = None
        elif self._below_since is None:
            self._below_since = now
        below_for = 0.0 if self._below_since is None else now - self._below_since
        return Sample(
            healthy=self._below_since is None or below_for < self._for_seconds,
            detail={"percent": percent, "belowForSeconds": round(below_for, 1)},
        )
