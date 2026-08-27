# sidecar/sense/scheduler.py
"""Una corrutina por watch: tiquea, muestrea y decide si hay trip.

La forma está copiada de backend/src/pipeline/visionLoop.js: cadencia fija más
un guardia de reentrada (`is_sampling`), de modo que un sample lento NO apila
samples encima; el tick que cae mientras el anterior sigue corriendo se descarta.
Sin eso, un sensor que tarda más que el período termina con N lecturas en vuelo
sobre la misma cosa y el debounce cuenta muestras que se pisan.

Tres reglas que valen más que el código:

* Un sample que FALLA no es un trip. `samples_failed` sube, `streak` no. Un
  sensor que no pudo leer no tiene derecho a decir que el entrenamiento se paró;
  si no puede leer por mucho tiempo, el watch se declara `blind` y lo dice.
* Un salto de reloj mayor a dos períodos descarta un ciclo y re-basea (plan §6).
  Sin esto, cada suspensión del laptop dispara TODOS los watches al despertar:
  todo mtime, toda GPU y todo crecimiento se ven parados.
* Todo watch que sale del conjunto vivo emite exactamente UN `watch.disarmed`
  como último evento, precedido por el evento específico que dice por qué
  (`watch.expired` o `watch.faulted`). El backend puede así limpiar con una sola
  regla y aun así narrar el motivo.
"""
import asyncio
import contextlib
import logging

import sensors
from config import BLIND_MS, SAMPLE_TIMEOUT_MS
from events import EventBus
from registry import OBSERVE_TIER, Registry, Watch, now_ms

logger = logging.getLogger(__name__)


class _Tick:
    """Estado mutable del ciclo de un watch (el `state` de visionLoop.js)."""

    def __init__(self, started_at: int) -> None:
        self.is_sampling = False
        self.last_tick_at = started_at


class Scheduler:
    def __init__(self, registry: Registry, bus: EventBus) -> None:
        self._registry = registry
        self._bus = bus
        self._tasks: dict[str, asyncio.Task] = {}

    # ── Ciclo de vida ───────────────────────────────────────────────────────
    def arm(self, watch: Watch) -> None:
        """Arma un watch ya validado y lo pone a tiquear."""
        watch.state = "armed"
        self._bus.publish(watch.watch_id, "watch.armed", {
            "label": watch.label,
            "rung": watch.rung,
            "sensorKind": watch.sensor_kind,
            "periodMs": watch.period_ms,
            "expiresAt": watch.expires_at,
            # En esta fase el tier es siempre "observe": el sidecar no actúa (regla R1).
            "tier": OBSERVE_TIER,
        })
        self._tasks[watch.watch_id] = asyncio.create_task(
            self._loop(watch), name=f"sense-watch-{watch.watch_id}")
        self._registry.save()

    async def disarm(self, watch: Watch, reason: str) -> None:
        """Desarma desde afuera (DELETE, o el apagado). Idempotente."""
        await self._cancel(watch.watch_id)
        if watch.state in ("armed", "blind", "suspended"):
            self._terminate(watch, state="disarmed", reason=reason)

    async def shutdown(self) -> None:
        """Corta todo, pero persiste ANTES de tocar estados.

        El orden importa: `save()` guarda los watches vivos, y si primero los
        marcara desarmados el archivo quedaría vacío y no volverían como
        `suspended` en el próximo arranque (asunción A4).
        """
        for watch_id in list(self._tasks):
            await self._cancel(watch_id)
        self._registry.save()
        # Solo se anuncian las que estaban mirando: una `suspended` nunca emitió
        # `watch.armed`, así que un `watch.disarmed` suyo sería el primer evento
        # que el backend ve de ese watch y no significaría nada.
        for watch in self._registry.sampling():
            self._bus.publish(watch.watch_id, "watch.disarmed",
                              {"label": watch.label, "reason": "shutdown"})

    async def _cancel(self, watch_id: str) -> None:
        task = self._tasks.pop(watch_id, None)
        if not task or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    def _terminate(self, watch: Watch, state: str, reason: str, error: str | None = None) -> None:
        watch.state = state
        watch.disarm_reason = reason
        if state == "expired":
            self._bus.publish(watch.watch_id, "watch.expired", {"label": watch.label})
        elif state == "faulted":
            self._bus.publish(watch.watch_id, "watch.faulted",
                              {"label": watch.label, "error": error or "sensor roto"})
        self._bus.publish(watch.watch_id, "watch.disarmed",
                          {"label": watch.label, "reason": reason})
        self._tasks.pop(watch.watch_id, None)
        self._registry.save()

    # ── El tick ─────────────────────────────────────────────────────────────
    async def _loop(self, watch: Watch) -> None:
        try:
            sensor = sensors.build(watch.sensor_spec)
        except sensors.SpecError as exc:
            # El spec ya se validó al armar; si falla acá el sensor está roto
            # (por ejemplo la unidad de systemd que nombraba ya no existe).
            self._terminate(watch, state="faulted", reason="faulted", error=str(exc))
            return

        period = watch.period_ms / 1000
        tick = _Tick(started_at=now_ms())
        # El reloj de la ceguera arranca al armar: si el primer sample nunca
        # llega, el watch tiene que declararse ciego igual.
        watch.last_ok_at = watch.last_ok_at or tick.last_tick_at

        while True:
            await asyncio.sleep(period)
            now = now_ms()

            # La expiración se mira en el tick, así que puede llegar hasta un
            # período tarde; por eso parse_create exige expiresAt - now >= periodMs.
            if now >= watch.expires_at:
                self._terminate(watch, state="expired", reason="expired")
                return

            drift = now - tick.last_tick_at
            tick.last_tick_at = now
            if drift > 2 * watch.period_ms:
                # El laptop durmió (o el proceso se quedó sin CPU). Se descarta el
                # ciclo, se re-basea el sensor y se corre el reloj de ceguera: si
                # no, al despertar todo se ve parado y todos los watches disparan.
                logger.info(f"salto de reloj de {drift} ms en {watch.watch_id}; descarto un ciclo")
                watch.streak = 0
                watch.last_ok_at = now
                with contextlib.suppress(Exception):
                    sensor.rebaseline()
                continue

            if watch.state == "armed" and watch.last_ok_at is not None \
                    and now - watch.last_ok_at >= BLIND_MS:
                self._go_blind(watch, now)

            if tick.is_sampling:
                # Sample más lento que el período: se pierde el tick, no se apila.
                logger.warning(f"sample todavía corriendo en {watch.watch_id}; salteo el tick")
                continue

            tick.is_sampling = True
            try:
                alive = await self._sample(watch, sensor)
            finally:
                tick.is_sampling = False
            if not alive:
                return

    async def _sample(self, watch: Watch, sensor: sensors.Sensor) -> bool:
        """Toma una muestra. Devuelve False cuando el watch terminó (sensor roto)."""
        now = now_ms()
        try:
            sample = await asyncio.wait_for(sensor.sample(), timeout=SAMPLE_TIMEOUT_MS / 1000)
        except asyncio.TimeoutError:
            self._sample_failed(watch, "sample timed out")
            return True
        except sensors.SensorFault as exc:
            self._terminate(watch, state="faulted", reason="faulted", error=str(exc))
            return False
        except sensors.SensorError:
            self._sample_failed(watch, "sensor error")
            return True
        except Exception:
            # Un bug del sensor no puede tirar el proceso ni frenar los otros watches.
            logger.exception(f"sensor {watch.sensor_kind} rompió en {watch.watch_id}")
            self._sample_failed(watch, "sensor error")
            return True

        watch.samples_ok += 1
        watch.last_sample_at = now
        watch.last_ok_at = now
        if watch.state == "blind":
            watch.state = "armed"
            self._bus.publish(watch.watch_id, "watch.recovered", {"label": watch.label})

        if sample.healthy:
            watch.streak = 0
            return True

        watch.streak += 1
        if watch.streak < watch.debounce_n:
            return True
        watch.streak = 0
        watch.fires += 1
        self._bus.publish(watch.watch_id, "watch.tripped", {
            "label": watch.label,
            "rung": watch.rung,
            "confidence": sensor.confidence,
            "at": now,
            "fires": watch.fires,
        })
        return True

    def _sample_failed(self, watch: Watch, reason: str) -> None:
        """Muestra fallada: sube el contador y nada más.

        `streak` NO se toca: si se contara como "no sano", un sensor roto
        inventaría un trip cada debounce_n intentos, que es la peor mentira que
        puede decir esta feature.
        """
        watch.samples_failed += 1
        watch.last_sample_at = now_ms()
        watch.last_error = reason

    def _go_blind(self, watch: Watch, now: int) -> None:
        watch.state = "blind"
        since = now - (watch.last_ok_at or now)
        # `reason` es vocabulario fijo, no el texto de la excepción: un mensaje de
        # error lleva rutas y las rutas no salen de este proceso (regla R2).
        self._bus.publish(watch.watch_id, "watch.blind", {
            "label": watch.label,
            "sinceMs": since,
            "reason": watch.last_error or "sin muestras",
        })
