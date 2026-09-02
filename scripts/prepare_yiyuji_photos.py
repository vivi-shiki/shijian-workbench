from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIR = ROOT / "data" / "projects" / "yiyuji-photos"
ORIGINALS_DIR = PROJECT_DIR / "originals"
PAGES_DIR = PROJECT_DIR / "pages"
MANIFEST_PATH = PROJECT_DIR / "source-images.json"


# Telegram stripped EXIF orientation, so these are explicit page rotations.
# Pillow positive angles rotate counter-clockwise.
ROTATIONS = {
  "photo-001.jpg": 90,
  "photo-002.jpg": 90,
  "photo-003.jpg": 90,
  "photo-004.jpg": 90,
  "photo-005.jpg": 90,
  "photo-006.jpg": 0
}


def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def main() -> None:
  PAGES_DIR.mkdir(parents=True, exist_ok=True)
  manifest = {
    "project_id": "yiyuji-photos",
    "title": "疑雨集註 手机照片测试",
    "created_at": now_iso(),
    "images": []
  }

  preview_items: list[tuple[str, Image.Image]] = []
  for index, src in enumerate(sorted(ORIGINALS_DIR.glob("photo-*.jpg")), start=1):
    angle = ROTATIONS.get(src.name, 0)
    with Image.open(src) as original:
      image = ImageOps.exif_transpose(original).convert("RGB")
      if angle:
        image = image.rotate(angle, expand=True)
      output = PAGES_DIR / f"page-{index:03d}.jpg"
      image.save(output, quality=95, optimize=True)

      thumb = image.copy()
      thumb.thumbnail((220, 300))
      preview_items.append((output.name, thumb))

      manifest["images"].append({
        "page": index,
        "original": src.relative_to(ROOT).as_posix(),
        "image_path": output.relative_to(ROOT).as_posix(),
        "rotation_degrees": angle,
        "width": image.width,
        "height": image.height
      })

  MANIFEST_PATH.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")

  if preview_items:
    cell_w = 240
    cell_h = 336
    sheet = Image.new("RGB", (cell_w * len(preview_items), cell_h), "white")
    draw = ImageDraw.Draw(sheet)
    for index, (name, thumb) in enumerate(preview_items):
      x = index * cell_w + (cell_w - thumb.width) // 2
      y = 28 + (300 - thumb.height) // 2
      draw.text((index * cell_w + 12, 8), name, fill=(20, 20, 20))
      sheet.paste(thumb, (x, y))
    sheet.save(PROJECT_DIR / "orientation-preview.jpg", quality=92)

  print(f"prepared {len(manifest['images'])} pages in {PAGES_DIR}")
  print(f"wrote {MANIFEST_PATH}")


if __name__ == "__main__":
  main()
