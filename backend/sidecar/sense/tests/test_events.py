# sidecar/sense/tests/test_events.py
"""El anillo de eventos y el resume, que es donde vive la ceguera silenciosa.

Un backend conectado y sordo es peor que uno desconectado: desconectado lo dice
(`onStatus('down')` y, pasado `SENSE_BLIND_MS`, Hannah avisa que perdió de
vista). Conectado y sordo no lo dice nadie, porque la conexión funcionó.

Las dos formas de llegar ahí son la misma causa: **el cursor del cliente vive
más que el arranque que lo emitió.** El sidecar reinicia solo (una
actualización, un crash, un `systemctl restart`) y su cursor vuelve a 0;
`senseClient.subscribe()` guarda `lastId` por la vida del proceso del BACKEND y
lo remanda en cada reconexión, incluida la que causó el reinicio del sidecar.
Con el anillo lleno eso daba un `truncated=false` con cero eventos; con el
anillo vacío daba además una marca de agua de 500 que se comía todo lo que
viniera después.

Es la parte donde `facade/store.ts` NO sirve de referencia: allá la fachada
corre dentro del proceso del agente y muere con su cliente, así que los dos
cursores nacen juntos y uno adelantado no existe.
"""
from pathlib import Path

import pytest

from events import EventBus

SENSE_DIR = Path(__file__).resolve().parent.parent


def bus_con(cuantos: int) -> EventBus:
    """Un anillo con `cuantos` eventos de un mismo watch, cursores 1..cuantos."""
    bus = EventBus()
    for _ in range(cuantos):
        bus.publish("w_" + "a" * 24, "watch.armed", {"label": "el entrenamiento"})
    return bus


def test_un_cursor_de_otro_arranque_no_es_un_resume_limpio():
    """Reproducción (a): con el anillo lleno, el cliente adelantado se llevaba
    NADA y le decíamos que estaba al día."""
    bus = bus_con(4)
    replay, truncated = bus.since(500)
    assert truncated is True, "un cursor imposible no se puede contestar `false`"
    assert [stored.cursor for stored in replay] == [1, 2, 3, 4], (
        "un cursor de otro arranque tiene que recibir lo mismo que un cliente nuevo")


def test_un_cursor_de_otro_arranque_no_sordea_lo_que_venga_despues():
    """Reproducción (b): el anillo VACÍO (el sidecar acaba de arrancar y todavía
    no publicó nada) y un cursor de 500. Sin el arreglo, la marca de agua queda
    en 500 y los primeros 500 eventos de este arranque, trips incluidos, se
    filtran uno por uno con la conexión abierta."""
    bus = EventBus()
    replay, truncated = bus.since(500)
    assert truncated is True
    assert replay == []

    marca = bus.watermark(replay)
    primero = bus.publish("w_" + "b" * 24, "watch.tripped", {"label": "x"})
    assert primero.cursor > marca, "el primer trip del arranque nuevo se filtraba"


def test_la_marca_de_agua_de_un_cliente_al_dia_no_repite_lo_ya_enviado():
    """El otro lado del mismo número: la marca existe porque la ruta se suscribe
    ANTES de calcular el replay, así que un evento del medio queda en los dos
    lados. Bajarla de más sería narrar dos veces el mismo trip."""
    bus = bus_con(4)
    replay, truncated = bus.since(4)
    assert (replay, truncated) == ([], False)
    assert bus.watermark(replay) == 4

    replay, _ = bus.since(2)
    assert bus.watermark(replay) == 4


def test_el_anillo_que_ya_tiro_eventos_sigue_avisando():
    """La forma que ya estaba y que no se puede romper al arreglar la otra."""
    bus = EventBus(buffer_size=3)
    for _ in range(6):
        bus.publish("w_" + "c" * 24, "watch.armed", {"label": "x"})
    replay, truncated = bus.since(1)
    assert truncated is True
    assert [stored.cursor for stored in replay] == [4, 5, 6]


def test_un_cliente_nuevo_recibe_el_anillo_entero_y_sin_aviso():
    bus = bus_con(4)
    replay, truncated = bus.since(0)
    assert truncated is False
    assert len(replay) == 4


def test_el_boot_identifica_al_arranque_y_no_a_la_maquina():
    """Es lo que le deja al backend notar que el cursor que guardó ya no vale.
    Dos anillos son dos arranques aunque corran en el mismo proceso."""
    uno, otro = EventBus(), EventBus()
    assert uno.boot_id() and uno.boot_id() != otro.boot_id()
    antes = uno.boot_id()
    uno.publish("w_" + "d" * 24, "watch.armed", {"label": "x"})
    assert uno.boot_id() == antes, "el boot no cambia mientras el proceso vive"


def test_el_tipo_de_evento_es_un_enum_cerrado():
    bus = EventBus()
    with pytest.raises(ValueError):
        bus.publish("w_" + "e" * 24, "watch.sample", {})


def test_la_ruta_del_stream_no_usa_el_cursor_del_cliente_como_marca():
    """La regla vive en el anillo, pero quien la aplica es la ruta.

    Barrido de fuente, igual que `test_solo_base_py_ejecuta_algo`: sin esto el
    arreglo se puede deshacer en `main.py` sin que falle un solo test de este
    archivo, porque el anillo seguiría contestando bien.
    """
    fuente = (SENSE_DIR / "main.py").read_text(encoding="utf-8")
    assert "bus.watermark(replay)" in fuente
    assert "if replay else cursor" not in fuente
