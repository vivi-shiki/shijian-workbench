from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageDraw


APP_ROOT = Path(__file__).resolve().parent
OUTPUT_ROOT = APP_ROOT / "outputs"
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

PIPELINE_VERSION = os.environ.get("PADDLEOCR_VL_PIPELINE_VERSION", "v1.6")
DEVICE = os.environ.get("PADDLEOCR_VL_DEVICE", "gpu:0")
ENGINE = os.environ.get("PADDLEOCR_VL_ENGINE") or None
PRECISION = os.environ.get("PADDLEOCR_VL_PRECISION") or None

PIPELINES: dict[bool, Any] = {}

app = FastAPI(
  title="PaddleOCR-VL Native Service",
  description="Native PaddleOCRVL pipeline service for old-book OCR workbench.",
  version="1.0.0"
)


def build_pipeline(unwarp: bool) -> Any:
  from paddleocr import PaddleOCRVL

  kwargs: dict[str, Any] = {
    "pipeline_version": PIPELINE_VERSION,
    "device": DEVICE,
    "use_doc_orientation_classify": True,
    "use_doc_unwarping": unwarp,
    "use_layout_detection": True
  }
  if ENGINE:
    kwargs["engine"] = ENGINE
  if PRECISION:
    kwargs["precision"] = PRECISION

  while True:
    try:
      return PaddleOCRVL(**kwargs)
    except ValueError as exc:
      match = re.search(r"Unknown argument: ([A-Za-z0-9_]+)", str(exc))
      if not match:
        raise
      unknown = match.group(1)
      if unknown not in kwargs:
        raise
      del kwargs[unknown]


def get_pipeline(unwarp: bool) -> Any:
  if unwarp not in PIPELINES:
    PIPELINES[unwarp] = build_pipeline(unwarp)
  return PIPELINES[unwarp]


def as_python(value: Any) -> Any:
  if isinstance(value, np.ndarray):
    return value.tolist()
  if isinstance(value, np.generic):
    return value.item()
  if isinstance(value, dict):
    return {str(key): as_python(item) for key, item in value.items()}
  if isinstance(value, (list, tuple)):
    return [as_python(item) for item in value]
  return value


def bbox_from_any(value: Any) -> list[float] | None:
  value = as_python(value)
  if not isinstance(value, list):
    return None
  if len(value) == 4 and all(isinstance(item, (int, float)) for item in value):
    x1, y1, x2, y2 = [float(item) for item in value]
    if x2 > x1 and y2 > y1:
      return [x1, y1, x2, y2]
    if x2 > 0 and y2 > 0:
      return [x1, y1, x1 + x2, y1 + y2]
  if value and all(isinstance(item, list) for item in value):
    xs: list[float] = []
    ys: list[float] = []
    for point in value:
      if len(point) >= 2 and isinstance(point[0], (int, float)) and isinstance(point[1], (int, float)):
        xs.append(float(point[0]))
        ys.append(float(point[1]))
    if xs and ys:
      return [min(xs), min(ys), max(xs), max(ys)]
  return None


def polygon_from_bbox(bbox: list[float]) -> list[list[float]]:
  x1, y1, x2, y2 = bbox
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def get_result_dict(result: Any) -> dict[str, Any]:
  if hasattr(result, "get"):
    return result
  if hasattr(result, "to_dict"):
    return result.to_dict()
  return dict(result)


def save_corrected_image(result: dict[str, Any], fallback: Path, output_path: Path) -> tuple[int, int]:
  doc_preprocessor_res = result.get("doc_preprocessor_res") if isinstance(result.get("doc_preprocessor_res"), dict) else {}
  output_img = doc_preprocessor_res.get("output_img")
  if output_img is not None:
    array = np.asarray(output_img)
    if array.ndim == 3 and array.shape[2] >= 3:
      image = Image.fromarray(array[:, :, :3][:, :, ::-1].astype("uint8"))
      image.save(output_path, quality=95, optimize=True)
      return image.size

  with Image.open(fallback) as image:
    rgb = image.convert("RGB")
    rgb.save(output_path, quality=95, optimize=True)
    return rgb.size


def regions_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
  regions: list[dict[str, Any]] = []
  parsing_res_list = result.get("parsing_res_list") or []
  if not isinstance(parsing_res_list, list):
    return regions

  for index, block in enumerate(parsing_res_list):
    if not isinstance(block, dict):
      continue
    text = str(block.get("block_content") or block.get("text") or "").strip()
    bbox = bbox_from_any(block.get("block_bbox") or block.get("bbox") or block.get("box") or block.get("polygon"))
    if not text or bbox is None:
      continue
    regions.append({
      "text": text,
      "confidence": float(block.get("confidence") or block.get("score") or 0),
      "polygon": polygon_from_bbox(bbox),
      "box": bbox,
      "label": str(block.get("block_label") or block.get("label") or "text"),
      "index": index
    })
  return regions


def draw_boxes(image_path: Path, regions: list[dict[str, Any]], output_path: Path) -> None:
  with Image.open(image_path) as image:
    canvas = image.convert("RGB")
  draw = ImageDraw.Draw(canvas)
  for index, region in enumerate(regions, start=1):
    polygon = region.get("polygon") or polygon_from_bbox(region["box"])
    points = [(float(point[0]), float(point[1])) for point in polygon]
    draw.line(points + [points[0]], fill=(0, 160, 60), width=3)
    x = min(point[0] for point in points)
    y = min(point[1] for point in points)
    draw.text((x, max(0, y - 16)), str(index), fill=(220, 0, 0))
  canvas.save(output_path, quality=95, optimize=True)


@app.get("/health")
def health() -> dict[str, Any]:
  return {
    "status": "ready",
    "pipeline": "PaddleOCRVL",
    "model": "PaddleOCR-VL-1.6",
    "pipeline_version": PIPELINE_VERSION,
    "device": DEVICE,
    "engine": ENGINE or "paddle",
    "precision": PRECISION,
    "loaded_unwarp_modes": sorted(str(key).lower() for key in PIPELINES.keys())
  }


@app.post("/ocr")
async def recognize(
  file: UploadFile = File(...),
  unwarp: bool = Query(True, description="Enable document unwarping for photographed pages.")
) -> dict[str, Any]:
  identifier = str(uuid.uuid4())
  item_dir = OUTPUT_ROOT / identifier
  item_dir.mkdir(parents=True, exist_ok=True)
  suffix = Path(file.filename or "image.jpg").suffix or ".jpg"
  input_path = item_dir / f"input{suffix}"
  corrected_path = item_dir / "corrected.jpg"
  boxes_path = item_dir / "boxes.jpg"

  with input_path.open("wb") as output:
    shutil.copyfileobj(file.file, output)

  try:
    with Image.open(input_path) as image:
      original_size = list(image.size)
  except Exception as exc:
    raise HTTPException(status_code=400, detail="Uploaded file is not a readable image") from exc

  started = time.perf_counter()
  pipeline = get_pipeline(unwarp)
  output = pipeline.predict(str(input_path))
  results = [get_result_dict(item) for item in output]
  if not results:
    raise HTTPException(status_code=500, detail="PaddleOCRVL returned no result")

  result = results[0]
  corrected_size = list(save_corrected_image(result, input_path, corrected_path))
  regions = regions_from_result(result)
  draw_boxes(corrected_path, regions, boxes_path)

  text = "\n".join(region["text"] for region in regions).strip()
  raw_path = item_dir / "raw.json"
  raw_path.write_text(json.dumps(as_python(result), ensure_ascii=False, indent=2), encoding="utf-8")

  doc_preprocessor_res = result.get("doc_preprocessor_res") if isinstance(result.get("doc_preprocessor_res"), dict) else {}
  elapsed = time.perf_counter() - started
  return {
    "id": identifier,
    "text": text,
    "regions": regions,
    "coordinate_space": "corrected_image",
    "original_size": original_size,
    "corrected_size": corrected_size,
    "document_orientation_degrees": int(doc_preprocessor_res.get("angle") or 0),
    "unwarping_enabled": unwarp,
    "corrected_image_url": f"/images/{identifier}/corrected.jpg",
    "boxes_image_url": f"/images/{identifier}/boxes.jpg",
    "elapsed_seconds": elapsed,
    "images_expire_at": time.time() + 86400
  }


@app.get("/images/{identifier}/{kind}.jpg")
def get_image(identifier: str, kind: str) -> FileResponse:
  if kind not in {"corrected", "boxes"}:
    raise HTTPException(status_code=404, detail="Unknown image kind")
  path = OUTPUT_ROOT / identifier / f"{kind}.jpg"
  if not path.exists():
    raise HTTPException(status_code=404, detail="Image not found")
  return FileResponse(path, media_type="image/jpeg")
