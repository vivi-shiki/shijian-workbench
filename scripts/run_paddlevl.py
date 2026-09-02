from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def parse_pages(value: str | None) -> set[int] | None:
  if not value:
    return None
  pages: set[int] = set()
  for part in value.split(","):
    part = part.strip()
    if not part:
      continue
    if "-" in part:
      start, end = part.split("-", 1)
      pages.update(range(int(start), int(end) + 1))
    else:
      pages.add(int(part))
  return pages


def page_number(path: Path) -> int:
  return int(path.stem.split("-")[-1])


def page_id(path: Path) -> str:
  return f"page-{page_number(path):03d}"


def relative_path(path: Path) -> str:
  try:
    return path.relative_to(ROOT).as_posix()
  except ValueError:
    return path.as_posix()


def find_project_pages(project_id: str, pages_arg: str | None, limit: int | None) -> list[Path]:
  project_dir = ROOT / "data" / "projects" / project_id
  pages_dir = project_dir / "pages"
  wanted = parse_pages(pages_arg)
  files = sorted([*pages_dir.glob("page-*.png"), *pages_dir.glob("page-*.jpg"), *pages_dir.glob("page-*.jpeg")])
  if wanted is not None:
    files = [path for path in files if page_number(path) in wanted]
  if limit is not None:
    files = files[:limit]
  if not files:
    raise SystemExit(f"No page images found in {pages_dir}")
  return files


def saved_result_files(output_dir: Path) -> dict[str, list[str]]:
  groups: dict[str, list[str]] = {}
  for suffix in ("*.json", "*.md", "*.docx", "*.jpg", "*.png"):
    groups[suffix[2:]] = [relative_path(path) for path in sorted(output_dir.glob(suffix))]
  return groups


def save_output_image(result: Any, page_output_dir: Path, pid: str) -> str | None:
  doc_preprocessor_res = result.get("doc_preprocessor_res") if hasattr(result, "get") else None
  if not doc_preprocessor_res:
    return None

  output_img = doc_preprocessor_res.get("output_img") if hasattr(doc_preprocessor_res, "get") else None
  if output_img is None:
    return None

  from PIL import Image

  image_path = page_output_dir / f"{pid}_output_img.jpg"
  image = Image.fromarray(output_img[:, :, ::-1])
  image.save(image_path, quality=95, optimize=True)
  return relative_path(image_path)


def build_pipeline(args: argparse.Namespace) -> Any:
  try:
    from paddleocr import PaddleOCRVL
  except ImportError as exc:
    raise SystemExit(
      "PaddleOCR-VL is not installed in this Python environment. "
      "Use .venv_paddlevl and install paddlepaddle-gpu plus paddleocr[doc-parser]."
    ) from exc

  kwargs: dict[str, Any] = {
    "pipeline_version": args.pipeline_version,
    "device": args.device,
    "use_doc_orientation_classify": args.use_doc_orientation_classify,
    "use_doc_unwarping": args.use_doc_unwarping,
    "use_layout_detection": args.use_layout_detection
  }
  if args.engine:
    kwargs["engine"] = args.engine
  if args.precision:
    kwargs["precision"] = args.precision
  if args.min_pixels is not None:
    kwargs["min_pixels"] = args.min_pixels
  if args.max_pixels is not None:
    kwargs["max_pixels"] = args.max_pixels

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
      print(f"ignore unsupported PaddleOCRVL argument: {unknown}")
      del kwargs[unknown]


def main() -> None:
  parser = argparse.ArgumentParser(description="Run PaddleOCR-VL on project page images.")
  parser.add_argument("--project-id", required=True, help="Project whose pages/ directory will be used.")
  parser.add_argument("--pages", default=None, help="Page numbers, e.g. 1,3,6 or 1-6.")
  parser.add_argument("--limit", type=int, default=None)
  parser.add_argument("--device", default="gpu:0")
  parser.add_argument("--engine", default=None)
  parser.add_argument("--precision", default=None)
  parser.add_argument("--min-pixels", type=int, default=None)
  parser.add_argument("--max-pixels", type=int, default=None)
  parser.add_argument("--pipeline-version", default="v1.6")
  parser.add_argument("--layout-shape-mode", default="quad")
  parser.add_argument("--force", action="store_true")
  parser.add_argument("--no-orientation", dest="use_doc_orientation_classify", action="store_false")
  parser.add_argument("--no-unwarping", dest="use_doc_unwarping", action="store_false")
  parser.add_argument("--no-layout", dest="use_layout_detection", action="store_false")
  parser.set_defaults(
    use_doc_orientation_classify=True,
    use_doc_unwarping=True,
    use_layout_detection=True
  )
  args = parser.parse_args()

  pages = find_project_pages(args.project_id, args.pages, args.limit)
  output_root = ROOT / "data" / "projects" / args.project_id / "ocr" / "paddlevl"
  output_root.mkdir(parents=True, exist_ok=True)

  pipeline = build_pipeline(args)
  manifest = {
    "provider": "paddleocr-vl",
    "pipeline_version": args.pipeline_version,
    "device": args.device,
    "engine": args.engine or "paddle",
    "use_doc_orientation_classify": args.use_doc_orientation_classify,
    "use_doc_unwarping": args.use_doc_unwarping,
    "use_layout_detection": args.use_layout_detection,
    "layout_shape_mode": args.layout_shape_mode,
    "started_at": now_iso(),
    "pages": []
  }

  for page_file in pages:
    pid = page_id(page_file)
    page_output_dir = output_root / pid
    if args.force and page_output_dir.exists():
      shutil.rmtree(page_output_dir)
    page_output_dir.mkdir(parents=True, exist_ok=True)
    has_json = list(page_output_dir.glob("*.json"))
    has_output_image = (page_output_dir / f"{pid}_output_img.jpg").exists()
    if not args.force and has_json and has_output_image:
      print(f"skip {pid}: existing PaddleOCR-VL JSON and output image")
      manifest["pages"].append({
        "page_id": pid,
        "input": relative_path(page_file),
        "skipped": True,
        "outputs": saved_result_files(page_output_dir)
      })
      continue

    print(f"run {pid}: {relative_path(page_file)}")
    output = pipeline.predict(str(page_file))
    count = 0
    output_image = None
    for res in output:
      count += 1
      res.print()
      output_image = output_image or save_output_image(res, page_output_dir, pid)
      res.save_to_json(save_path=page_output_dir)
      res.save_to_markdown(save_path=page_output_dir)
    manifest["pages"].append({
      "page_id": pid,
      "input": relative_path(page_file),
      "result_count": count,
      "output_image": output_image,
      "outputs": saved_result_files(page_output_dir)
    })

  manifest["finished_at"] = now_iso()
  manifest_path = output_root / "run-manifest.json"
  manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
  print(f"wrote {relative_path(manifest_path)}")


if __name__ == "__main__":
  main()
