# sidecar/sense/tests/conftest.py
"""Arranque común de la suite. Se corre con el venv propio del sidecar:

    cd backend/sidecar/sense && .venv/bin/python -m pytest tests -q

Dos cosas pasan ANTES de importar nada del sidecar, y las dos por el mismo
motivo: los módulos leen el entorno en tiempo de import, así que setearlo dentro
de un test llega tarde.

1. `HANNAH_SENSE_STATE_DIR` se manda a un temporal. Sin esto la suite escribe en
   ~/.local/share/hannah-sense/watches.json y le pisa las vigilancias reales al
   usuario que la corre.
2. `HANNAH_AGENT_DENY_DIRS` se BORRA. Los casos golden del asset declaran cada
   uno el valor que quieren, y una variable heredada del shell (el launcher la
   exporta) cambiaría el veredicto de la mitad de la tabla sin que nadie lo vea.
"""
import os
import sys
import tempfile
from pathlib import Path

_SENSE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SENSE))

os.environ["HANNAH_SENSE_STATE_DIR"] = tempfile.mkdtemp(prefix="hannah-sense-tests-")
os.environ.pop("HANNAH_AGENT_DENY_DIRS", None)

import pytest  # noqa: E402

import capability  # noqa: E402
import paths  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_caches():
    """Cada test arranca sin resolutor fijado y sin cachés. Un `pin()` que se
    filtra al test siguiente es la clase de fixture que hace que la suite pase
    en un orden y falle en otro."""
    yield
    capability.pin(None)
    capability.reset()
    paths.reset()


@pytest.fixture
def fake_path(tmp_path):
    """Una ruta escribible que NO cae en la denylist, para los sensores con ruta."""
    target = tmp_path / "train.log"
    target.write_text("epoch 1\n", encoding="utf-8")
    return str(target)
