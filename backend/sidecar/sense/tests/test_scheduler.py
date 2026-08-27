# sidecar/sense/tests/test_scheduler.py
"""Cuándo hay trip, cuándo hay ceguera y cuándo hay sensor roto.

Las tres son distintas y confundirlas es lo que hace que un watch llore lobo:

* **trip** — el sensor leyó bien, debounceN veces seguidas, y lo que leyó dice
  que la cosa vigilada no está como estaba.
* **blind** — el sensor no pudo leer por más de SENSE_BLIND_MS. NO es un trip: un
  sensor que no pudo leer no tiene derecho a decir que el entrenamiento se paró.
  Hannah lo dice en voz alta, porque un watch que cree que está mirando y no está
  es la peor falla que tiene esta feature.
* **faulted** — el sensor mismo está roto (la unidad no existe, el archivo no se
  puede leer nunca). El watch termina; no se queda fingiendo.
"""
import asyncio

import pytest

import scheduler as scheduler_module
import sensors
from events import EventBus
from registry import Registry, Watch, now_ms
from scheduler import Scheduler


def run(coro):
    return asyncio.run(coro)


class GuionSensor(sensors.Sensor):
    """Sensor de guión: devuelve lo que le pongan, en orden."""

    kind = "guion"
    rung = "R1"

    def __init__(self, guion):
        self._guion = list(guion)
        self.rebaselines = 0
        self.samples = 0

    async def sample(self):
        self.samples += 1
        step = self._guion.pop(0) if self._guion else True
        if isinstance(step, Exception):
            raise step
        return sensors.Sample(healthy=step, detail={"guion": True})

    def rebaseline(self):
        self.rebaselines += 1


def watch(period_ms=20, debounce_n=3, ttl_ms=60_000):
    return Watch(
        watch_id="w_" + "a" * 24,
        label="el entrenamiento",
        sensor_spec={"kind": "stub"},
        sensor_kind="stub",
        rung="R1",
        period_ms=period_ms,
        debounce_n=debounce_n,
        expires_at=now_ms() + ttl_ms,
        session_id="s_1",
        narration=None,
        state="armed",
    )


def harness():
    registry = Registry()
    bus = EventBus()
    return registry, bus, Scheduler(registry, bus)


def types_of(bus):
    events, _ = bus.since(0)
    return [stored.envelope["type"] for stored in events]


async def _correr(sched, target, segundos):
    """Corre el bucle real un rato y lo corta. Los tests que necesitan el bucle
    (y no `_sample` suelto) son los del reloj, la ceguera y la expiración."""
    task = asyncio.create_task(sched._loop(target))
    await asyncio.sleep(segundos)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# ── Debounce ─────────────────────────────────────────────────────────────────
def test_una_muestra_mala_no_es_un_evento():
    """debounceN muestras seguidas de acuerdo. Una sola no alcanza: un pgrep que
    corre justo en el respawn vería el hueco de un proceso que está bien."""
    registry, bus, sched = harness()
    target = watch(debounce_n=3)
    registry.add(target)
    sensor = GuionSensor([False, False, False])

    for _ in range(2):
        run(sched._sample(target, sensor))
    assert types_of(bus) == []
    assert target.streak == 2

    run(sched._sample(target, sensor))     # la tercera seguida
    assert types_of(bus) == ["watch.tripped"]
    assert target.fires == 1


def test_una_muestra_sana_en_el_medio_corta_la_racha():
    registry, bus, sched = harness()
    target = watch(debounce_n=3)
    registry.add(target)
    sensor = GuionSensor([False, False, True, False, False])
    for _ in range(5):
        run(sched._sample(target, sensor))
    assert types_of(bus) == []
    assert target.streak == 2


def test_una_sola_caida_dispara_una_sola_vez():
    """El trip es la transición "estaba y dejó de estar", no el estado "no está".

    Sin el pestillo, un entrenamiento muerto emite un watch.tripped cada
    debounceN muestras para siempre: en la corrida real de aceptación, un
    logmatch con debounceN=1 y período de 15 s disparó TRES veces en 45 s por un
    único Traceback. A las 3am eso son ochenta avisos de lo mismo.
    """
    registry, bus, sched = harness()
    target = watch(debounce_n=2)
    registry.add(target)
    sensor = GuionSensor([False] * 12)
    for _ in range(12):
        run(sched._sample(target, sensor))
    assert types_of(bus) == ["watch.tripped"]
    assert target.fires == 1


def test_una_caida_nueva_despues_de_recuperarse_si_vuelve_a_disparar():
    """El pestillo lo abre una muestra sana: un crash-loop son transiciones de
    verdad, y acotarlas es el trabajo de maxFires (M5.2.3), no de este pestillo."""
    registry, bus, sched = harness()
    target = watch(debounce_n=1)
    registry.add(target)
    sensor = GuionSensor([False, False, True, False])
    for _ in range(4):
        run(sched._sample(target, sensor))
    assert types_of(bus) == ["watch.tripped", "watch.tripped"]
    assert target.fires == 2


def test_el_trip_no_lleva_ni_un_dato_de_la_muestra():
    """`watch.tripped` es label, escalón, confianza, instante y contador de
    disparos. Nada de lo leído: el backend lo narra y la persona lo lee."""
    registry, bus, sched = harness()
    target = watch(debounce_n=1)
    registry.add(target)
    run(sched._sample(target, GuionSensor([False])))
    events, _ = bus.since(0)
    assert set(events[0].envelope["data"]) == {"label", "rung", "confidence", "at", "fires"}
    assert events[0].envelope["data"]["confidence"] == sensors.DETERMINISTIC


# ── Ceguera contra sensor roto ───────────────────────────────────────────────
def test_una_muestra_fallada_no_cuenta_para_el_trip():
    """Si contara, un sensor roto inventaría un trip cada debounceN intentos:
    la peor mentira que puede decir esta feature."""
    registry, bus, sched = harness()
    target = watch(debounce_n=2)
    registry.add(target)
    sensor = GuionSensor([sensors.SensorError("no pude leer")] * 6)
    for _ in range(6):
        run(sched._sample(target, sensor))
    assert types_of(bus) == []
    assert target.streak == 0
    assert target.samples_failed == 6 and target.samples_ok == 0


def test_sin_muestras_buenas_el_watch_se_declara_ciego_y_lo_dice(monkeypatch):
    registry, bus, sched = harness()
    target = watch(period_ms=10, debounce_n=1)
    registry.add(target)
    monkeypatch.setattr(scheduler_module, "BLIND_MS", 30)

    # El spec del watch es `stub`, que siempre lee bien; se cambia por uno que
    # nunca puede leer para que el bucle real recorra el camino de la ceguera.
    monkeypatch.setattr(sensors, "build",
                        lambda spec: GuionSensor([sensors.SensorError("no pude leer")] * 100))
    run(_correr(sched, target, 0.25))

    assert target.state == "blind"
    assert types_of(bus) == ["watch.blind"]
    data = bus.since(0)[0][0].envelope["data"]
    assert set(data) == {"label", "sinceMs", "reason"}
    # `reason` es vocabulario fijo: el texto de una excepción lleva rutas.
    assert data["reason"] == "sensor error"


def test_el_watch_vuelve_a_ver_y_lo_dice():
    registry, bus, sched = harness()
    target = watch()
    registry.add(target)
    target.state = "blind"
    run(sched._sample(target, GuionSensor([True])))
    assert target.state == "armed"
    assert types_of(bus) == ["watch.recovered"]


def test_un_sensor_roto_termina_el_watch_y_no_lo_deja_fingiendo():
    """`faulted` es una cosa distinta de "lo vigilado se paró", y el orden de los
    eventos lo dice: primero el porqué, después el desarme."""
    registry, bus, sched = harness()
    target = watch()
    registry.add(target)
    sigue = run(sched._sample(target, GuionSensor([sensors.SensorFault("la unidad no existe")])))
    assert sigue is False
    assert target.state == "faulted"
    assert types_of(bus) == ["watch.faulted", "watch.disarmed"]
    events, _ = bus.since(0)
    assert events[1].envelope["data"]["reason"] == "faulted"


def test_un_bug_del_sensor_no_dispara_y_no_tira_el_proceso():
    """Una excepción inesperada es "no pude leer", nunca "se paró"."""
    registry, bus, sched = harness()
    target = watch(debounce_n=1)
    registry.add(target)
    run(sched._sample(target, GuionSensor([ZeroDivisionError()])))
    assert types_of(bus) == []
    assert target.samples_failed == 1


def test_un_sample_que_no_vuelve_cuenta_como_fallado(monkeypatch):
    """El techo por muestra: un probe colgado no puede congelar la vigilancia."""
    monkeypatch.setattr(scheduler_module, "SAMPLE_TIMEOUT_MS", 30)
    registry, bus, sched = harness()
    target = watch(debounce_n=1)
    registry.add(target)

    class Colgado(GuionSensor):
        async def sample(self):
            await asyncio.sleep(5)

    run(sched._sample(target, Colgado([])))
    assert types_of(bus) == []
    assert target.last_error == "sample timed out"


# ── El detector de suspensión ────────────────────────────────────────────────
def test_un_salto_de_reloj_descarta_un_ciclo_y_re_basea(monkeypatch):
    """Sin esto, cada suspensión del laptop dispara TODOS los watches al
    despertar: todo mtime, toda GPU y todo crecimiento se ven parados a la vez.

    Descartar es de UN ciclo, no un mute: después del salto la vigilancia sigue
    y el trip llega igual si la cosa de verdad se paró.
    """
    registry, bus, sched = harness()
    # Diez horas de vida: el salto simulado son dos, y la expiración se mira
    # ANTES que la deriva, así que un TTL corto haría vencer el watch en el
    # primer tick y el test probaría otra cosa.
    target = watch(period_ms=10, debounce_n=1, ttl_ms=10 * 60 * 60 * 1000)
    registry.add(target)
    sensor = GuionSensor([False] * 50)
    monkeypatch.setattr(sensors, "build", lambda spec: sensor)

    # La primera lectura del reloj es la línea de base que toma `_loop` antes de
    # entrar al bucle; el salto tiene que caer en la SEGUNDA, que es el primer
    # tick, o no hay deriva que detectar.
    reloj = {"t": now_ms(), "llamadas": 0}

    def falso_now():
        reloj["llamadas"] += 1
        # Dos horas de sueño en el primer tick: mucho más que 2 * period_ms.
        reloj["t"] += 2 * 60 * 60 * 1000 if reloj["llamadas"] == 2 else 10
        return reloj["t"]

    monkeypatch.setattr(scheduler_module, "now_ms", falso_now)
    run(_correr(sched, target, 0.12))

    assert sensor.rebaselines == 1, "el ciclo del salto tiene que re-basear el sensor"
    assert sensor.samples >= 1, "y los ciclos siguientes tienen que seguir muestreando"
    assert "watch.tripped" in types_of(bus)


def test_el_ciclo_del_salto_no_toma_muestra(monkeypatch):
    """"Descarta un ciclo" es literal: ese tick no muestrea, así que no puede
    aportar a una racha con un valor tomado de antes de dormir.

    Acá el reloj salta en TODOS los ciclos, así que ninguno debería muestrear:
    es la forma de afirmar el descarte sin depender de cuántos ticks entraron en
    la ventana del test.
    """
    registry, bus, sched = harness()
    target = watch(period_ms=10, debounce_n=1, ttl_ms=1000 * 60 * 60 * 1000)
    registry.add(target)
    sensor = GuionSensor([False] * 50)
    monkeypatch.setattr(sensors, "build", lambda spec: sensor)

    reloj = {"t": now_ms()}

    def falso_now():
        reloj["t"] += 2 * 60 * 60 * 1000
        return reloj["t"]

    monkeypatch.setattr(scheduler_module, "now_ms", falso_now)
    run(_correr(sched, target, 0.08))

    assert sensor.rebaselines >= 2, "cada salto re-basea"
    assert sensor.samples == 0, "un ciclo descartado no muestrea"
    assert types_of(bus) == [], "un salto de reloj no puede producir un trip"


# ── Expiración y desarme ─────────────────────────────────────────────────────
def test_el_watch_vencido_se_desarma_diciendo_por_que():
    registry, bus, sched = harness()
    target = watch(period_ms=10, ttl_ms=15)
    registry.add(target)

    run(_correr(sched, target, 0.1))
    assert target.state == "expired"
    assert types_of(bus) == ["watch.expired", "watch.disarmed"]


def test_el_stub_no_dispara_nunca():
    """El brazo de control del demo de salida de P5.1: el hijo que nunca se mata
    tiene que producir CERO trips. Un check que sólo mira "hubo un trip" pasaría
    haciendo nada."""
    registry, bus, sched = harness()
    target = watch(debounce_n=1)
    registry.add(target)
    sensor = sensors.build({"kind": "stub"})
    for _ in range(10):
        run(sched._sample(target, sensor))
    assert types_of(bus) == []
    assert target.fires == 0 and target.samples_ok == 10
