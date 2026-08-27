# sidecar/sense/config.py
"""Perillas de hannah-sense, todas leídas del entorno (plan VIGILANCE §13).

Un único lector de os.environ, igual que backend/src/config.js: si cada módulo
leyera su propia variable nadie podría contestar "¿con qué valores está
corriendo esto?" cuando un watch se comporta raro a las 3am.

Todo viene apagado del lado del backend (SENSE_ENABLED=false); este proceso no
lee esa bandera porque si está corriendo es porque alguien ya lo arrancó.
"""
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# Versión del contrato de cable. Es lo que viaja en el sobre SSE y en /health,
# y lo que el backend compara; no es la versión del paquete.
VERSION = "sense.v1"


def _int_env(name: str, fallback: int, minimum: int = 0) -> int:
    """Entero del entorno, con piso. Un valor basura no debe tirar el proceso al arrancar."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        logger.warning(f"{name}={raw!r} no es un entero; uso {fallback}")
        return fallback
    if value < minimum:
        logger.warning(f"{name}={value} está por debajo del mínimo {minimum}; uso {minimum}")
        return minimum
    return value


# El token del control plane. Vacío = todas las rutas menos /health responden 401
# (ver la nota en main.py: acá NO copiamos el `if (!token) return true` de la fachada).
TOKEN = os.environ.get("HANNAH_SENSE_TOKEN", "").strip()

MAX_WATCHES = _int_env("SENSE_MAX_WATCHES", 2, minimum=1)
MIN_PERIOD_MS = _int_env("SENSE_MIN_PERIOD_MS", 15_000, minimum=1_000)
DEBOUNCE_N = _int_env("SENSE_DEBOUNCE_N", 3, minimum=1)
BLIND_MS = _int_env("SENSE_BLIND_MS", 120_000, minimum=1_000)

# Techo del período: un watch cada seis horas no es un watch, es un olvido.
MAX_PERIOD_MS = 3_600_000
# Techo de la expiración (asunción A3: no hay watches abiertos para siempre).
MAX_TTL_MS = 24 * 60 * 60 * 1000
# Cota de debounceN: más de esto y el watch nunca dispara dentro de su propia vida.
MAX_DEBOUNCE_N = 20

# Un sample que tarda más que esto cuenta como fallado (no como "se paró"): un
# sensor que no puede leer NO tiene derecho a afirmar que la cosa observada murió.
SAMPLE_TIMEOUT_MS = 10_000

# Cotas del cuerpo HTTP y del anillo de eventos, iguales a las de la fachada
# (facade/routes.ts MAX_BODY_BYTES y store.ts DEFAULT_BUFFER).
MAX_BODY_BYTES = 256 * 1024
EVENT_BUFFER = 2000
KEEPALIVE_SECONDS = 15

# Largos máximos del texto que escribe el usuario. Viajan a los logs y al SSE,
# así que se cortan acá y no donde se muestran.
MAX_LABEL_CHARS = 120
MAX_NARRATION_CHARS = 400
MAX_SESSION_ID_CHARS = 128

# Filas terminales que el registro conserva para que el HUD pueda mostrar
# "se desarmó y por qué" sin crecer sin límite.
MAX_TERMINAL_ROWS = 20


def _state_dir() -> Path:
    """Carpeta de estado: ~/.local/share/hannah-sense, literal y a propósito.

    NO se respeta XDG_DATA_HOME: la denylist del agente
    (policy/paths.ts DENIED_DIRECTORIES) lleva esta ruta escrita. Si el estado se
    mudara a donde apunte XDG_DATA_HOME, watches.json quedaría fuera de la lista
    y las herramientas del agente podrían leerlo. El override existe solo para
    los tests y avisa fuerte.
    """
    override = os.environ.get("HANNAH_SENSE_STATE_DIR", "").strip()
    if override:
        logger.warning(
            "HANNAH_SENSE_STATE_DIR está seteado: el estado queda FUERA de la denylist del agente")
        return Path(override).expanduser()
    return Path.home() / ".local" / "share" / "hannah-sense"


STATE_DIR = _state_dir()
WATCHES_FILE = STATE_DIR / "watches.json"
