# sidecar/sense/tests/test_registry.py
"""El registro: la validación del POST, la fila del contrato y la persistencia.

Lo que este archivo protege por encima de todo es la ASUNCIÓN A4: lo que se
guarda vuelve `suspended`, jamás armado. Re-armar solo porque el proceso
reinició no es consentimiento, y una vigilancia que el usuario cree armada y no
lo está es la peor falla que tiene esta feature. En una copia de trabajo,
cambiar `state="suspended"` por `state="armed"` en `load()` dejaba la suite
entera en verde: 120 tests y ninguno miraba.

Y la otra mitad, que es la contraria: lo persistido tiene que volver. Si `save()`
se quedara corto, el reinicio se lleva la vigilancia y tampoco hay nadie mirando,
solo que además el HUD no la muestra y nadie puede preguntar por ella.
"""
import json
import os
import stat

import pytest

import registry as registry_module
import sensors
from config import MAX_DEBOUNCE_N, MAX_TERMINAL_ROWS, MAX_TTL_MS, MIN_PERIOD_MS
from registry import Registry, Watch, new_watch_id, now_ms, parse_create


def cuerpo(**extra):
    body = {"label": "el entrenamiento", "sensor": {"kind": "stub"},
            "periodMs": 60_000, "expiresAt": now_ms() + 3_600_000}
    body.update(extra)
    return body


def watch(state="armed", **extra):
    campos = dict(
        watch_id=new_watch_id(), label="el entrenamiento", sensor_spec={"kind": "stub"},
        sensor_kind="stub", rung=None, period_ms=60_000, debounce_n=3,
        expires_at=now_ms() + 3_600_000, session_id="s_1", narration=None, state=state,
    )
    campos.update(extra)
    return Watch(**campos)


@pytest.fixture
def disco(tmp_path, monkeypatch):
    """El espejo en disco, en un temporal propio de cada test."""
    monkeypatch.setattr(registry_module, "STATE_DIR", tmp_path)
    monkeypatch.setattr(registry_module, "WATCHES_FILE", tmp_path / "watches.json")
    return tmp_path / "watches.json"


# ── Asunción A4 ──────────────────────────────────────────────────────────────
def test_lo_persistido_vuelve_suspendido_y_no_armado(disco):
    """A4, en una línea: re-armar no es consentimiento.

    Volver `armed` sería una vigilancia que el usuario no pidió ESTA vez, mirando
    sola después de un reinicio que él no eligió, y encima ocupando cupo.
    """
    guardado = Registry()
    guardado.add(watch(state="armed"))
    guardado.save()

    vuelto = Registry()
    assert vuelto.load() == 1
    cargado = vuelto.all()[0]
    assert cargado.state == "suspended"
    assert vuelto.sampling() == []          # y no muestrea nada
    assert vuelto.counters()["suspended"] == 1 and vuelto.counters()["armed"] == 0


def test_una_suspendida_no_ocupa_cupo(disco):
    """Contarlas haría que dos vigilancias muertas de ayer impidieran armar una
    hoy: un 409 imposible de explicar."""
    registro = Registry()
    registro.add(watch(state="suspended"))
    registro.add(watch(state="armed"))
    assert len(registro.active()) == 2      # las dos siguen vivas y se persisten
    assert len(registro.sampling()) == 1    # pero solo una está mirando


def test_lo_que_se_guarda_vuelve_entero(disco):
    """La otra mitad de A4: si `save()` se queda corto, el reinicio se lleva la
    vigilancia y nadie puede ni preguntar por ella."""
    original = watch(state="armed", session_id="s_7", narration="avisáme si se para", fires=2)
    guardado = Registry()
    guardado.add(original)
    guardado.save()

    vuelto = Registry()
    vuelto.load()
    cargado = vuelto.get(original.watch_id)
    assert cargado.label == original.label
    assert cargado.sensor_spec == original.sensor_spec
    assert cargado.period_ms == original.period_ms and cargado.debounce_n == original.debounce_n
    assert cargado.expires_at == original.expires_at
    assert cargado.session_id == "s_7"      # la preferencia de entrega, no la vida del watch
    assert cargado.narration == "avisáme si se para"
    assert cargado.fires == 2               # el contador de disparos no se reinicia


def test_una_vigilancia_vencida_mientras_el_proceso_estaba_caido_no_vuelve(disco):
    """El usuario dijo "hasta las ocho" y son las diez: mostrarla otra vez sería
    una vigilancia que nadie pidió."""
    disco.write_text(json.dumps({"v": 1, "watches": [
        {**watch().persisted(), "expiresAt": now_ms() - 1},
    ]}), encoding="utf-8")
    registro = Registry()
    assert registro.load() == 0


def test_una_fila_podrida_no_impide_cargar_las_demas(disco):
    """Un archivo a medias no puede dejar sin cargar a la vigilancia de al lado."""
    buena = watch().persisted()
    disco.write_text(json.dumps({"v": 1, "watches": [
        {"watchId": "w_rota"},                                   # sin campos
        {**watch().persisted(), "sensor": {"kind": "telepatia"}},  # sensor que no existe
        {**watch().persisted(), "periodMs": "un rato"},          # tipo equivocado
        buena,
    ]}), encoding="utf-8")
    registro = Registry()
    assert registro.load() == 1
    assert registro.all()[0].watch_id == buena["watchId"]


def test_un_archivo_ilegible_no_tumba_el_arranque(disco):
    disco.write_text("{esto no es json", encoding="utf-8")
    assert Registry().load() == 0
    disco.unlink()
    assert Registry().load() == 0           # y no existir tampoco es un error


def test_las_terminales_no_se_persisten(disco):
    """Una desarmada no vuelve como suspendida: ya terminó."""
    registro = Registry()
    registro.add(watch(state="disarmed"))
    registro.add(watch(state="expired"))
    registro.add(watch(state="armed"))
    registro.save()
    assert len(json.loads(disco.read_text(encoding="utf-8"))["watches"]) == 1


def test_el_archivo_es_0600_y_la_carpeta_0700(disco):
    """Mismo idioma que backend/src/state/dataDir.js. La carpeta está en la
    denylist del agente, pero el modo es lo que la protege del resto del sistema."""
    registro = Registry()
    registro.add(watch())
    registro.save()
    assert stat.S_IMODE(os.stat(disco).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(disco.parent).st_mode) == 0o700


def test_el_reemplazo_es_atomico_y_no_deja_basura(disco):
    """Un corte en medio del write deja un JSON roto, y un JSON roto acá es un
    watch que el usuario cree armado."""
    registro = Registry()
    registro.add(watch())
    registro.save()
    registro.save()
    assert [p.name for p in disco.parent.iterdir()] == ["watches.json"]


# ── Las filas terminales, acotadas ───────────────────────────────────────────
def test_las_filas_terminales_se_acotan_y_se_avisa_cual_se_fue(disco):
    """Se conservan para que el HUD muestre por qué se desarmó una, pero un
    proceso de una semana no puede acumularlas: el que desaloja devuelve los ids
    para que el bus olvide su contador `seq` (la misma fuga que AUDIT M16)."""
    registro = Registry()
    viejas = []
    desalojadas = []
    for i in range(MAX_TERMINAL_ROWS + 2):
        terminada = watch(state="disarmed", created_at=now_ms() - 10_000 + i)
        viejas.append(terminada.watch_id)
        # El desalojo pasa en CADA alta, no al final: se acumula lo que devolvió
        # cada una, que es lo que main.py le pasa a `bus.forget()`.
        desalojadas += registro.add(terminada)
    assert desalojadas == viejas[:2]        # las más viejas primero
    assert len([w for w in registro.all() if w.state == "disarmed"]) == MAX_TERMINAL_ROWS


# ── La fila del contrato ─────────────────────────────────────────────────────
def test_la_fila_no_lleva_ni_la_narracion_ni_el_spec_del_sensor():
    """`watchStatus()` se arma con esto y se pega al system prompt de cada turno
    con acciones: una ruta o una línea de log acá es un punto de inyección
    permanente mientras el watch esté armado (plan §10, T9)."""
    fila = watch(narration="mirá /home/yo/train.log", sensor_spec={"kind": "file", "path": "/home/yo/train.log"}).row()
    assert set(fila) == {"watchId", "label", "state", "rung", "sensorKind", "lastSampleAt",
                         "samplesOk", "samplesFailed", "fires", "expiresAt", "sessionId"}
    assert "train.log" not in json.dumps(fila)


def test_el_id_no_tiene_caracteres_que_se_confundan_al_dictarlos():
    """Se leen en voz alta y se escriben a mano en un curl."""
    generados = {new_watch_id() for _ in range(50)}
    assert len(generados) == 50             # y no se repiten
    for watch_id in generados:
        assert watch_id.startswith("w_") and len(watch_id) == 26
        assert not set(watch_id[2:]) & set("0189")


# ── parse_create: lo que entra por HTTP ──────────────────────────────────────
def test_un_cuerpo_valido_nace_armado_y_con_id_propio():
    creada = parse_create(cuerpo())
    assert creada.state == "armed" and creada.watch_id.startswith("w_")
    assert creada.sensor_kind == "stub" and creada.debounce_n == 3


@pytest.mark.parametrize("cambio,motivo", [
    ({"label": ""}, "etiqueta vacía"),
    ({"label": "   "}, "solo espacios"),
    ({"label": 7}, "no es texto"),
    ({"label": "x" * 200}, "más larga que el tope"),
    ({"label": "el log\r\nde entrenamiento"}, "caracteres de control"),
    ({"periodMs": MIN_PERIOD_MS - 1}, "más rápido que el piso"),
    ({"periodMs": 10_000_000}, "más lento que el techo"),
    ({"periodMs": True}, "un bool no es un entero"),
    ({"periodMs": "60000"}, "un string no es un entero"),
    ({"debounceN": 0}, "por debajo de 1"),
    ({"debounceN": MAX_DEBOUNCE_N + 1}, "por encima del tope"),
    ({"expiresAt": None}, "la expiración es obligatoria"),
    ({"expiresAt": now_ms() - 1}, "ya pasó"),
    ({"expiresAt": now_ms() + MAX_TTL_MS + 60_000}, "más allá del techo"),
    ({"expiresAt": now_ms() + 1_000, "periodMs": 60_000}, "vence antes del primer sample"),
    ({"sessionId": "s\x00_1"}, "control en el sessionId"),
    ({"narration": "x" * 500}, "narración más larga que el tope"),
])
def test_lo_que_no_puede_armarse(cambio, motivo):
    """Un `\\r` en la etiqueta ensucia el log, el sobre SSE y la línea hablada a
    la vez, así que se rechaza donde entra y no donde se muestra. Y la expiración
    es obligatoria (asunción A3: no hay vigilancias abiertas para siempre) porque
    es lo que Hannah lee en voz alta al armar."""
    with pytest.raises(sensors.SpecError):
        parse_create(cuerpo(**cambio))


def test_el_cuerpo_tiene_que_ser_un_objeto():
    for basura in ([], "listo", 7, None):
        with pytest.raises(sensors.SpecError):
            parse_create(basura)


def test_la_etiqueta_se_recorta_pero_se_conserva_lo_que_dijo_la_persona():
    creada = parse_create(cuerpo(label="  el entrenamiento de las ocho  "))
    assert creada.label == "el entrenamiento de las ocho"


def test_sin_sesion_la_vigilancia_igual_se_arma():
    """El `sessionId` es una PREFERENCIA DE ENTREGA, no la vida del watch: se
    arma también por REST, y entonces lo que dispare va al buzón."""
    creada = parse_create({k: v for k, v in cuerpo().items()})
    assert creada.session_id is None and creada.narration is None
