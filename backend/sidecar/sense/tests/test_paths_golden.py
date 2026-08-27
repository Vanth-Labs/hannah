# sidecar/sense/tests/test_paths_golden.py
"""Los dos clasificadores contestan lo mismo, o esta suite falla.

`paths.py` reimplementa en Python el algoritmo de
`agent/packages/agent/src/hannah/policy/paths.ts`. La TABLA se comparte (el asset
generado), pero el algoritmo no se puede serializar, así que la única defensa
contra la deriva es esta: el asset trae `golden`, con el veredicto que produjo el
TypeScript para cada caso, y acá se exige el mismo veredicto campo por campo.
Si alguien cambia paths.ts y regenera el asset, los casos que cambien de
respuesta rompen este archivo en el otro repo primero y acá después.

La `reason` se compara literal a propósito: es la frase que Hannah dice en voz
alta, y el contrato de M5.1.2 es que el usuario escuche exactamente la misma si
pidió LEER el archivo (agente) o si pidió VIGILARLO (sidecar).
"""
import json
import os

import pytest

import paths
import sensors


def _cases():
    return paths.table().golden


def _with_deny_dirs(value):
    if value is None:
        os.environ.pop(paths.table().deny_dirs_env, None)
    else:
        os.environ[paths.table().deny_dirs_env] = value


@pytest.mark.parametrize("case", _cases(), ids=lambda c: f"{c['path']}|{c.get('denyDirs', '')}")
def test_cada_caso_golden_coincide_con_el_agente(case):
    _with_deny_dirs(case.get("denyDirs"))
    try:
        verdict = paths.classify(case["path"], "/")
    finally:
        _with_deny_dirs(None)
    assert verdict.sensitive is case["sensitive"], case["why"]
    assert verdict.reason == case.get("reason"), case["why"]
    assert verdict.rule == case.get("rule"), case["why"]


def test_el_asset_trae_las_cinco_familias_de_regla():
    """Un asset que carga a medias denegaría de menos sin avisar."""
    table = paths.table()
    assert table.directories and table.files
    assert table.patterns and table.basenames and table.exceptions
    assert len(table.golden) >= 20


def test_el_ancla_de_fin_de_cadena_no_deja_pasar_un_salto_de_linea():
    """La regresión que justifica `_to_python_source`.

    En JS `$` sin flag `m` es fin de cadena; en Python es fin de cadena O justo
    antes de un \\n final. Con el `$` de Python, la EXCEPCIÓN de basename
    `^id_[a-z0-9]+\\.pub$` aceptaría "id_rsa.pub\\n" y devolvería NO SENSIBLE una
    ruta que el agente deniega por estar en ~/.ssh. Sin la traducción a `\\Z`
    este test falla: la ruta clasifica como no sensible.
    """
    verdict = paths.classify("~/.ssh/id_rsa.pub\n", "/")
    assert verdict.sensitive is True
    assert verdict.reason == "~/.ssh is a protected directory"
    # Y la grafía sin salto sigue siendo la excepción que tiene que ser.
    assert paths.classify("~/.ssh/id_ed25519.pub", "/").sensitive is False


def test_un_symlink_a_un_arbol_denegado_no_se_cuela(tmp_path):
    """`resolve()` camina al ancestro existente y le hace realpath.

    Sin eso, un enlace en /tmp apuntando a ~/.ssh dejaría vigilar cualquier
    archivo de adentro con un nombre que no sea de credencial (config,
    known_hosts), y el veredicto sería "no sensible" con toda seguridad.
    """
    link = tmp_path / "atajo"
    link.symlink_to(os.path.expanduser("~/.ssh"))
    verdict = paths.classify(str(link / "config"), "/")
    assert verdict.sensitive is True
    assert verdict.reason == "~/.ssh is a protected directory"


def test_un_archivo_que_todavia_no_existe_se_clasifica_por_su_carpeta(tmp_path):
    """El checkpoint de la época 12 no existe cuando se arma el watch."""
    link = tmp_path / "atajo"
    link.symlink_to(os.path.expanduser("~/.ssh"))
    assert paths.classify(str(link / "todavia" / "no" / "existe"), "/").sensitive is True


def test_la_carpeta_data_del_backend_esta_denegada_sin_variable_de_entorno():
    """El residual de B2, tapado por el sidecar mismo.

    La regla compilada del agente nombra `hannah-backend/data`, que es el nombre
    que crea el instalador; en este checkout la carpeta se llama `backend/`, y
    sin HANNAH_AGENT_DENY_DIRS ninguna regla la cubre (el propio asset lo declara
    en su caso "the residual"). El sidecar vive adentro de ese repo y sabe la
    ruta, así que la agrega él. Sin `paths.locally_denied` este test falla y
    settings.json (todas las claves de los proveedores en claro) sería vigilable.
    """
    assert os.environ.get("HANNAH_AGENT_DENY_DIRS") is None
    target = os.path.join(paths.local_directories()[0], "settings.json")
    assert paths.classify(target, "/").sensitive is False, "el port fiel no lo deniega, y está bien"
    with pytest.raises(sensors.DeniedPath) as denial:
        sensors.classify_path(target)
    assert str(denial.value).endswith("is a protected directory")


def test_sin_asset_todo_lo_que_lleve_ruta_falla_cerrado(monkeypatch):
    """Fallar abierto acá sería armar watches sobre cualquier archivo del disco."""
    paths.reset()
    monkeypatch.setenv("HANNAH_AGENT_FIXTURES", "/no/existe/en/ninguna/maquina")
    with pytest.raises(paths.AssetMissing):
        paths.classify("/var/log/training.log", "/")
    with pytest.raises(sensors.DeniedPath):
        sensors.classify_path("/var/log/training.log")
    assert "HANNAH_AGENT_FIXTURES" in (paths.unavailable() or "")


def test_una_ruta_con_caracteres_de_control_se_rechaza_al_armar():
    """Un \\n en una ruta no es una ruta: es alguien probando el ancla de una regla."""
    with pytest.raises(sensors.SpecError):
        sensors.classify_path("/var/log/train.log\n")


def test_el_asset_es_el_mismo_archivo_que_versiona_el_repo_del_agente():
    """El origen se afirma para que un asset copiado a mano se note."""
    origin = paths.table().origin
    assert origin.name == "policy-paths.json"
    data = json.loads(origin.read_text(encoding="utf-8"))
    assert data["source"] == "packages/agent/src/hannah/policy/paths.ts"
    assert data["generator"] == "scripts/emit-policy-asset.ts"
