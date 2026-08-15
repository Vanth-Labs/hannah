# sidecar/asr/main.py
import ctypes
import glob
import io
import logging
import os
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))
from common import preload_cuda_libs   # noqa: E402  (helper compartido de los sidecars)

app = FastAPI(title="Hannah ASR Sidecar", version="1.0.0")



WHISPER_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE_PREF = os.environ.get("ASR_DEVICE", "auto")  # auto | cuda | cpu

whisper_model = None
DEVICE = "cpu"
if DEVICE_PREF in ("auto", "cuda"):
    try:
        preload_cuda_libs()
        logger.info(f"Loading Whisper model ({WHISPER_SIZE}) on CUDA...")
        whisper_model = WhisperModel(WHISPER_SIZE, device="cuda", compute_type="float16")
        DEVICE = "cuda"
    except Exception as exc:
        logger.warning(f"CUDA unavailable for faster-whisper ({exc}); falling back to CPU")

if whisper_model is None:
    logger.info(f"Loading Whisper model ({WHISPER_SIZE}) on CPU...")
    whisper_model = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")

logger.info(f"Whisper ready on {DEVICE}.")


@app.post("/asr")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(""),   # "" = auto-detect
    model: str = Form("small"),
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    segments, info = whisper_model.transcribe(
        io.BytesIO(audio_bytes),
        language=language or None,
        beam_size=5,
        vad_filter=True,
    )

    transcript = " ".join(seg.text for seg in segments).strip()
    # Solo metadata (regla del proyecto: nunca loguear contenido del usuario).
    logger.info(f"ASR done: {len(transcript)} chars, lang={info.language} p={info.language_probability:.2f}")

    return {
        "transcript": transcript,
        "language": info.language,
        "confidence": round(info.language_probability, 3),
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": f"whisper-{WHISPER_SIZE}", "device": DEVICE}
