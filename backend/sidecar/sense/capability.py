# sidecar/sense/capability.py
"""Qué puede vigilar ESTA máquina hoy: la sonda de capacidades de la escalera.

Con la forma de `which`/`whichFirst` de
agent/packages/agent/src/hannah/env.ts, y por la misma razón que dice ahí: nunca
ofrecer algo que no está instalado. Una macro que falla a mitad de camino es peor
que una que nunca se ofreció, porque para entonces Hannah ya dijo que iba a
hacerlo. Acá pesa todavía más: el backend arma el vocabulario de `[WATCH:]` con
esta respuesta (M5.1.3), así que un escalón que se anuncia y no existe es una
vigilancia PROMETIDA que después no arma.

El resolutor es INYECTABLE a propósito. Este repo se comió tres veces el mismo
problema: un fixture que lee el estado real de la máquina pasa donde se escribió
y falla en la de al lado, y el que lo hereda no sabe si rompió algo o si le falta
un paquete. Los tests fijan el resolutor con `pin()` y la escalera contesta lo
mismo en cualquier máquina.

**R0 no está en la escalera de esta fase**, y no es un olvido: R0 es el código de
salida de un wrapper que arrancó Hannah, y en una fase de solo observar (regla
R1) ella no arranca nada, así que no hay wrapper cuyo exit code mirar. El
contrato sense.v1 fija el enum de `rungs[].id` en R1..R10 sin R0, así que la fila
no se emite; la razón queda escrita acá y en el README para que nadie la busque
como bug. Cuando P5.2 despache acciones, R0 entra con su propio sensor.
"""
import logging
import os
import stat
from typing import Callable, Iterable

logger = logging.getLogger(__name__)

#: Un resolutor contesta "dónde está este programa", o None si no está.
Resolver = Callable[[str], str | None]

# Por qué R0 no aparece en /v1/capabilities. Constante y no comentario suelto
# para que un grep por "R0" en este repo caiga en la explicación.
R0_ABSENT_REASON = ("R0 (el exit code de un wrapper) no existe en una fase de solo "
                    "observar: Hannah no arranca nada, así que no hay wrapper que mirar")

_cache: dict[str, str | None] = {}


def which(command: str) -> str | None:
    """Ruta absoluta de `command` en PATH, o None. Sin subprocesos.

    Sin subproceso a propósito: esto lo consulta /v1/capabilities, que el backend
    llama en cada ensamblado de prompt. Un `which(1)` por escalón por turno son
    seis forks para contestar algo que es un stat.
    """
    if os.sep in command:
        return command if _executable(command) else None

    if command in _cache:
        return _cache[command]

    found = None
    for directory in (os.environ.get("PATH") or "").split(os.pathsep):
        if not directory:
            continue
        candidate = os.path.join(directory, command)
        if _executable(candidate):
            found = candidate
            break
    _cache[command] = found
    return found


def which_first(commands: Iterable[str]) -> str | None:
    """El primero de `commands` que exista, por si alguna vez hay dos formas de lo mismo."""
    for command in commands:
        if which(command):
            return command
    return None


def _executable(candidate: str) -> bool:
    try:
        info = os.stat(candidate)
    except OSError:
        return False
    # El bit de ejecución es lo que separa "un archivo que se llama pgrep" del
    # binario pgrep. Un directorio llamado `ss` en PATH pasaría sin el S_ISREG.
    return stat.S_ISREG(info.st_mode) and bool(info.st_mode & 0o111)


def reset() -> None:
    """Costura de test: olvida lo que se encontró en PATH."""
    _cache.clear()


_resolver: Resolver = which


def resolver() -> Resolver:
    """El resolutor vigente. Los sensores pasan por acá y no por `which` directo,
    para que un test pueda hacer que falte `pgrep` sin tocar el PATH del proceso
    (que es global y se filtra al test siguiente)."""
    return _resolver


def pin(resolve: Resolver | None) -> None:
    """Fija el resolutor; None vuelve al real. SOLO tests."""
    global _resolver
    _resolver = resolve or which


# Qué herramienta necesita cada escalón para poder muestrear. Vacío = ninguna:
# R2 (mtime) y R3 (cola de un log) son syscalls, no programas, así que dependen
# de que la ruta sea legible y de nada más.
TOOLS: dict[str, tuple[str, ...]] = {
    "R1": ("pgrep",),
    "R2": (),
    "R3": (),
    "R4": ("nvidia-smi",),
    "R5": ("ss",),
    "R6": ("systemctl",),
}

# Cómo se llama en castellano lo que falta. El operador que escucha "no puedo
# vigilar el puerto" quiere saber qué instalar.
_TOOL_REASON = {
    "pgrep": "falta pgrep (paquete procps-ng)",
    "nvidia-smi": "falta nvidia-smi (driver NVIDIA)",
    "ss": "falta ss (paquete iproute2)",
    "systemctl": "falta systemctl (systemd)",
}


def missing(rung_id: str, resolve: Resolver | None = None) -> tuple[str, ...]:
    """Las herramientas del escalón que no están en esta máquina."""
    lookup = resolve or resolver()
    return tuple(tool for tool in TOOLS.get(rung_id, ()) if not lookup(tool))


def tool_reason(rung_id: str, resolve: Resolver | None = None) -> str | None:
    """None si el escalón tiene sus herramientas; si no, la razón humana."""
    gaps = missing(rung_id, resolve)
    if not gaps:
        return None
    return "; ".join(_TOOL_REASON.get(tool, f"falta {tool}") for tool in gaps)


def require(tool: str, purpose: str) -> str:
    """La ruta absoluta de `tool`, o levanta con una razón que se puede decir.

    La llaman los sensores en `parse()`, o sea al armar: si falta la herramienta
    el POST contesta 400 con esta frase y el usuario se entera ahí. Descubrirlo
    en el primer sample sería un watch que ya se armó y que nunca va a poder
    mirar nada.
    """
    found = resolver()(tool)
    if not found:
        raise LookupError(f"{purpose}: {_TOOL_REASON.get(tool, f'falta {tool}')}")
    return found
