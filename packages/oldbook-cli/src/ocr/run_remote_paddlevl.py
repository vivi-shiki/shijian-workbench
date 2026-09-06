from __future__ import annotations

import argparse
import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]


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


def normalize_service_url(value: str) -> str:
  return value.rstrip("/")


def find_project_pages(project_id: str, pages_arg: str | None, limit: int | None) -> list[Path]:
  pages_dir = ROOT / "data" / "projects" / project_id / "pages"
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
  for suffix in ("*.json", "*.txt", "*.jpg", "*.png"):
    groups[suffix[2:]] = [relative_path(path) for path in sorted(output_dir.glob(suffix))]
  return groups


def multipart_file_body(field_name: str, file_path: Path) -> tuple[bytes, str]:
  boundary = f"----oldbook-{uuid.uuid4().hex}"
  mime_type, _ = mimetypes.guess_type(file_path.name)
  if not mime_type:
    mime_type = "application/octet-stream"
  header = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="{field_name}"; filename="{file_path.name}"\r\n'
    f"Content-Type: {mime_type}\r\n"
    "\r\n"
  ).encode("utf-8")
  footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
  return header + file_path.read_bytes() + footer, boundary


def post_ocr(service_url: str, image_path: Path, unwarp: bool, timeout: int, model: str | None = None) -> dict[str, Any]:
  body, boundary = multipart_file_body("file", image_path)
  params = {"unwarp": str(unwarp).lower()}
  if model:
    params["model"] = model
  endpoint = f"{service_url}/ocr?{urllib.parse.urlencode(params)}"
  request = urllib.request.Request(
    endpoint,
    data=body,
    headers={
      "Content-Type": f"multipart/form-data; boundary={boundary}",
      "Content-Length": str(len(body))
    },
    method="POST"
  )
  network_failures = 0
  for attempt in range(61):
    try:
      with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
      body_text = exc.read().decode("utf-8", errors="replace")
      if exc.code == 503 and attempt < 60:
        delay = min(30, 2 + attempt * 2)
        print(f"busy: retry in {delay}s", flush=True)
        time.sleep(delay)
        continue
      raise RuntimeError(f"Remote OCR failed: HTTP {exc.code}\n{body_text}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
      network_failures += 1
      if network_failures > 3:
        raise
      delay = 2 ** network_failures
      print(f"network retry in {delay}s: {exc}", flush=True)
      time.sleep(delay)


def download_file(service_url: str, value: str | None, output_path: Path, timeout: int) -> str | None:
  if not value:
    return None
  url = urllib.parse.urljoin(f"{service_url}/", value)
  request = urllib.request.Request(url, method="GET")
  for attempt in range(4):
    try:
      with urllib.request.urlopen(request, timeout=timeout) as response:
        output_path.write_bytes(response.read())
      break
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
      if attempt == 3 or isinstance(exc, urllib.error.HTTPError) and exc.code < 500:
        raise RuntimeError(f"Remote image download failed: {url}: {exc}") from exc
      time.sleep(2 ** (attempt + 1))
  return relative_path(output_path)


def main() -> None:
  parser = argparse.ArgumentParser(description="Run a native remote PaddleOCR service on project page images.")
  parser.add_argument("--project-id", required=True, help="Project whose pages/ directory will be used.")
  parser.add_argument("--pages", default=None, help="Page numbers, e.g. 1,3,6 or 1-6.")
  parser.add_argument("--limit", type=int, default=None)
  parser.add_argument("--service-url", default="http://192.168.50.100:20000")
  parser.add_argument("--model", choices=["paddleocr-vl", "pp-ocrv6"], default=None)
  parser.add_argument("--output-name", default="remote-paddlevl")
  parser.add_argument("--timeout", type=int, default=300)
  parser.add_argument("--force", action="store_true")
  parser.add_argument("--no-unwarp", dest="unwarp", action="store_false")
  parser.set_defaults(unwarp=True)
  args = parser.parse_args()

  service_url = normalize_service_url(args.service_url)
  pages = find_project_pages(args.project_id, args.pages, args.limit)
  output_root = ROOT / "data" / "projects" / args.project_id / "ocr" / args.output_name
  output_root.mkdir(parents=True, exist_ok=True)

  manifest = {
    "provider": "remote-paddlevl",
    "model": args.model,
    "service_url": service_url,
    "output_name": args.output_name,
    "unwarp": args.unwarp,
    "started_at": now_iso(),
    "pages": []
  }

  for page_file in pages:
    pid = page_id(page_file)
    page_output_dir = output_root / pid
    page_output_dir.mkdir(parents=True, exist_ok=True)

    result_path = page_output_dir / f"{pid}_res.json"
    corrected_path = page_output_dir / f"{pid}_corrected.jpg"
    text_path = page_output_dir / f"{pid}.txt"
    if not args.force and result_path.exists() and corrected_path.exists():
      print(f"skip {pid}: existing remote PaddleOCR result")
      manifest["pages"].append({
        "page_id": pid,
        "input": relative_path(page_file),
        "skipped": True,
        "outputs": saved_result_files(page_output_dir)
      })
      continue

    print(f"run {pid}: {relative_path(page_file)}")
    response = post_ocr(service_url, page_file, args.unwarp, args.timeout, args.model)
    corrected_image = download_file(
      service_url,
      response.get("corrected_image_url"),
      corrected_path,
      args.timeout
    )
    boxes_image = download_file(
      service_url,
      response.get("boxes_image_url"),
      page_output_dir / f"{pid}_boxes.jpg",
      args.timeout
    )
    result = {
      "provider": "remote-paddlevl",
      "model": response.get("model") or args.model,
      "service_url": service_url,
      "input": relative_path(page_file),
      "corrected_image": corrected_image,
      "boxes_image": boxes_image,
      "response": response,
      "created_at": now_iso()
    }
    result_path.write_text(f"{json.dumps(result, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    text_path.write_text(f"{str(response.get('text') or '').strip()}\n", encoding="utf-8")
    manifest["pages"].append({
      "page_id": pid,
      "input": relative_path(page_file),
      "remote_id": response.get("id"),
      "regions": len(response.get("regions") or []),
      "corrected_image": corrected_image,
      "boxes_image": boxes_image,
      "elapsed_seconds": response.get("elapsed_seconds"),
      "outputs": saved_result_files(page_output_dir)
    })
    print(
      f"wrote {relative_path(result_path)} "
      f"regions={len(response.get('regions') or [])} elapsed={response.get('elapsed_seconds')}"
    )

  manifest["finished_at"] = now_iso()
  manifest_path = output_root / "run-manifest.json"
  manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
  print(f"wrote {relative_path(manifest_path)}")


if __name__ == "__main__":
  main()
