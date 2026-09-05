# sidecar/vision/main.py
from fastapi import FastAPI
from pydantic import BaseModel
from ultralytics import YOLO
import base64, io, torch
from PIL import Image

app = FastAPI()

# GPU si está disponible, sino CPU
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[YOLO] Usando device: {device}")
model = YOLO("yolov8n.pt")
model.to(device)

class FrameRequest(BaseModel):
    image_base64: str

@app.post("/analyze-scene")
async def analyze_scene(req: FrameRequest):
    img_bytes = base64.b64decode(req.image_base64)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    results = model(img, device=device, verbose=False)

    detections = []
    for box in results[0].boxes:
        label = model.names[int(box.cls)]
        conf = float(box.conf)
        if conf > 0.4:
            detections.append({"label": label, "confidence": round(conf, 2)})

    if detections:
        labels = [d["label"] for d in detections]
        summary = "Detecto: " + ", ".join(set(labels))
    else:
        summary = "No detecto nada relevante en la escena"

    return {"detections": detections, "summary": summary}
