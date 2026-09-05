# sidecar/sense/sensors/logmatch.py
"""R3 — un patrón aparece en la cola del log.

El patrón es la FRASE QUE SIGNIFICA PROBLEMA, la que el usuario dicta al armar:
"CUDA out of memory", "Traceback", "connection refused". Si aparece, la muestra
es no-sana. Al revés (vigilar que una frase siga apareciendo) es el trabajo de
R2, que mira si el archivo crece y no necesita leer nada.

Lo que este sensor devuelve es `{ matched, count, offset }` y NUNCA la línea
(regla R2, amenaza T9). Una línea de log es texto que escribió otro: puede venir
de un paquete, de una request remota o de un adversario, y la fila del watch
termina pegada al system prompt de la persona en cada turno con acciones. Un
sensor que devolviera la línea sería un punto de inyección permanente mientras el
watch esté armado, y encima uno que se arma solo pidiéndole a Hannah que vigile
un log que alguien más escribe.

El match es PEGAJOSO: una vez que la frase apareció, aparece. Sin eso, el
debounce (N muestras seguidas de acuerdo) no podría dispararse nunca con un
Traceback que se imprime una sola vez, y el evento se perdería justo en el caso
que importa.
"""
import logging
import re
from typing import Any, Mapping

from .base import DETERMINISTIC, Sample, Sensor, SpecError, classify_path, open_watched, register

logger = logging.getLogger(__name__)

MAX_PATTERN_CHARS = 200

# Cuánto se lee por muestra. Un log de entrenamiento escribe megabytes por hora y
# este proceso tiene que seguir vigilando: se lee sólo lo nuevo desde el offset
# anterior, y si lo nuevo es más que esto se lee la cola y se dice en el log del
# sidecar. Leer el archivo entero en cada sample sería un DoS que se hace solo.
MAX_TAIL_BYTES = 1024 * 1024


@register
class LogMatchSensor(Sensor):
    """`{ "kind": "logmatch", "path": "...", "pattern": "..." }`."""

    kind = "logmatch"
    rung = "R3"
    confidence = DETERMINISTIC

    def __init__(self, path: str, pattern: str, compiled: re.Pattern[str]) -> None:
        #: La ruta CRUDA. Se re-clasifica en cada muestra (ver `open_watched`):
        #: guardar la resuelta del arme es lo que dejaba pasar un symlink que
        #: cambiaba de destino después.
        self._path = path
        self._pattern = pattern
        self._compiled = compiled
        #: Byte por el que se venía leyendo. None = todavía no se leyó nada.
        self._offset: int | None = None
        self._matched = False
        self._count = 0

    @classmethod
    def parse(cls, spec: Mapping[str, Any]) -> "LogMatchSensor":
        path = spec.get("path")
        # Al armar se clasifica para que una ruta denegada sea un 403 acá, donde
        # el usuario escucha la razón; lo que se guarda es la cruda.
        classify_path(path)
        pattern = spec.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            raise SpecError("pattern es obligatorio")
        pattern = pattern.strip()
        if len(pattern) > MAX_PATTERN_CHARS:
            raise SpecError(f"pattern supera {MAX_PATTERN_CHARS} caracteres")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise SpecError(f"pattern no es una expresión regular válida: {exc.msg}") from exc
        return cls(path, pattern, compiled)

    async def sample(self) -> Sample:
        with open_watched(self._path) as watched:
            # `closefd=False`: el descriptor es de `open_watched`, que lo cierra
            # él. Se envuelve para leer con la semántica de siempre (un `os.read`
            # suelto puede devolver menos bytes de los pedidos).
            with open(watched.fd, "rb", closefd=False) as handle:
                size = watched.info.st_size
                start = self._start_from(size)
                handle.seek(start)
                chunk = handle.read(MAX_TAIL_BYTES)

        self._offset = start + len(chunk)
        # "replace" y no "strict": un log binario a medias no puede tirar un
        # watch, y el patrón sigue buscándose en lo que sí se pudo decodificar.
        hits = len(self._compiled.findall(chunk.decode("utf-8", "replace")))
        if hits:
            self._matched = True
            self._count += hits
        return Sample(
            healthy=not self._matched,
            # matched, count y offset. Ni una letra de lo que decía la línea.
            detail={"matched": self._matched, "count": self._count, "offset": self._offset},
        )

    def _start_from(self, size: int) -> int:
        """Desde qué byte leer. Cubre la rotación y el archivo que se adelantó."""
        if self._offset is None:
            # Primera muestra: se ancla en el FINAL. Lo que ya estaba en el log
            # cuando el usuario armó el watch es historia, no un evento nuevo, y
            # contarlo dispararía al instante por el Traceback de la corrida
            # anterior, que es el caso más común de todos. El escalón se llama
            # "un patrón APARECE en la cola", y aparecer es algo que pasa después
            # de armar.
            return size
        if size < self._offset:
            # El archivo se achicó: lo rotaron o lo truncaron. Se vuelve a cero.
            return 0
        if size - self._offset > MAX_TAIL_BYTES:
            # Se escribió más de lo que se lee por muestra: se lee la cola y se
            # avisa. Es una pérdida real y no se disimula: el patrón pudo haber
            # pasado por el hueco, así que el silencio de este sensor deja de ser
            # una prueba de que no pasó nada.
            logger.warning(f"logmatch salteó {size - self._offset - MAX_TAIL_BYTES} bytes: "
                           "el log crece más rápido que el período de muestreo")
            return size - MAX_TAIL_BYTES
        return self._offset
