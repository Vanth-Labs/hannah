# sidecar/sense/tests/test_capability.py
"""La sonda de capacidades y la escalera que arma con ella.

Todo lo de acá corre con un resolutor FIJADO. Es la lección que este repo ya se
comió tres veces: un fixture que lee el estado real de la máquina pasa donde se
escribió y falla en la de al lado, y el que hereda la falla no sabe si rompió
algo o si le falta un paquete. La única excepción es
`test_which_encuentra_un_binario_real`, que prueba el resolutor de verdad y por
eso se saltea solo si la máquina no tiene ni /bin/sh.
"""
import os
import stat

import pytest

import capability
import sensors

#: Una máquina con todo lo de la fase instalado.
COMPLETA = {"pgrep": "/usr/bin/pgrep", "nvidia-smi": "/usr/bin/nvidia-smi",
            "ss": "/usr/bin/ss", "systemctl": "/usr/bin/systemctl"}


def resolver(disponibles):
    return lambda command: disponibles.get(command)


def rungs(capabilities):
    return {row["id"]: row for row in capabilities["rungs"]}


def test_which_mira_el_bit_de_ejecucion_y_no_solo_el_nombre(tmp_path, monkeypatch):
    """Un archivo llamado `pgrep` no es el binario pgrep."""
    impostor = tmp_path / "pgrep"
    impostor.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("PATH", str(tmp_path))
    capability.reset()
    assert capability.which("pgrep") is None

    impostor.chmod(impostor.stat().st_mode | stat.S_IXUSR)
    capability.reset()
    assert capability.which("pgrep") == str(impostor)


def test_which_no_confunde_un_directorio_con_un_programa(tmp_path, monkeypatch):
    """El S_ISREG: un directorio tiene el bit de ejecución puesto por definición."""
    (tmp_path / "ss").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path))
    capability.reset()
    assert capability.which("ss") is None


def test_which_con_barra_no_busca_en_el_path(tmp_path):
    """Igual que env.ts: un nombre con separador es una ruta, no un comando."""
    capability.reset()
    assert capability.which(str(tmp_path / "nada")) is None


def test_which_encuentra_un_binario_real():
    capability.reset()
    found = capability.which("sh")
    if found is None:
        pytest.skip("esta máquina no tiene sh en PATH")
    assert os.path.isabs(found) and os.access(found, os.X_OK)


def test_which_first_devuelve_el_comando_y_no_la_ruta():
    """Mismo contrato que whichFirst en env.ts, para que el que llama pueda
    volver a usar el nombre tal como lo escribió."""
    capability.pin(resolver({"ss": "/usr/bin/ss"}))
    assert capability.which_first(["nada", "ss"]) == "ss"
    assert capability.which_first(["nada", "tampoco"]) is None


def test_la_escalera_completa_en_una_maquina_con_todo():
    survey = rungs(sensors.capabilities(resolver(COMPLETA)))
    for rung_id in ("R1", "R2", "R3", "R5", "R6"):
        assert survey[rung_id]["available"] is True, rung_id
        assert "reason" not in survey[rung_id]


def test_un_escalon_sin_su_herramienta_no_se_anuncia():
    """La regla del catálogo de macros: Hannah no promete lo que no puede hacer.

    Si el escalón se anunciara igual, M5.1.3 le metería la palabra en el prompt,
    ella prometería la vigilancia y el POST la rechazaría después.
    """
    sin_pgrep = dict(COMPLETA)
    del sin_pgrep["pgrep"]
    survey = rungs(sensors.capabilities(resolver(sin_pgrep)))
    assert survey["R1"]["available"] is False
    assert "procps" in survey["R1"]["reason"]
    # Y los que no dependen de pgrep siguen estando.
    assert survey["R2"]["available"] is True
    assert survey["R5"]["available"] is True


def test_sin_herramientas_solo_quedan_los_escalones_de_syscall():
    """El drill de degradación del plan §12, en chiquito: bajo `env -i` la
    escalera se cae sola en vez de romperse al armar."""
    survey = rungs(sensors.capabilities(resolver({})))
    assert [r for r, row in survey.items() if row["available"]] == ["R2", "R3"]


def test_r4_nunca_esta_disponible_aunque_nvidia_smi_exista():
    """R4 corrobora: no puede armar un watch sola (ver test_sensors)."""
    survey = rungs(sensors.capabilities(resolver(COMPLETA)))
    assert survey["R4"]["available"] is False
    assert "corrobora" in survey["R4"]["reason"]


def test_los_escalones_que_no_existen_dicen_cuando_llegan():
    """"not implemented" no le sirve a nadie: el que pregunta quiere saber si es
    un bug o si es el calendario."""
    survey = rungs(sensors.capabilities(resolver(COMPLETA)))
    for rung_id, esperado in (("R6b", "P5.3"), ("R7", "P5.6"), ("R8", "P5.5"),
                              ("R9", "P5.5"), ("R10", "P5.5")):
        assert survey[rung_id]["available"] is False
        assert esperado in survey[rung_id]["reason"], rung_id


def test_r0_no_esta_en_la_escalera_y_la_razon_esta_escrita():
    """R0 (el exit code de un wrapper que arrancó Hannah) no se emite: el enum de
    ids del contrato sense.v1 es R1..R10. No es un olvido, es que en una fase de
    solo observar ella no arranca nada; la razón vive en el código para que quien
    la busque la encuentre."""
    survey = rungs(sensors.capabilities(resolver(COMPLETA)))
    assert "R0" not in survey
    assert "observar" in capability.R0_ABSENT_REASON


def test_los_ids_de_la_escalera_son_exactamente_los_del_contrato():
    ids = [row["id"] for row in sensors.capabilities(resolver(COMPLETA))["rungs"]]
    assert ids == ["R1", "R2", "R3", "R4", "R5", "R6", "R6b", "R7", "R8", "R9", "R10"]


def test_sin_la_tabla_de_rutas_los_escalones_con_ruta_se_bajan(monkeypatch):
    """R2 y R3 clasifican una ruta antes de mirarla; sin el asset del agente no
    pueden armar, así que tampoco se anuncian."""
    import paths
    paths.reset()
    monkeypatch.setenv("HANNAH_AGENT_FIXTURES", "/no/existe/en/ninguna/maquina")
    survey = rungs(sensors.capabilities(resolver(COMPLETA)))
    assert survey["R2"]["available"] is False
    assert survey["R3"]["available"] is False
    assert "HANNAH_AGENT_FIXTURES" in survey["R2"]["reason"]
    # R1 y R5 no tocan rutas: siguen disponibles.
    assert survey["R1"]["available"] is True
    assert survey["R5"]["available"] is True


def test_el_enum_de_kinds_es_cerrado():
    assert sorted(sensors.SENSORS) == ["file", "gpu", "logmatch", "port", "proc", "stub", "unit"]
    with pytest.raises(sensors.SpecError):
        sensors.build({"kind": "shell", "command": "rm -rf ~"})
