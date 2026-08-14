# sidecar/tts/main.py
import ctypes
import glob
import io
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import soundfile as sf

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Hannah TTS Sidecar", version="1.0.0")


def preload_cuda_libs():
    """El CUDA EP de onnxruntime necesita cuBLAS/cuDNN 9; se toman prestadas
    del venv de motion (torch cu128) precargándolas con RTLD_GLOBAL."""
    nvidia_dir = Path(__file__).resolve().parents[3] / ".venv" / "lib"
    libs = []
    for pkg in ("nvjitlink", "cuda_runtime", "cublas", "cudnn", "cufft", "curand"):
        libs += sorted(glob.glob(str(nvidia_dir / "python3*" / "site-packages" / "nvidia" / pkg / "lib" / "*.so*")))
    for lib in libs:
        try:
            ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
        except OSError:
            pass


kokoro_model = None
if os.environ.get("TTS_DEVICE", "auto") in ("auto", "cuda"):
    try:
        preload_cuda_libs()
        os.environ["ONNX_PROVIDER"] = "CUDAExecutionProvider"
        from kokoro_onnx import Kokoro
        logger.info("Loading Kokoro model (CUDA)...")
        kokoro_model = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
        if "CUDAExecutionProvider" not in kokoro_model.sess.get_providers():
            raise RuntimeError("CUDA EP not active in session")
    except Exception as exc:
        logger.warning(f"CUDA unavailable for Kokoro ({exc}); falling back to CPU")
        kokoro_model = None

if kokoro_model is None:
    os.environ["ONNX_PROVIDER"] = "CPUExecutionProvider"
    from kokoro_onnx import Kokoro
    logger.info("Loading Kokoro model (CPU)...")
    kokoro_model = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")

ACTIVE_PROVIDER = kokoro_model.sess.get_providers()[0]
logger.info(f"Kokoro ready ({ACTIVE_PROVIDER}).")


# Kokoro phonemizes according to `lang`; it must match the voice or the
# pronunciation comes out with a foreign accent (e.g. English text + lang="es"
# sounds like a Spanish speaker reading English).
VOICE_PREFIX_LANG = {
    "a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr",
    "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn",
}


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_bella"
    speed: float = 1.0
    lang: str | None = None  # override; otherwise derived from the voice prefix


@app.post("/v1/audio/speech")
async def synthesize(req: TTSRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="Empty text")

    lang = req.lang or VOICE_PREFIX_LANG.get(req.voice[:1], "en-us")
    samples, sample_rate = kokoro_model.create(
        req.text,
        voice=req.voice,
        speed=req.speed,
        lang=lang,
    )

    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV")
    buffer.seek(0)

    return StreamingResponse(buffer, media_type="audio/wav")


@app.get("/voices")
async def voices():
    """Nombres de voz reales del modelo cargado (para el selector del panel).
    Solo lectura; no sintetiza. La versión del modelo fija qué voces existen."""
    names = []
    try:
        names = list(kokoro_model.get_voices())          # kokoro-onnx expone get_voices()
    except Exception:
        try:
            names = list(kokoro_model.voices.keys())     # fallback: dict interno
        except Exception:
            names = []
    return {"voices": sorted(names)}


@app.get("/health")
async def health():
    return {"status": "ok", "model": "kokoro", "provider": ACTIVE_PROVIDER}
