# sidecar/sense/tests/test_platforms.py
"""La escalera en macOS y Windows, probada desde Linux con la plataforma fijada.

R1 (proceso) y R5 (puerto) miran lo mismo en todas partes, con la herramienta de
cada sistema: pgrep/ss en Linux, pgrep/lsof en macOS, psutil en Windows. R6
(systemd) solo existe en Linux y fuera de él se anuncia como no disponible con
una razón que lo dice. Nada de esto ejecuta un programa de verdad.
"""
import asyncio
import sys
import types

import pytest

import capability
import sensors
from sensors import base


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _real_platform_back():
    yield
    capability.pin_platform(None)


@pytest.fixture
def argv_spy(monkeypatch):
    calls: list[tuple] = []
    result = {"code": 0, "out": b"", "err": b""}

    class _Proc:
        def __init__(self):
            self.returncode = result["code"]

        async def communicate(self):
            return result["out"], result["err"]

    async def fake_exec(*argv, **kwargs):
        calls.append(argv)
        return _Proc()

    monkeypatch.setattr(base.asyncio, "create_subprocess_exec", fake_exec)
    return calls, result


@pytest.fixture
def fake_psutil(monkeypatch):
    """Un psutil de mentira: procesos y sockets que decide el test."""
    module = types.ModuleType("psutil")
    module.Error = Exception
    module.CONN_LISTEN = "LISTEN"
    state = {"procs": [], "conns": []}

    class _P:
        def __init__(self, name, cmdline):
            self.info = {"name": name, "cmdline": cmdline}

    def process_iter(attrs=None):
        return [_P(n, c) for n, c in state["procs"]]

    def net_connections(kind="inet"):
        return list(state["conns"])

    module.process_iter = process_iter
    module.net_connections = net_connections
    monkeypatch.setitem(sys.modules, "psutil", module)
    # the capability probe resolves "python:psutil" through find_spec: pin it found
    capability.pin(lambda c: "/venv/psutil/__init__.py" if c == "python:psutil" else None)
    return state


def test_las_herramientas_cambian_con_la_plataforma():
    capability.pin_platform("linux")
    assert capability.tools_for("R1") == ("pgrep",) and capability.tools_for("R5") == ("ss",)
    capability.pin_platform("darwin")
    assert capability.tools_for("R1") == ("pgrep",) and capability.tools_for("R5") == ("lsof",)
    capability.pin_platform("win32")
    assert capability.tools_for("R1") == ("python:psutil",) and capability.tools_for("R5") == ("python:psutil",)
    assert capability.tools_for("R6") == ("systemctl",)   # y nunca está: systemd es de Linux


def test_r6_fuera_de_linux_dice_por_que():
    capability.pin_platform("darwin")
    capability.pin(lambda c: "/usr/bin/pgrep" if c in ("pgrep", "lsof") else None)
    assert "Linux" in (capability.tool_reason("R6") or "")


def test_windows_proceso_con_psutil_sin_subproceso(argv_spy, fake_psutil):
    capability.pin_platform("win32")
    calls, _ = argv_spy
    fake_psutil["procs"] = [("python.exe", ["python.exe", "train.py", "--epochs", "3"]), ("explorer.exe", [])]
    sensor = sensors.build({"kind": "proc", "pattern": r"train\.py"})
    sample = run(sensor.sample())
    assert sample.healthy is True and sample.detail["count"] == 1
    fake_psutil["procs"] = [("explorer.exe", [])]
    assert run(sensor.sample()).healthy is False
    assert calls == []   # ni un solo subproceso


def test_windows_puerto_con_psutil(argv_spy, fake_psutil):
    capability.pin_platform("win32")
    conn = types.SimpleNamespace
    addr = types.SimpleNamespace(port=8005)
    fake_psutil["conns"] = [conn(laddr=addr, status="LISTEN", type=1), conn(laddr=types.SimpleNamespace(port=80), status="LISTEN", type=1)]
    sensor = sensors.build({"kind": "port", "port": 8005})
    assert run(sensor.sample()).detail["sockets"] == 1
    fake_psutil["conns"] = [conn(laddr=addr, status="ESTABLISHED", type=1)]   # abierto no es escuchando
    assert run(sensor.sample()).healthy is False
    fake_psutil["conns"] = [conn(laddr=addr, status="NONE", type=2)]          # UDP no tiene estado
    assert run(sensor.sample()).healthy is True


def test_windows_sin_psutil_no_arma():
    capability.pin_platform("win32")
    capability.pin(lambda c: None)
    with pytest.raises(sensors.SpecError) as error:
        sensors.build({"kind": "proc", "pattern": "train.py"})
    assert "psutil" in str(error.value)


def test_macos_puerto_con_lsof_tcp_y_udp(argv_spy):
    capability.pin_platform("darwin")
    capability.pin(lambda c: f"/usr/sbin/{c}" if c in ("lsof", "pgrep") else None)
    calls, result = argv_spy
    sensor = sensors.build({"kind": "port", "port": 8005})
    result["code"], result["out"] = 1, b""          # lsof: 1 = nada encontrado, no una falla
    assert run(sensor.sample()).healthy is False
    assert [c[0] for c in calls] == ["/usr/sbin/lsof", "/usr/sbin/lsof"]
    assert "-iTCP:8005" in calls[0] and "-sTCP:LISTEN" in calls[0] and "-iUDP:8005" in calls[1]
    assert "-t" in calls[0]                          # solo PIDs: ninguna dirección sale del sensor
    result["code"], result["out"] = 0, b"4242\n"
    assert run(sensor.sample()).healthy is True
    result["code"] = 2
    with pytest.raises(sensors.SensorFault):
        run(sensor.sample())


def test_macos_proceso_sigue_siendo_pgrep(argv_spy):
    capability.pin_platform("darwin")
    capability.pin(lambda c: f"/usr/bin/{c}" if c in ("lsof", "pgrep") else None)
    calls, result = argv_spy
    sensor = sensors.build({"kind": "proc", "pattern": "train.py"})
    result["code"], result["out"] = 0, b"1\n"
    assert run(sensor.sample()).healthy is True
    assert calls[0][0] == "/usr/bin/pgrep" and calls[0][-1] == "train.py"


def test_las_capacidades_de_windows_anuncian_r1_y_r5(fake_psutil):
    capability.pin_platform("win32")
    caps = sensors.capabilities()
    rungs = {r["id"]: r for r in caps["rungs"]}
    assert rungs["R1"]["available"] and rungs["R5"]["available"]
    assert not rungs["R6"]["available"] and "Linux" in (rungs["R6"].get("reason") or "")
