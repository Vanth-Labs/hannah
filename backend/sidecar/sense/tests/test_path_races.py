# sidecar/sense/tests/test_path_races.py
"""La ventana entre clasificar una ruta y abrirla, que es donde vive el symlink.

Un sensor con ruta no clasifica una vez: clasifica al armar (para que una ruta
denegada sea un 403 en el POST) y otra vez en CADA muestra, porque entre el arme
y la muestra número doscientos pasan horas y una ruta es un NOMBRE, no un
archivo. Los dos ataques de abajo se reprodujeron en vivo contra el sidecar
corriendo y los dos terminaban con el sensor leyendo un `.env`:

  (a) el symlink colgado: se arma sobre un link cuyo destino todavía no existe,
      así que `resolve()` se queda en el link mismo y su basename es inocente;
      cuando el destino aparece, el sensor lo sigue.
  (b) la rotación: se arma sobre un archivo de verdad y después se lo reemplaza
      por un symlink al `.env`. No hace falta ningún link colgado, y es
      exactamente la forma que tiene una rotación de logs.

  (c) perder la carrera: entre clasificar y abrir hay dos syscalls, y en esa
      ventana se puede cambiar un directorio del MEDIO, que es justo lo que
      O_NOFOLLOW no mira. Re-clasificar sola no lo tapa; lo tapa clasificar lo
      que se abrió DE VERDAD.

Y las dos piezas de `open_watched()` que hacen falta para que eso sea verdad y
que se podían borrar sin que nada se pusiera rojo: el `O_NOFOLLOW`, que es lo
único que cuida el ÚLTIMO componente, y el `' (deleted)'` que hay que sacarle al
nombre que devuelve /proc antes de clasificarlo.

En el agente el mismo hueco dura milisegundos (clasifica justo antes de leer);
acá el sidecar convierte la carrera en una lectura programada y repetida.

Que la ruta pase a estar denegada es `SensorFault` y no `SensorError`: un error
es transitorio y deja el watch reintentando la misma lectura denegada cada
período, para siempre.
"""
import asyncio
import contextlib
import os
import signal

import pytest

import paths
import sensors
from sensors import base


def run(coro):
    return asyncio.run(coro)


@contextlib.contextmanager
def reloj(segundos: float = 5.0):
    """Convierte un cuelgue en una falla.

    El `open()` de un FIFO sin escritor espera para siempre y no hay `await` que
    lo interrumpa. Sin este reloj un test que cuelga TRABA LA SUITE ENTERA en vez
    de fallar, que es exactamente lo que hacía la primera versión de este archivo
    contra el código de antes del arreglo: `pytest tests` no terminaba nunca.
    """
    def vencido(*_):
        raise TimeoutError("el sample se colgó")

    anterior = signal.signal(signal.SIGALRM, vencido)
    signal.setitimer(signal.ITIMER_REAL, segundos)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, anterior)


def _env(tmp_path):
    """Un archivo que la denylist del agente deniega por basename."""
    secreto = tmp_path / ".env"
    secreto.write_text("OPENAI_API_KEY=sk-de-verdad\nTraceback\n", encoding="utf-8")
    return secreto


# ── (a) el symlink colgado que después apunta a algo ─────────────────────────
@pytest.mark.parametrize("kind", ["file", "logmatch"])
def test_un_symlink_colgado_que_despues_apunta_a_un_env_no_se_lee(tmp_path, kind):
    """`resolve()` camina al ancestro que EXISTE, así que un link colgado se
    resuelve a sí mismo y pasa la clasificación con su propio basename."""
    destino = tmp_path / "target" / ".env"          # `target/` todavía no existe
    link = tmp_path / "envlink"
    link.symlink_to(destino)

    spec = ({"kind": "file", "path": str(link), "stallSeconds": 60} if kind == "file"
            else {"kind": "logmatch", "path": str(link), "pattern": "Traceback"})
    sensor = sensors.build(spec)                    # el POST contesta 201: nada denegado todavía

    destino.parent.mkdir()
    _env(tmp_path / "target")
    with pytest.raises(sensors.SensorFault):
        run(sensor.sample())


# ── (b) el archivo de verdad que se vuelve un symlink ────────────────────────
@pytest.mark.parametrize("kind", ["file", "logmatch"])
def test_reemplazar_el_log_por_un_symlink_a_un_env_no_se_lee(tmp_path, kind):
    """Sin ningún link colgado: se arma sobre `live.log` y después alguien lo
    reemplaza por un symlink. Es la forma de una rotación de logs."""
    secreto = _env(tmp_path)
    log = tmp_path / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")

    spec = ({"kind": "file", "path": str(log), "stallSeconds": 60} if kind == "file"
            else {"kind": "logmatch", "path": str(log), "pattern": "Traceback"})
    sensor = sensors.build(spec)
    run(sensor.sample())                            # primera muestra, todo sano

    log.unlink()
    log.symlink_to(secreto)
    with pytest.raises(sensors.SensorFault):
        run(sensor.sample())


def test_el_env_nunca_se_llega_a_leer(tmp_path):
    """No alcanza con que la muestra falle: no se puede haber leído el contenido.

    El sensor de logmatch es pegajoso, así que si en algún momento matcheó
    `Traceback` adentro del `.env` la marca queda puesta para siempre.
    """
    secreto = _env(tmp_path)
    log = tmp_path / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")
    sensor = sensors.build({"kind": "logmatch", "path": str(log), "pattern": "Traceback"})
    run(sensor.sample())

    log.unlink()
    log.symlink_to(secreto)
    with pytest.raises(sensors.SensorFault):
        run(sensor.sample())

    # Se restituye el log de verdad: si hubiera leído el `.env`, `matched` ya
    # estaría en True y el watch dispararía por una línea que nunca vio.
    log.unlink()
    log.write_text("epoch 2\n", encoding="utf-8")
    sample = run(sensor.sample())
    assert sample.detail["matched"] is False
    assert sample.detail["count"] == 0
    assert sample.healthy is True


# ── Lo que NO se puede romper por cerrar la ventana ──────────────────────────
def test_un_symlink_a_un_log_permitido_se_sigue_vigilando(tmp_path):
    """`latest.log -> train-2026.log` es el idioma normal de un entrenamiento.

    Se clasifica la RESUELTA y se abre la RESUELTA, así que el symlink permitido
    sigue funcionando: lo que se cierra es seguir un nombre que cambió de
    destino, no usar symlinks.
    """
    real = tmp_path / "train-2026.log"
    real.write_text("epoch 1\n", encoding="utf-8")
    link = tmp_path / "latest.log"
    link.symlink_to(real)

    sensor = sensors.build({"kind": "logmatch", "path": str(link), "pattern": "Traceback"})
    assert run(sensor.sample()).healthy is True
    with open(real, "a", encoding="utf-8") as handle:
        handle.write("Traceback\n")
    assert run(sensor.sample()).healthy is False


def test_una_rotacion_normal_sigue_siendo_transitoria(tmp_path):
    """El archivo que no está es `SensorError` (el watch se pone `blind` y lo
    dice), no `SensorFault` (el watch termina). Cerrar la ventana no puede
    convertir una rotación en un watch muerto."""
    log = tmp_path / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")
    sensor = sensors.build({"kind": "file", "path": str(log), "stallSeconds": 60})
    run(sensor.sample())
    log.unlink()
    with pytest.raises(sensors.SensorError):
        run(sensor.sample())


def test_lo_vigilado_tiene_que_ser_un_archivo(tmp_path):
    """Un FIFO cuelga el `open()` hasta que alguien escriba, y un watch colgado
    es un watch que el usuario cree armado."""
    fifo = tmp_path / "tuberia"
    os.mkfifo(fifo)
    sensor = sensors.build({"kind": "logmatch", "path": str(fifo), "pattern": "x"})
    with reloj(), pytest.raises(sensors.SensorFault):
        run(sensor.sample())


# ── (c) perder la carrera entre clasificar y abrir ───────────────────────────
def test_perder_la_carrera_entre_clasificar_y_abrir_tampoco_lee(tmp_path, monkeypatch):
    """Lo que re-clasificar NO tapa, y por qué la muestra verifica lo que abrió.

    `classify()` y `open()` son dos syscalls, y O_NOFOLLOW solo cuida el ÚLTIMO
    componente: cambiar un directorio del MEDIO por un symlink adentro de esa
    ventana hace que se abra otro archivo con el mismo nombre. Acá el cambio se
    engancha en el retorno de `paths.classify`, o sea que la carrera se pierde
    SIEMPRE y en el peor instante posible.
    """
    denegado = tmp_path / "vault"
    denegado.mkdir()
    (denegado / "live.log").write_text("Traceback\n", encoding="utf-8")
    # Un directorio que ESTA máquina deniega, que es la forma en que el launcher
    # protege backend/data (HANNAH_AGENT_DENY_DIRS).
    monkeypatch.setenv("HANNAH_AGENT_DENY_DIRS", str(denegado))

    vivo = tmp_path / "live"
    vivo.mkdir()
    log = vivo / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")
    sensor = sensors.build({"kind": "logmatch", "path": str(log), "pattern": "Traceback"})

    perdida = []
    clasificar = paths.classify

    def clasificar_y_perder_la_carrera(value, cwd=None):
        verdict = clasificar(value, cwd)
        if not perdida:
            perdida.append(True)
            vivo.rename(tmp_path / "live-real")
            os.symlink(denegado, vivo)      # el directorio del medio, ya clasificado
        return verdict

    monkeypatch.setattr(paths, "classify", clasificar_y_perder_la_carrera)
    with pytest.raises(sensors.SensorFault):
        run(sensor.sample())
    assert perdida, "el sensor no clasificó en la muestra: la ventana ni se abrió"

    # Y no leyó nada de adentro del directorio denegado: se devuelve el árbol de
    # verdad y el sensor arranca limpio, sin el `Traceback` que había allá.
    vivo.unlink()
    (tmp_path / "live-real").rename(vivo)
    sample = run(sensor.sample())
    assert sample.healthy is True and sample.detail["matched"] is False


def test_lo_que_viaja_del_fallo_no_lleva_la_ruta(tmp_path):
    """`watch.faulted.error` sale de este proceso y puede terminar en una frase
    hablada. La razón de la denegación lleva la ruta adentro, así que lo que
    viaja es vocabulario fijo y la razón entera se queda en el log (regla R2)."""
    secreto = _env(tmp_path)
    log = tmp_path / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")
    sensor = sensors.build({"kind": "file", "path": str(log), "stallSeconds": 60})
    run(sensor.sample())

    log.unlink()
    log.symlink_to(secreto)
    with pytest.raises(sensors.SensorFault) as fallo:
        run(sensor.sample())
    dicho = str(fallo.value)
    assert dicho == base.PATH_TURNED_DENIED
    assert str(tmp_path) not in dicho and ".env" not in dicho


# ── Las dos piezas de open_watched() que nada afirmaba ───────────────────────
# El docstring de `open_watched()` dice que son TRES cosas y no una, y los tests
# de arriba solo cubrían la primera (re-clasificar) y la tercera (verificar el
# descriptor) cuando lo abierto queda DENEGADO. Faltaban las dos que se pueden
# borrar sin que nada se ponga rojo, y las dos están nombradas en el código como
# lo que sostiene la garantía.
def test_o_nofollow_hace_fallar_el_open_del_ultimo_componente(tmp_path):
    """El flag, solo, en su forma más chica.

    Sin O_NOFOLLOW esto abre el destino y no levanta nada. Es la única defensa
    del ÚLTIMO componente: verificar el descriptor después no lo tapa cuando el
    symlink apunta a un archivo permitido (ver el test de abajo).
    """
    real = tmp_path / "train-2026.log"
    real.write_text("epoch 1\n", encoding="utf-8")
    link = tmp_path / "live.log"
    link.symlink_to(real)

    with pytest.raises(sensors.SensorError):
        base._open_nofollow(str(link))


def test_perder_la_carrera_contra_el_ultimo_componente_no_lee_otro_archivo(tmp_path, monkeypatch):
    """La carrera que O_NOFOLLOW tapa y la verificación NO.

    El caso (c) de arriba cambia un directorio del MEDIO por uno DENEGADO, así que
    lo agarra `_verify_opened`. Acá el último componente pasa a ser un symlink a
    un archivo PERMITIDO: el descriptor se verifica limpio, la clasificación dice
    que sí, y sin el flag el sensor lee un archivo que nadie le pidió mirar y se
    queda pegado con lo que encontró adentro.
    """
    otro = tmp_path / "otro.log"                 # permitido, y con el patrón adentro
    otro.write_text("epoch 1\nTraceback\n", encoding="utf-8")
    log = tmp_path / "live.log"
    log.write_text("epoch 1\n", encoding="utf-8")

    sensor = sensors.build({"kind": "logmatch", "path": str(log), "pattern": "Traceback"})
    run(sensor.sample())                         # primera muestra: ancla el offset en el final

    perdida = []
    clasificar = paths.classify

    def clasificar_y_perder_la_carrera(value, cwd=None):
        verdict = clasificar(value, cwd)
        if not perdida:
            perdida.append(True)
            log.unlink()
            log.symlink_to(otro)                 # el último componente, ya clasificado
        return verdict

    monkeypatch.setattr(paths, "classify", clasificar_y_perder_la_carrera)
    with pytest.raises(sensors.SensorError):
        run(sensor.sample())
    assert perdida, "el sensor no clasificó en la muestra: la ventana ni se abrió"

    # Y no leyó nada del otro archivo: `matched` es pegajoso, así que si lo
    # hubiera leído el watch dispararía para siempre por una línea que no vio.
    log.unlink()
    log.write_text("epoch 2\n", encoding="utf-8")
    sample = run(sensor.sample())
    assert sample.detail["matched"] is False and sample.healthy is True


def test_el_sufijo_deleted_se_saca_antes_de_clasificar_lo_abierto(tmp_path):
    """Un unlink bien puesto saltea la verificación entera si no se saca.

    El kernel le pega " (deleted)" al nombre de /proc/self/fd/N cuando el inodo se
    desenlazó después del open. Las reglas por basename están ancladas (`^\\.env$`),
    así que con el sufijo pegado NINGUNA matchea y `_verify_opened` da por bueno un
    descriptor abierto sobre un `.env`. Acá el fd, el unlink y el /proc son de
    verdad: no hay nada simulado que pueda mentir a favor.
    """
    secreto = tmp_path / ".env"
    secreto.write_text("OPENAI_API_KEY=sk-de-verdad\n", encoding="utf-8")
    fd = os.open(secreto, os.O_RDONLY)
    try:
        secreto.unlink()
        nombre = os.readlink(f"/proc/self/fd/{fd}")
        assert nombre.endswith(base._DELETED)
        # La premisa, dicha en voz alta: sin sacar el sufijo la tabla lo aprueba.
        assert paths.classify(nombre, "/").sensitive is False
        assert paths.classify(nombre[: -len(base._DELETED)], "/").sensitive is True

        with pytest.raises(sensors.SensorFault) as fallo:
            base._verify_opened(fd, "path")
        assert str(fallo.value) == base.PATH_TURNED_DENIED
    finally:
        os.close(fd)
