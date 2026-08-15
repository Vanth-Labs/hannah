"""Utilidades compartidas por los sidecars (asr, tts, vision, motion).

Cada sidecar corre desde su propia carpeta (`cd sidecar/<x> && python -m uvicorn main:app`),
así que agregan el directorio padre al sys.path para importar esto:

    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
    from common import preload_cuda_libs
"""
import ctypes
import glob
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Paquetes nvidia cuyas .so hay que precargar (orden importante: nvjitlink primero).
_CUDA_PKGS = ("nvjitlink", "cuda_runtime", "cublas", "cudnn", "cufft", "curand")


def preload_cuda_libs() -> int:
    """Precarga cuBLAS/cuDNN 9 desde el venv de motion (torch cu128).

    CTranslate2 (faster-whisper) y onnxruntime-gpu (Kokoro) las necesitan y NO están
    instaladas en el sistema; el venv de la raíz del workspace sí las trae. Se cargan con
    RTLD_GLOBAL ANTES de crear el modelo. Devuelve cuántas librerías cargó.
    """
    nvidia_dir = Path(__file__).resolve().parents[2] / ".venv" / "lib"
    libs = []
    for pkg in _CUDA_PKGS:
        libs += sorted(glob.glob(
            str(nvidia_dir / "python3*" / "site-packages" / "nvidia" / pkg / "lib" / "*.so*")))
    loaded = 0
    for lib in libs:
        try:
            ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            loaded += 1
        except OSError:
            pass
    logger.info(f"Preloaded {loaded} CUDA libs from motion venv")
    return loaded
