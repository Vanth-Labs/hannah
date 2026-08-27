# sidecar/sense/paths.py
"""Clasifica una ruta contra la denylist del agente ANTES de tocarla (regla R2).

Observar es ejecutar. `stat`, `tail` y `journalctl` corren con los privilegios
enteros del usuario, así que un sidecar que acepta rutas libres es una primitiva
de lectura que se saltea la denylist del agente completa: un watch podría vigilar
~/.ssh/id_rsa o backend/data/settings.json y contar por SSE cuándo cambian.

La tabla NO se copia a mano. Se lee del asset generado
`agent/docs/fixtures/policy-paths.json`, que sale de
`packages/agent/src/hannah/policy/paths.ts` por `scripts/emit-policy-asset.ts`.
Una segunda copia escrita a mano diverge, y la divergencia se descubre con una
fuga y no con un test (es el mismo argumento que el plan §9 hace para redact.ts).
Lo que sí está duplicado acá es el ALGORITMO de `classify()`, porque no hay forma
de serializarlo; por eso el asset trae `golden` y `tests/test_paths_golden.py`
falla en el momento en que las dos implementaciones dejan de contestar igual.

El orden de las reglas es el de classify() en paths.ts y no es cosmético:
patrones (contra la ruta resuelta Y contra la cruda), después las excepciones de
basename, después los basenames denegados, después los archivos exactos, y al
final los directorios. Mover las excepciones detrás de los basenames haría que
id_ed25519.pub cayera por `^id_[a-z0-9]+$`... y mover los basenames detrás de los
directorios haría que ~/.ssh/id_rsa se denegara por directorio, con OTRA razón.
La razón es lo que Hannah dice en voz alta: tiene que ser la misma cadena que
escucha el usuario cuando le pide al agente leer el mismo archivo.
"""
import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Dónde vive el asset. El nombre de la carpeta del repo del agente cambia según
# el layout (site/install.sh clona `hannah-agent/`, un checkout de desarrollo se
# llama `agent/`), así que se prueban los dos y manda la variable de entorno.
# Mismo orden y misma variable que backend/tests/unit/agentBridge.test.js: una
# sola forma de apuntar los fixtures del otro repo, no dos.
ASSET_NAME = "policy-paths.json"
_REPOS = Path(__file__).resolve().parents[3]


def _candidates() -> list[Path]:
    override = os.environ.get("HANNAH_AGENT_FIXTURES", "").strip()
    if override:
        return [Path(override).expanduser() / ASSET_NAME]
    return [_REPOS / "hannah-agent" / "docs" / "fixtures" / ASSET_NAME,
            _REPOS / "agent" / "docs" / "fixtures" / ASSET_NAME]


class AssetMissing(RuntimeError):
    """No hay tabla de rutas denegadas. Todo lo que lleve ruta falla CERRADO.

    Un `return no-sensible` cuando falta el asset sería exactamente el agujero
    que la regla R2 existe para tapar, y encima uno silencioso: el sidecar
    seguiría armando watches sobre cualquier archivo del disco.
    """


@dataclass(frozen=True)
class Verdict:
    """El veredicto de paths.ts, campo por campo.

    `resolved` no está en el veredicto del agente: es la ruta que de verdad se
    clasificó, y es la que el sensor tiene que usar después. Muestrear la cruda
    después de clasificar la resuelta abriría la ventana entre las dos.
    """
    sensitive: bool
    reason: str | None = None
    rule: str | None = None
    resolved: str = ""


# ── Traducción de las reglas de JS a Python ─────────────────────────────────
def _to_python_source(source: str) -> str:
    r"""Traduce el `$` de JavaScript a `\Z`.

    Es la única diferencia que importa entre los dos motores para estas reglas:
    sin flag `m`, el `$` de JS es fin de cadena y el de Python es fin de cadena
    O justo antes de un \n final. Con el `$` de Python, la EXCEPCIÓN
    `^id_[a-z0-9]+\.pub$` aceptaría "id_rsa.pub\n" y devolvería no-sensible una
    ruta que el agente deniega: una divergencia que abre, no que cierra.

    Se camina el patrón en vez de hacer un replace ciego porque un `$` dentro de
    una clase de caracteres o escapado es un dólar literal, no un ancla.
    """
    out: list[str] = []
    in_class = False
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\\" and index + 1 < len(source):
            out.append(source[index:index + 2])
            index += 2
            continue
        if char == "[":
            in_class = True
        elif char == "]":
            in_class = False
        elif char == "$" and not in_class:
            out.append(r"\Z")
            index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


class _Rule:
    """Una regla del asset con las dos caras que classify() necesita: el objeto
    compilado para probar, y el texto EXACTO que paths.ts pone en `rule`."""

    def __init__(self, entry: Any, *, as_literal: bool) -> None:
        if not isinstance(entry, dict) or not isinstance(entry.get("source"), str):
            raise AssetMissing("una regla del asset no tiene `source`")
        flags = entry.get("flags") or ""
        self.pattern = re.compile(_to_python_source(entry["source"]),
                                  re.IGNORECASE if "i" in flags else 0)
        # paths.ts emite `rule.source` para DENIED_PATTERNS y `String(rule)`
        # (o sea /source/flags) para DENIED_BASENAMES. La diferencia viaja al
        # usuario, así que se reproduce tal cual en vez de normalizarla.
        self.text = f"/{entry['source']}/{flags}" if as_literal else entry["source"]

    def test(self, value: str) -> bool:
        # `search` y no `match`: en JS `regex.test` no ancla, y hay reglas sin `^`
        # ([\\/]hannah-backend[\\/]data([\\/]|$)) que dependen de eso.
        return self.pattern.search(value) is not None


class _Table:
    """El asset ya parseado. Se carga una vez y se cachea: classify() corre en
    cada sample de cada watch."""

    def __init__(self, data: dict[str, Any], origin: Path) -> None:
        self.origin = origin
        self.deny_dirs_env = str(data.get("denyDirsEnv") or "HANNAH_AGENT_DENY_DIRS")
        self.directories = [str(x) for x in data.get("directories") or []]
        self.files = [str(x) for x in data.get("files") or []]
        self.patterns = [_Rule(x, as_literal=False) for x in data.get("patterns") or []]
        self.basenames = [_Rule(x, as_literal=True) for x in data.get("basenames") or []]
        self.exceptions = [_Rule(x, as_literal=True) for x in data.get("exceptions") or []]
        self.golden = list(data.get("golden") or [])
        if not (self.directories and self.files and self.patterns and self.basenames):
            # Un asset truncado que carga a medias es peor que uno que falta:
            # denegaría menos y nadie se enteraría.
            raise AssetMissing(f"el asset {origin} está incompleto")


_table: _Table | None = None
_table_error: str | None = None


def table() -> _Table:
    """La tabla, cargada una sola vez. Levanta AssetMissing si no se puede."""
    global _table, _table_error
    if _table is not None:
        return _table
    tried = _candidates()
    for candidate in tried:
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except OSError:
            continue
        except ValueError as exc:
            raise AssetMissing(f"el asset {candidate} no es JSON válido") from exc
        _table = _Table(data, candidate)
        _table_error = None
        logger.info(f"denylist de rutas cargada de {candidate}")
        return _table
    _table_error = ("no encuentro la tabla de rutas denegadas del agente "
                    f"({ASSET_NAME}); apuntá HANNAH_AGENT_FIXTURES a "
                    "<repo-del-agente>/docs/fixtures")
    raise AssetMissing(_table_error)


def unavailable() -> str | None:
    """La razón por la que no hay tabla, o None si hay. La usa /v1/capabilities
    para bajar los escalones con ruta (R2, R3) en vez de ofrecerlos y fallar al
    armar: un escalón que no se puede cumplir no se anuncia."""
    try:
        table()
    except AssetMissing as exc:
        return str(exc)
    return None


def reset() -> None:
    """Costura de test: olvida la tabla cargada."""
    global _table, _table_error
    _table = None
    _table_error = None


# ── El algoritmo de classify(), portado de paths.ts ─────────────────────────
def _home() -> str:
    # Se lee en cada llamada, como os.homedir() en Node: los tests mueven $HOME.
    return os.path.expanduser("~")


def _normalize(value: str) -> str:
    """path.normalize de Node: resuelve `..` léxicamente y CONSERVA la barra final."""
    trailing = value.endswith("/") and len(value) > 1
    result = os.path.normpath(value)
    # POSIX conserva "//" inicial y Node lo colapsa. Sin esto "//etc/shadow"
    # se compararía distinto en cada lado.
    if result.startswith("//") and not result.startswith("///"):
        result = result[1:]
    if trailing and not result.endswith("/"):
        result += "/"
    return result


def _join(*parts: str) -> str:
    """path.join de Node: pega los no vacíos y normaliza."""
    joined = "/".join(part for part in parts if part)
    return _normalize(joined) if joined else "."


def _absolute(cwd: str, value: str) -> str:
    """path.resolve(cwd, value): absoluta y SIN barra final (a diferencia de join)."""
    result = _normalize(value if value.startswith("/") else _join(cwd, value))
    return result[:-1] if result.endswith("/") and len(result) > 1 else result


_HOME_VAR = re.compile(r"^\$\{HOME\}|^\$HOME(?=/|$)")
_HOME_USER = re.compile(r"^~([a-z_][a-z0-9_-]*)(/|$)", re.IGNORECASE)


def expand(value: str) -> str:
    """`~/x`, `~user/x`, `$HOME/x`, `${HOME}/x`: todas las grafías que honraría un shell."""
    expanded = _HOME_VAR.sub(lambda _: _home(), value, count=1)
    if expanded.startswith("~/") or expanded == "~":
        return _join(_home(), expanded[2:])
    other = _HOME_USER.match(expanded)
    if other:
        return _join(os.path.dirname(_home()), other.group(1), expanded[len(other.group(0)):])
    return expanded


def resolve(value: str, cwd: str) -> str:
    """Resuelve como lo hará el filesystem: expande `~`, absolutiza, normaliza `..`
    y sigue los symlinks hasta donde existan.

    Lo de "hasta donde existan" es lo que impide el truco: el archivo vigilado
    puede todavía no existir (un checkpoint que el entrenamiento no escribió), y
    la carpeta que lo va a contener sí, y ESA carpeta puede ser un symlink a un
    árbol denegado. Se camina al ancestro más cercano que exista, se le hace
    realpath y se vuelven a pegar los pedazos que faltaban.
    """
    absolute = _absolute(cwd, expand(value))
    current = absolute
    trailing: list[str] = []
    for _ in range(64):
        try:
            real = os.path.realpath(current, strict=True)
        except OSError:
            parent = os.path.dirname(current)
            if parent == current:
                break
            trailing.append(os.path.basename(current))
            current = parent
            continue
        return _join(real, *reversed(trailing)) if trailing else real
    return absolute


def _comparable(value: str) -> str:
    """Comparación insensible a mayúsculas donde el filesystem lo es."""
    return value if sys.platform.startswith("linux") else value.lower()


def _is_inside(child: str, parent: str) -> bool:
    a = _comparable(child)
    b = _comparable(parent)
    return a == b or a.startswith(b if b.endswith("/") else b + "/")


def _from_env(rules: _Table) -> list[str]:
    """HANNAH_AGENT_DENY_DIRS, los directorios que agrega ESTA máquina.

    El asset trae el NOMBRE de la variable y no su valor: congelar el valor de
    una máquina en un archivo versionado denegaría esos directorios en todas las
    demás y dejaría los de verdad sin listar. Se saltean las entradas relativas
    porque resolverían contra el cwd de cada tarea, o sea a un directorio
    distinto por tarea.
    """
    raw = os.environ.get(rules.deny_dirs_env)
    if not raw or not raw.strip():
        return []
    result = []
    for entry in raw.split(","):
        expanded = expand(entry.strip())
        if not expanded or not expanded.startswith("/"):
            continue
        result.append(resolve(expanded, "/"))
    return result


# ── El agregado propio del sidecar ──────────────────────────────────────────
# backend/data, resuelto desde ESTE archivo y no por el nombre del repo.
#
# Es el residual del bug B2, escrito en el propio asset ("with nothing in the env
# var, no compiled-in rule covers a checkout named backend/"): la regla compilada
# del agente nombra `hannah-backend/data`, que es la carpeta que crea el
# instalador, y en un checkout de desarrollo la carpeta se llama `backend/`. El
# launcher tapa el hueco pasándole HANNAH_AGENT_DENY_DIRS al agente, pero un
# sidecar arrancado a mano (o por un launcher que todavía no lo conoce) no
# recibe nada, y ahí `backend/data/settings.json` (todas las claves de los
# proveedores en claro) sería vigilable.
#
# Este proceso NO tiene que adivinar la carpeta: vive adentro de ella. La ruta
# sale de __file__ igual que DATA_DIR sale de __dirname en
# backend/src/state/dataDir.js, que es exactamente lo que pedía M5.0.2 ("por
# ruta resuelta, no por nombre de repo"). Denegar de más es la dirección segura;
# la razón que se devuelve tiene la MISMA forma que la del agente cuando el
# launcher sí le pasó el directorio, así que el usuario escucha una sola frase.
_OWN_DATA_DIR = str(Path(__file__).resolve().parents[2] / "data")


def local_directories() -> list[str]:
    """Directorios que este sidecar deniega además de la tabla compartida."""
    return [_OWN_DATA_DIR]


def locally_denied(resolved: str) -> str | None:
    """La razón si `resolved` cae en un directorio propio del sidecar, o None."""
    for directory in local_directories():
        if _is_inside(resolved, directory):
            return f"{directory} is a protected directory"
    return None


def classify(value: str, cwd: str | None = None) -> Verdict:
    """El veredicto de PolicyPaths.classify, con la MISMA razón, para la misma ruta."""
    rules = table()
    anchor = cwd if cwd is not None else os.getcwd()
    if not value:
        return Verdict(sensitive=False, resolved="")
    resolved = resolve(value, anchor)

    for rule in rules.patterns:
        # Contra la resuelta Y contra la cruda expandida: una grafía que no
        # resuelve (un /proc/PID que ya murió) igual tiene que caer.
        if rule.test(resolved) or rule.test(expand(value)):
            return Verdict(True, "process environment or Hannah's own data", rule.text, resolved)

    base = os.path.basename(resolved)

    if any(rule.test(base) for rule in rules.exceptions):
        return Verdict(sensitive=False, resolved=resolved)

    for rule in rules.basenames:
        if rule.test(base):
            return Verdict(True, f'"{base}" is a credential-bearing filename', rule.text, resolved)

    for pattern in rules.files:
        if _comparable(resolved) == _comparable(expand(pattern)):
            return Verdict(True, f"{pattern} holds credentials", pattern, resolved)

    for pattern in [*rules.directories, *_from_env(rules)]:
        if _is_inside(resolved, expand(pattern)):
            return Verdict(True, f"{pattern} is a protected directory", pattern, resolved)

    return Verdict(sensitive=False, resolved=resolved)
