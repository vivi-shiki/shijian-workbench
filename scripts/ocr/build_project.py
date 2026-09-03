from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from PIL import Image
from project_data import load_project


ROOT = Path(__file__).resolve().parents[2]


def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def load_previous(project_path: Path) -> dict[str, dict[str, Any]]:
  if not project_path.exists():
    return {}
  project = load_project(project_path)
  previous: dict[str, dict[str, Any]] = {}
  for page in project.get("pages", []):
    for region in page.get("regions", []):
      previous[region["id"]] = region
  return previous


def bbox_from_ndl(raw: dict[str, Any]) -> list[int]:
  points = raw.get("boundingBox") or []
  xs = [int(point[0]) for point in points]
  ys = [int(point[1]) for point in points]
  if not xs or not ys:
    return [0, 0, 1, 1]
  min_x = min(xs)
  min_y = min(ys)
  return [min_x, min_y, max(xs) - min_x, max(ys) - min_y]


def convert_regions_ndl(page_id: str, ocr_json: Path, previous: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
  if not ocr_json.exists():
    return []
  raw = json.loads(ocr_json.read_text(encoding="utf-8"))
  lines = (raw.get("contents") or [[]])[0]
  regions: list[dict[str, Any]] = []
  for index, line in enumerate(lines):
    region_id = f"{page_id}-r{index + 1:03d}"
    old = previous.get(region_id, {})
    raw_text = line.get("text") or ""
    edited_text = old.get("edited_text", raw_text)
    regions.append({
      "id": region_id,
      "order": old.get("order", index + 1),
      "kind": old.get("kind", "main"),
      "direction": old.get("direction", "vertical" if line.get("isVertical") == "true" else "horizontal"),
      "bbox": old.get("bbox", bbox_from_ndl(line)),
      "raw_text": raw_text,
      "edited_text": edited_text,
      "reading_text": old.get("reading_text", ""),
      "confidence": float(line.get("confidence") or 0),
      "status": old.get("status", "needs_review"),
      "notes": old.get("notes", ""),
      "source": {
        "provider": "ndlkotenocr-lite",
        "raw_id": line.get("id")
      },
      "updated_at": old.get("updated_at", now_iso())
    })
  return sorted(regions, key=lambda region: region["order"])


def scalar_text(value: Any) -> str:
  if isinstance(value, str):
    return value.strip()
  if isinstance(value, list) and all(isinstance(item, str) for item in value):
    return "\n".join(item.strip() for item in value if item.strip())
  return ""


def bbox_from_any(value: Any) -> list[int] | None:
  if not isinstance(value, list):
    return None

  if len(value) == 4 and all(isinstance(item, (int, float)) for item in value):
    a, b, c, d = [int(round(item)) for item in value]
    if c > a and d > b:
      return [a, b, c - a, d - b]
    if c > 0 and d > 0:
      return [a, b, c, d]
    return None

  flat_numbers: list[float] = []
  if value and all(isinstance(item, (int, float)) for item in value):
    flat_numbers = [float(item) for item in value]
  elif value and all(isinstance(item, list) for item in value):
    for point in value:
      if len(point) >= 2 and isinstance(point[0], (int, float)) and isinstance(point[1], (int, float)):
        flat_numbers.extend([float(point[0]), float(point[1])])

  if len(flat_numbers) >= 4 and len(flat_numbers) % 2 == 0:
    xs = [int(round(item)) for item in flat_numbers[0::2]]
    ys = [int(round(item)) for item in flat_numbers[1::2]]
    min_x = min(xs)
    min_y = min(ys)
    return [min_x, min_y, max(xs) - min_x, max(ys) - min_y]

  return None


def find_bbox(raw: dict[str, Any]) -> list[int] | None:
  for key in ("block_bbox", "bbox", "box", "coordinate", "poly", "points", "dt_poly", "det_poly"):
    bbox = bbox_from_any(raw.get(key))
    if bbox:
      return bbox
  return None


def find_text(raw: dict[str, Any]) -> str:
  for key in ("block_content", "rec_text", "text", "content", "markdown", "html"):
    text = scalar_text(raw.get(key))
    if text:
      return text
  return ""


def find_confidence(raw: dict[str, Any]) -> float:
  for key in ("score", "confidence", "rec_score", "cls_score"):
    value = raw.get(key)
    if isinstance(value, (int, float)):
      return float(value)
  return 0.0


def find_label(raw: dict[str, Any]) -> str:
  for key in ("block_label", "label", "type", "category", "cls_label"):
    value = raw.get(key)
    if isinstance(value, str) and value.strip():
      return value.strip()
  return ""


def kind_from_paddle_label(label: str) -> str:
  normalized = label.lower()
  if "title" in normalized:
    return "title"
  if any(token in normalized for token in ("footnote", "aside", "reference", "caption")):
    return "note"
  if any(token in normalized for token in ("header", "footer", "number")):
    return "page_mark"
  return "main"


def direction_from_bbox(bbox: list[int]) -> str:
  _, _, width, height = bbox
  return "vertical" if height > width * 1.35 else "horizontal"


def is_plausible_bbox(bbox: list[int], image_width: int, image_height: int) -> bool:
  x, y, width, height = bbox
  if x < 0 or y < 0 or width <= 0 or height <= 0:
    return False
  if x >= image_width or y >= image_height:
    return False
  if width < 20 or height < 20:
    return False
  return True


def iter_paddle_blocks(value: Any) -> Iterable[dict[str, Any]]:
  if isinstance(value, dict):
    texts = value.get("rec_texts")
    polys = value.get("rec_polys") or value.get("dt_polys") or value.get("rec_boxes")
    if isinstance(texts, list) and isinstance(polys, list):
      for index, text in enumerate(texts):
        if index >= len(polys):
          continue
        yield {
          "text": text,
          "bbox": polys[index],
          "score": (value.get("rec_scores") or [0] * len(texts))[index] if isinstance(value.get("rec_scores"), list) and index < len(value.get("rec_scores")) else 0,
          "block_label": value.get("block_label") or value.get("label") or "text",
          "raw_index": index
        }

    if find_text(value) and find_bbox(value):
      yield value
      return

    for child in value.values():
      yield from iter_paddle_blocks(child)
  elif isinstance(value, list):
    for child in value:
      yield from iter_paddle_blocks(child)


def read_paddle_markdown(page_output_dir: Path, page_id: str) -> str:
  candidates = [
    *sorted(page_output_dir.glob("*.md")),
    *sorted(page_output_dir.parent.glob(f"{page_id}*.md"))
  ]
  for candidate in candidates:
    text = candidate.read_text(encoding="utf-8").strip()
    if text:
      return text
  return ""


def paddle_json_candidates(ocr_dir: Path, page_id: str) -> list[Path]:
  page_output_dir = ocr_dir / page_id
  candidates = [
    *sorted(page_output_dir.glob("*.json")),
    *sorted(ocr_dir.glob(f"{page_id}*.json"))
  ]
  return [path for path in candidates if path.name != "run-manifest.json"]


def strip_json_fence(value: str) -> str:
  text = value.strip()
  if text.startswith("```"):
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
      lines = lines[1:]
    if lines and lines[-1].strip() == "```":
      lines = lines[:-1]
    text = "\n".join(lines).strip()
  return text


def json_from_text(value: str) -> Any | None:
  text = strip_json_fence(value)
  if not text:
    return None
  try:
    return json.loads(text)
  except json.JSONDecodeError:
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
      try:
        return json.loads(text[start:end + 1])
      except json.JSONDecodeError:
        return None
  return None


def openaivl_json_candidates(ocr_dir: Path, page_id: str) -> list[Path]:
  page_output_dir = ocr_dir / page_id
  candidates = [
    page_output_dir / f"{page_id}_res.json",
    *sorted(page_output_dir.glob("*.json")),
    *sorted(ocr_dir.glob(f"{page_id}*.json"))
  ]
  unique: list[Path] = []
  seen: set[Path] = set()
  for path in candidates:
    if path.exists() and path.name != "run-manifest.json" and path not in seen:
      unique.append(path)
      seen.add(path)
  return unique


def extract_openaivl_content(raw: dict[str, Any]) -> str:
  content = scalar_text(raw.get("content"))
  if content:
    return content

  response = raw.get("response")
  if not isinstance(response, dict):
    return ""
  choices = response.get("choices")
  if not isinstance(choices, list) or not choices:
    return ""
  first = choices[0]
  if not isinstance(first, dict):
    return ""
  message = first.get("message")
  if not isinstance(message, dict):
    return ""
  message_content = message.get("content")
  if isinstance(message_content, str):
    return message_content.strip()
  if isinstance(message_content, list):
    parts: list[str] = []
    for item in message_content:
      if isinstance(item, dict) and isinstance(item.get("text"), str):
        parts.append(item["text"].strip())
    return "\n".join(part for part in parts if part)
  return ""


def iter_region_like_blocks(value: Any) -> Iterable[dict[str, Any]]:
  if isinstance(value, dict):
    for key in ("regions", "blocks", "items", "lines"):
      if isinstance(value.get(key), list):
        for item in value[key]:
          if isinstance(item, dict):
            yield item
    if find_text(value) and find_bbox(value):
      yield value
  elif isinstance(value, list):
    for item in value:
      if isinstance(item, dict):
        yield from iter_region_like_blocks(item)


def convert_regions_paddlevl(
  page_id: str,
  image_width: int,
  image_height: int,
  ocr_dir: Path,
  previous: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
  candidates = paddle_json_candidates(ocr_dir, page_id)
  blocks: list[tuple[str, list[int], float, str, Path, dict[str, Any]]] = []
  seen: set[tuple[str, tuple[int, int, int, int]]] = set()

  for json_path in candidates:
    raw = json.loads(json_path.read_text(encoding="utf-8"))
    for block in iter_paddle_blocks(raw):
      text = find_text(block)
      bbox = find_bbox(block)
      if not text or not bbox:
        continue
      x, y, width, height = bbox
      if width <= 0 or height <= 0:
        continue
      x = max(0, min(x, image_width - 1))
      y = max(0, min(y, image_height - 1))
      width = max(1, min(width, image_width - x))
      height = max(1, min(height, image_height - y))
      bbox = [x, y, width, height]
      identity = (text, tuple(bbox))
      if identity in seen:
        continue
      seen.add(identity)
      blocks.append((text, bbox, find_confidence(block), find_label(block), json_path, block))

  regions: list[dict[str, Any]] = []
  for index, (text, bbox, confidence, label, json_path, block) in enumerate(blocks):
    region_id = f"{page_id}-pv{index + 1:03d}"
    old = previous.get(region_id, {})
    edited_text = old.get("edited_text", text)
    regions.append({
      "id": region_id,
      "order": old.get("order", index + 1),
      "kind": old.get("kind", kind_from_paddle_label(label)),
      "direction": old.get("direction", direction_from_bbox(bbox)),
      "bbox": old.get("bbox", bbox),
      "raw_text": text,
      "edited_text": edited_text,
      "reading_text": old.get("reading_text", ""),
      "confidence": confidence,
      "status": old.get("status", "needs_review"),
      "notes": old.get("notes", ""),
      "source": {
        "provider": "paddleocr-vl-1.6",
        "raw_id": block.get("raw_index", block.get("block_id", block.get("index", index))),
        "label": label,
        "json": relative_path(json_path)
      },
      "updated_at": old.get("updated_at", now_iso())
    })

  if regions:
    return sorted(regions, key=lambda region: region["order"])

  markdown = read_paddle_markdown(ocr_dir / page_id, page_id)
  if not markdown:
    return []

  region_id = f"{page_id}-pv001"
  old = previous.get(region_id, {})
  return [{
    "id": region_id,
    "order": old.get("order", 1),
    "kind": old.get("kind", "main"),
    "direction": old.get("direction", "horizontal"),
    "bbox": old.get("bbox", [0, 0, image_width, image_height]),
    "raw_text": markdown,
    "edited_text": old.get("edited_text", markdown),
    "reading_text": old.get("reading_text", ""),
    "confidence": 0.0,
    "status": old.get("status", "needs_review"),
    "notes": old.get("notes", "PaddleOCR-VL markdown fallback: no block bbox found."),
    "source": {
      "provider": "paddleocr-vl-1.6",
      "raw_id": "markdown-fallback"
    },
    "updated_at": old.get("updated_at", now_iso())
  }]


def convert_regions_openaivl(
  page_id: str,
  image_width: int,
  image_height: int,
  ocr_dir: Path,
  previous: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
  candidates = openaivl_json_candidates(ocr_dir, page_id)
  blocks: list[tuple[str, list[int], float, str, Path, dict[str, Any]]] = []
  seen: set[tuple[str, tuple[int, int, int, int]]] = set()
  fallback_text = ""
  fallback_json: Path | None = None
  fallback_model = ""

  for json_path in candidates:
    raw = json.loads(json_path.read_text(encoding="utf-8"))
    content = extract_openaivl_content(raw)
    parsed = json_from_text(content) if content else None

    fallback_candidate = ""
    if isinstance(parsed, dict):
      fallback_candidate = scalar_text(parsed.get("text"))
      if not fallback_candidate and isinstance(parsed.get("regions"), list):
        fallback_candidate = "\n".join(
          text for text in (find_text(item) for item in parsed["regions"] if isinstance(item, dict)) if text
        )
    elif content and not strip_json_fence(content).lstrip().startswith(("{", "[")):
      fallback_candidate = content

    if fallback_candidate and not fallback_text:
      fallback_text = fallback_candidate
      fallback_json = json_path
      if isinstance(raw.get("model"), str):
        fallback_model = raw["model"]

    if parsed is None:
      parsed = raw.get("regions") or raw.get("blocks")

    for block in iter_region_like_blocks(parsed):
      text = find_text(block)
      bbox = find_bbox(block)
      if not text or not bbox:
        continue
      x, y, width, height = bbox
      if width <= 0 or height <= 0:
        continue
      x = max(0, min(x, image_width - 1))
      y = max(0, min(y, image_height - 1))
      width = max(1, min(width, image_width - x))
      height = max(1, min(height, image_height - y))
      bbox = [x, y, width, height]
      if not is_plausible_bbox(bbox, image_width, image_height):
        continue
      identity = (text, tuple(bbox))
      if identity in seen:
        continue
      seen.add(identity)
      blocks.append((text, bbox, find_confidence(block), find_label(block), json_path, block))

  regions: list[dict[str, Any]] = []
  for index, (text, bbox, confidence, label, json_path, block) in enumerate(blocks):
    region_id = f"{page_id}-ov{index + 1:03d}"
    old = previous.get(region_id, {})
    regions.append({
      "id": region_id,
      "order": old.get("order", index + 1),
      "kind": old.get("kind", kind_from_paddle_label(label)),
      "direction": old.get("direction", direction_from_bbox(bbox)),
      "bbox": old.get("bbox", bbox),
      "raw_text": text,
      "edited_text": old.get("edited_text", text),
      "reading_text": old.get("reading_text", ""),
      "confidence": confidence,
      "status": old.get("status", "needs_review"),
      "notes": old.get("notes", ""),
      "source": {
        "provider": "openai-compatible-paddleocr-vl",
        "raw_id": block.get("id", block.get("raw_index", block.get("index", index))),
        "label": label,
        "json": relative_path(json_path)
      },
      "updated_at": old.get("updated_at", now_iso())
    })

  if regions:
    return sorted(regions, key=lambda region: region["order"])

  if not fallback_text:
    return []

  region_id = f"{page_id}-ov001"
  old = previous.get(region_id, {})
  return [{
    "id": region_id,
    "order": old.get("order", 1),
    "kind": old.get("kind", "main"),
    "direction": old.get("direction", direction_from_bbox([0, 0, image_width, image_height])),
    "bbox": old.get("bbox", [0, 0, image_width, image_height]),
    "raw_text": fallback_text,
    "edited_text": old.get("edited_text", fallback_text),
    "reading_text": old.get("reading_text", ""),
    "confidence": 0.0,
    "status": old.get("status", "needs_review"),
    "notes": old.get("notes", "OpenAI-compatible PaddleOCR-VL text fallback: no usable bbox returned."),
    "source": {
      "provider": "openai-compatible-paddleocr-vl",
      "raw_id": "page-text",
      "model": fallback_model,
      "json": relative_path(fallback_json) if fallback_json else None
    },
    "updated_at": old.get("updated_at", now_iso())
  }]


def relative_path(path: Path) -> str:
  try:
    return path.relative_to(ROOT).as_posix()
  except ValueError:
    return path.as_posix()


def data_url(path: Path) -> str:
  return f"/{relative_path(path)}"


def paddlevl_display_image(ocr_dir: Path, page_id: str, fallback: Path) -> Path:
  image_path = ocr_dir / page_id / f"{page_id}_output_img.jpg"
  if image_path.exists():
    return image_path
  return fallback


def remote_paddlevl_display_image(ocr_dir: Path, page_id: str, fallback: Path) -> Path:
  image_path = ocr_dir / page_id / f"{page_id}_corrected.jpg"
  if image_path.exists():
    return image_path
  return fallback


def remote_paddlevl_json_candidates(ocr_dir: Path, page_id: str) -> list[Path]:
  page_output_dir = ocr_dir / page_id
  candidates = [
    page_output_dir / f"{page_id}_res.json",
    *sorted(page_output_dir.glob("*.json")),
    *sorted(ocr_dir.glob(f"{page_id}*.json"))
  ]
  unique: list[Path] = []
  seen: set[Path] = set()
  for path in candidates:
    if path.exists() and path.name != "run-manifest.json" and path not in seen:
      unique.append(path)
      seen.add(path)
  return unique


def convert_regions_remote_paddlevl(
  page_id: str,
  image_width: int,
  image_height: int,
  ocr_dir: Path,
  previous: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
  blocks: list[tuple[str, list[int], float, Path, dict[str, Any]]] = []
  for json_path in remote_paddlevl_json_candidates(ocr_dir, page_id):
    raw = json.loads(json_path.read_text(encoding="utf-8"))
    response = raw.get("response") if isinstance(raw.get("response"), dict) else raw
    for index, block in enumerate(response.get("regions") or []):
      if not isinstance(block, dict):
        continue
      text = scalar_text(block.get("text"))
      bbox = bbox_from_any(block.get("polygon") or block.get("box") or block.get("bbox"))
      if not text or not bbox:
        continue
      x, y, width, height = bbox
      x = max(0, min(x, image_width - 1))
      y = max(0, min(y, image_height - 1))
      width = max(1, min(width, image_width - x))
      height = max(1, min(height, image_height - y))
      bbox = [x, y, width, height]
      blocks.append((text, bbox, find_confidence(block), json_path,
        {**block, "raw_index": index, "ocr_model": raw.get("model") or response.get("model")}))

  regions: list[dict[str, Any]] = []
  for index, (text, bbox, confidence, json_path, block) in enumerate(blocks):
    region_id = f"{page_id}-rp{index + 1:03d}"
    old = previous.get(region_id, {})
    regions.append({
      "id": region_id,
      "order": old.get("order", index + 1),
      "kind": old.get("kind", kind_from_paddle_label(block.get("label", ""))),
      "direction": old.get("direction", "vertical" if block.get("label") == "vertical_text" else direction_from_bbox(bbox)),
      "bbox": old.get("bbox", bbox),
      "raw_text": text,
      "edited_text": old.get("edited_text", text),
      "reading_text": old.get("reading_text", ""),
      "confidence": confidence,
      "status": old.get("status", "needs_review"),
      "notes": old.get("notes", ""),
      "source": {
        "provider": "remote-paddlevl",
        "model": block.get("ocr_model"),
        "label": block.get("label"),
        "raw_id": block.get("raw_index", index),
        "polygon": block.get("polygon"),
        "json": relative_path(json_path)
      },
      "updated_at": old.get("updated_at", now_iso())
    })

  return sorted(regions, key=lambda region: region["order"])


def build_project(
  project_id: str,
  title: str,
  source_note: str,
  ocr_provider: str = "ndlkoten",
  pages_project_id: str | None = None,
  ocr_project_id: str | None = None,
  ocr_dir_name_override: str | None = None,
  source_path: Path | None = None,
  total_pages: int | None = None,
  limit: int | None = None,
  preserve_edits: bool = True,
  result_id: str | None = None
) -> dict[str, Any]:
  project_dir = ROOT / "data" / "projects" / project_id
  project_dir.mkdir(parents=True, exist_ok=True)
  pages_project_id = pages_project_id or project_id
  ocr_project_id = ocr_project_id or pages_project_id
  pages_dir = ROOT / "data" / "projects" / pages_project_id / "pages"
  ocr_dir_names = {
    "ndlkoten": "ndlkoten",
    "paddlevl": "paddlevl",
    "openaivl": "openaivl",
    "remotepaddlevl": "remote-paddlevl"
  }
  ocr_dir_name = ocr_dir_name_override or ocr_dir_names[ocr_provider]
  ocr_dir = ROOT / "data" / "projects" / ocr_project_id / "ocr" / ocr_dir_name
  project_path = project_dir / "project.json"
  existing = json.loads(project_path.read_text(encoding="utf-8")) if project_path.exists() else {}
  if existing.get("schema_version") == 2:
    if not result_id:
      raise ValueError("This project has model results. Supply --result-id with a NEW result name; existing edits will not be overwritten.")
    if any(result["id"] == result_id for result in existing["results"]):
      raise ValueError("Result already exists. Use a new --result-id to preserve all previous edits.")

  previous = load_previous(project_path) if preserve_edits and not result_id else {}
  page_files = sorted([*pages_dir.glob("page-*.png"), *pages_dir.glob("page-*.jpg"), *pages_dir.glob("page-*.jpeg")])
  if limit:
    page_files = page_files[:limit]

  pages: list[dict[str, Any]] = []
  for page_file in page_files:
    page_number = int(page_file.stem.split("-")[-1])
    page_id = f"page-{page_number:03d}"
    if ocr_provider == "paddlevl":
      display_page_file = paddlevl_display_image(ocr_dir, page_id, page_file)
    elif ocr_provider == "remotepaddlevl":
      display_page_file = remote_paddlevl_display_image(ocr_dir, page_id, page_file)
    else:
      display_page_file = page_file
    with Image.open(display_page_file) as image:
      width, height = image.size
    if ocr_provider == "paddlevl":
      regions = convert_regions_paddlevl(page_id, width, height, ocr_dir, previous)
    elif ocr_provider == "remotepaddlevl":
      regions = convert_regions_remote_paddlevl(page_id, width, height, ocr_dir, previous)
    elif ocr_provider == "openaivl":
      regions = convert_regions_openaivl(page_id, width, height, ocr_dir, previous)
    else:
      regions = convert_regions_ndl(page_id, ocr_dir / f"{page_id}.json", previous)
    page_status = "done" if regions and all(region["status"] == "reviewed" for region in regions) else "needs_review"
    pages.append({
      "id": page_id,
      "page_number": page_number,
      "image_path": relative_path(display_page_file),
      "source_image_path": relative_path(page_file),
      "image_url": data_url(display_page_file),
      "width": width,
      "height": height,
      "status": page_status,
      "regions": regions
    })

  project = {
    "schema_version": 1,
    "id": project_id,
    "title": title,
    "source": {
      "sample_pages": len(pages),
      "note": source_note,
      "pages_project_id": pages_project_id,
      "ocr_project_id": ocr_project_id
    },
    "workflow": {
      "import": source_note,
      "ocr_provider": {
        "paddlevl": "paddleocr-vl-1.6",
        "openaivl": "openai-compatible-paddleocr-vl",
        "remotepaddlevl": "remote-paddlevl"
      }.get(ocr_provider, "ndlkotenocr-lite"),
      "review": "Edit region text, bbox, order, type, notes, and status.",
      "export": "TXT, Markdown, HTML, and full JSON."
    },
    "pages": pages,
    "created_at": now_iso(),
    "updated_at": now_iso()
  }
  if source_path:
    project["source"]["source_path"] = relative_path(source_path)
  if total_pages:
    project["source"]["source_pages_total"] = total_pages
  if result_id:
    model = next((region["source"].get("model") for page in pages for region in page["regions"]
      if region["source"].get("model")), None)
    if not model and project["workflow"]["ocr_provider"] in ("ndlkotenocr-lite", "paddleocr-vl-1.6"):
      model = project["workflow"]["ocr_provider"]
    result = {"id": result_id, "label": result_id if model else f"Archive ({result_id})", "model": model,
      "provider": project["workflow"]["ocr_provider"], "pages": pages, "workflow": project["workflow"],
      "archived": not bool(model), "status": "complete", "completed_pages": len(pages), "created_at": now_iso()}
    payload = json.dumps({"title": title, "source": project["source"], "result": result}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"http://127.0.0.1:3100/api/projects/{project_id}/results", data=payload,
      headers={"Content-Type": "application/json", "X-Oldbook-Actor": "ai:ocr",
               "X-Oldbook-Source": "project-builder"}, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
      response.read()
  else:
    project_path.write_text(f"{json.dumps(project, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
  return project


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--project-id", required=True)
  parser.add_argument("--pages-project-id", default=None)
  parser.add_argument("--ocr-project-id", default=None)
  parser.add_argument("--ocr-dir-name", default=None)
  parser.add_argument("--ocr-provider", choices=["ndlkoten", "paddlevl", "openaivl", "remotepaddlevl"], default="ndlkoten")
  parser.add_argument("--title", default=None)
  parser.add_argument("--source-note", default=None)
  parser.add_argument("--source-path", default=None)
  parser.add_argument("--total-pages", type=int, default=None)
  parser.add_argument("--limit", type=int, default=None)
  parser.add_argument("--no-preserve-edits", action="store_true")
  parser.add_argument("--result-id", default=None)
  args = parser.parse_args()
  title = args.title or args.project_id
  source_note = args.source_note or "OCR pages imported into the editable document workbench."
  source_path = Path(args.source_path) if args.source_path else None
  total_pages = args.total_pages
  project = build_project(
    project_id=args.project_id,
    title=title,
    source_note=source_note,
    ocr_provider=args.ocr_provider,
    pages_project_id=args.pages_project_id,
    ocr_project_id=args.ocr_project_id,
    ocr_dir_name_override=args.ocr_dir_name,
    source_path=source_path,
    total_pages=total_pages,
    limit=args.limit,
    preserve_edits=not args.no_preserve_edits,
    result_id=args.result_id
  )
  region_count = sum(len(page["regions"]) for page in project["pages"])
  print(f"wrote {ROOT / 'data' / 'projects' / args.project_id / 'project.json'}")
  print(f"pages={len(project['pages'])} regions={region_count}")


if __name__ == "__main__":
  main()
