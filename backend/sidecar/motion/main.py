# sidecar/motion/main.py — EMAGE co-speech gesture generation (PantoMatrix)
#
# POST /motion : multipart WAV -> SMPL-X motion {fps, num_frames, poses_b64, trans_b64}
#   poses: (T, 165) axis-angle for the 55 SMPL-X joints, 30 fps, float32 LE
#   trans: (T, 3) global translation, float32 LE
#
# Weights are loaded fully offline from the local PantoMatrix checkout
# (PANTOMATRIX_DIR, default ~/PantoMatrix). Requires torch >= 2.7 (cu128)
# on Blackwell GPUs; falls back to CPU if CUDA is unavailable.

import base64
import io
import logging
import os
import sys
import time

import librosa
import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, File, HTTPException, UploadFile

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PANTOMATRIX_DIR = os.path.expanduser(os.environ.get("PANTOMATRIX_DIR", "~/PantoMatrix"))
if not os.path.isdir(os.path.join(PANTOMATRIX_DIR, "models", "emage_audio")):
    raise RuntimeError(f"PantoMatrix repo not found at {PANTOMATRIX_DIR} (set PANTOMATRIX_DIR)")
sys.path.insert(0, PANTOMATRIX_DIR)

from models.emage_audio import (  # noqa: E402
    EmageAudioModel,
    EmageVAEConv,
    EmageVQModel,
    EmageVQVAEConv,
)

app = FastAPI(title="Hannah Motion Sidecar (EMAGE)", version="1.0.0")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
LOCAL_WEIGHTS = os.path.join(PANTOMATRIX_DIR, "models", "emage_audio")

logger.info(f"Loading EMAGE models from {LOCAL_WEIGHTS} on {DEVICE}...")
_t0 = time.time()

face_vq = EmageVQVAEConv.from_pretrained(LOCAL_WEIGHTS, subfolder="emage_vq/face").to(DEVICE)
upper_vq = EmageVQVAEConv.from_pretrained(LOCAL_WEIGHTS, subfolder="emage_vq/upper").to(DEVICE)
lower_vq = EmageVQVAEConv.from_pretrained(LOCAL_WEIGHTS, subfolder="emage_vq/lower").to(DEVICE)
hands_vq = EmageVQVAEConv.from_pretrained(LOCAL_WEIGHTS, subfolder="emage_vq/hands").to(DEVICE)
global_ae = EmageVAEConv.from_pretrained(LOCAL_WEIGHTS, subfolder="emage_vq/global").to(DEVICE)
motion_vq = EmageVQModel(
    face_model=face_vq, upper_model=upper_vq,
    lower_model=lower_vq, hands_model=hands_vq,
    global_model=global_ae,
).to(DEVICE)
motion_vq.eval()

model = EmageAudioModel.from_pretrained(LOCAL_WEIGHTS).to(DEVICE)
model.eval()

SR = model.cfg.audio_sr          # 16000
POSE_FPS = model.cfg.pose_fps    # 30
# One sliding window is pose_length (64) frames; shorter audio degrades or fails.
MIN_SAMPLES = int((model.cfg.pose_length + 2) * SR / POSE_FPS)  # ~2.2 s

logger.info(f"EMAGE ready on {DEVICE} in {time.time() - _t0:.1f}s (sr={SR}, fps={POSE_FPS})")


def infer_motion(audio_np: np.ndarray) -> dict:
    """Port of test_emage_audio.py::inference(), returning arrays instead of an npz."""
    if audio_np.shape[0] < MIN_SAMPLES:
        audio_np = np.pad(audio_np, (0, MIN_SAMPLES - audio_np.shape[0]))

    audio = torch.from_numpy(audio_np).to(DEVICE).unsqueeze(0)
    speaker_id = torch.zeros(1, 1).long().to(DEVICE)

    with torch.no_grad():
        trans = torch.zeros(1, 1, 3).to(DEVICE)
        latent_dict = model.inference(audio, speaker_id, motion_vq, masked_motion=None, mask=None)

        cfg = model.cfg
        face_latent = latent_dict["rec_face"] if cfg.lf > 0 and cfg.cf == 0 else None
        upper_latent = latent_dict["rec_upper"] if cfg.lu > 0 and cfg.cu == 0 else None
        hands_latent = latent_dict["rec_hands"] if cfg.lh > 0 and cfg.ch == 0 else None
        lower_latent = latent_dict["rec_lower"] if cfg.ll > 0 and cfg.cl == 0 else None

        face_index = torch.max(F.log_softmax(latent_dict["cls_face"], dim=2), dim=2)[1] if cfg.cf > 0 else None
        upper_index = torch.max(F.log_softmax(latent_dict["cls_upper"], dim=2), dim=2)[1] if cfg.cu > 0 else None
        hands_index = torch.max(F.log_softmax(latent_dict["cls_hands"], dim=2), dim=2)[1] if cfg.ch > 0 else None
        lower_index = torch.max(F.log_softmax(latent_dict["cls_lower"], dim=2), dim=2)[1] if cfg.cl > 0 else None

        all_pred = motion_vq.decode(
            face_latent=face_latent, upper_latent=upper_latent,
            lower_latent=lower_latent, hands_latent=hands_latent,
            face_index=face_index, upper_index=upper_index,
            lower_index=lower_index, hands_index=hands_index,
            get_global_motion=True, ref_trans=trans[:, 0],
        )

    t = all_pred["motion_axis_angle"].shape[1]
    poses = all_pred["motion_axis_angle"].cpu().numpy().reshape(t, -1).astype(np.float32)
    trans_pred = all_pred["trans"].cpu().numpy().reshape(t, -1).astype(np.float32)
    return {"poses": poses, "trans": trans_pred, "num_frames": t}


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype="<f4").tobytes()).decode("ascii")


@app.post("/motion")
async def motion(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        audio_np, _ = librosa.load(io.BytesIO(audio_bytes), sr=SR, mono=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot decode audio: {exc}")

    start = time.time()
    try:
        result = infer_motion(audio_np)
    except Exception as exc:
        logger.exception("EMAGE inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}")

    elapsed_ms = round((time.time() - start) * 1000)
    logger.info(f"Motion: {result['num_frames']} frames from {len(audio_np)/SR:.1f}s audio in {elapsed_ms}ms")

    return {
        "fps": POSE_FPS,
        "num_frames": result["num_frames"],
        "poses_b64": _b64(result["poses"]),
        "trans_b64": _b64(result["trans"]),
        "inference_ms": elapsed_ms,
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": "emage_audio", "device": str(DEVICE), "fps": POSE_FPS}
