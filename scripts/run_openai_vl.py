from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import shutil
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PROMPT = """你是古籍OCR转录器。请识别图片中的繁体中文、异体字、古籍小注和页眉页脚。

要求：
1. 按竖排古籍阅读顺序输出：从右到左，每列自上而下。
2. 保留原字形，不要简化，不要翻译，不要改写成白话。
3. 正文、小注、标题、页码、书名栏都转录；明显不同版面块之间用换行分隔。
4. 难辨认的字用□表示。
5. 只输出转录文本，不要解释过程，不要输出Markdown表格。
"""

PAGE_JSON_PROMPT = """你是古籍OCR转录器。请识别图片中的繁体中文、异体字、古籍小注和页眉页脚。

按竖排古籍阅读顺序输出：从右到左，每列自上而下。保留原字形，不要简化，不要翻译，不要改写成白话。难辨认的字用□表示。

返回 JSON 对象，字段为 text。
"""

REGION_JSON_PROMPT = """你是古籍版面 OCR 转录器。请把图片分成可编辑文字区域，并识别每个区域文字。

要求：
1. 坐标必须基于输入原图像素。
2. bbox 格式必须是 [x1, y1, x2, y2]。
3. label 使用 main、note、title、page_mark 或 other。
4. 按竖排古籍阅读顺序排列 regions：从右到左，每列自上而下。
5. 保留繁体、异体字和小注原文，不要简化，不要翻译，不要改写成白话。
6. 难辨认的字用□表示。

返回 JSON 对象，字段为 regions。
"""


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


def normalize_base_url(value: str) -> str:
  value = value.rstrip("/")
  if not value.endswith("/v1"):
    value = f"{value}/v1"
  return value


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
  for suffix in ("*.json", "*.txt", "*.md"):
    groups[suffix[2:]] = [relative_path(path) for path in sorted(output_dir.glob(suffix))]
  return groups


def image_payload(path: Path) -> dict[str, Any]:
  mime_type, _ = mimetypes.guess_type(path.name)
  if not mime_type:
    mime_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
  encoded = base64.b64encode(path.read_bytes()).decode("ascii")
  return {
    "type": "image_url",
    "image_url": {
      "url": f"data:{mime_type};base64,{encoded}"
    }
  }


def extract_content(response: dict[str, Any]) -> str:
  choices = response.get("choices")
  if not isinstance(choices, list) or not choices:
    return ""
  message = choices[0].get("message") if isinstance(choices[0], dict) else {}
  content = message.get("content") if isinstance(message, dict) else ""
  if isinstance(content, str):
    return content.strip()
  if isinstance(content, list):
    parts: list[str] = []
    for item in content:
      if isinstance(item, dict) and isinstance(item.get("text"), str):
        parts.append(item["text"])
    return "\n".join(part.strip() for part in parts if part.strip())
  return ""


def response_format_payload(mode: str) -> dict[str, Any] | None:
  if mode == "none":
    return None
  if mode == "json_object":
    return {"type": "json_object"}
  if mode == "ocr_page_json":
    return {
      "type": "json_schema",
      "json_schema": {
        "name": "ocr_page",
        "strict": True,
        "schema": {
          "type": "object",
          "properties": {
            "text": {"type": "string"}
          },
          "required": ["text"],
          "additionalProperties": False
        }
      }
    }
  if mode == "ocr_regions_json":
    return {
      "type": "json_schema",
      "json_schema": {
        "name": "ocr_regions",
        "strict": True,
        "schema": {
          "type": "object",
          "properties": {
            "regions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": {"type": "string"},
                  "bbox": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "minItems": 4,
                    "maxItems": 4
                  },
                  "text": {"type": "string"}
                },
                "required": ["label", "bbox", "text"],
                "additionalProperties": False
              }
            }
          },
          "required": ["regions"],
          "additionalProperties": False
        }
      }
    }
  raise ValueError(f"Unknown response format mode: {mode}")


def default_prompt_for_response_format(mode: str) -> str:
  if mode == "ocr_page_json":
    return PAGE_JSON_PROMPT
  if mode == "ocr_regions_json":
    return REGION_JSON_PROMPT
  return DEFAULT_PROMPT


def call_chat_completions(
  base_url: str,
  model: str,
  prompt: str,
  image_path: Path,
  max_tokens: int,
  temperature: float,
  top_p: float | None,
  response_format: dict[str, Any] | None,
  timeout: int,
  api_key: str | None
) -> dict[str, Any]:
  payload = {
    "model": model,
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": prompt},
          image_payload(image_path)
        ]
      }
    ],
    "max_tokens": max_tokens,
    "temperature": temperature
  }
  if top_p is not None:
    payload["top_p"] = top_p
  if response_format is not None:
    payload["response_format"] = response_format
  headers = {"Content-Type": "application/json"}
  if api_key:
    headers["Authorization"] = f"Bearer {api_key}"
  request = urllib.request.Request(
    f"{base_url}/chat/completions",
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    headers=headers,
    method="POST"
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      return json.loads(response.read().decode("utf-8"))
  except urllib.error.HTTPError as exc:
    body = exc.read().decode("utf-8", errors="replace")
    raise SystemExit(f"OpenAI-compatible request failed: HTTP {exc.code}\n{body}") from exc


def main() -> None:
  parser = argparse.ArgumentParser(description="Run an OpenAI-compatible vision OCR model on project page images.")
  parser.add_argument("--project-id", required=True, help="Project whose pages/ directory will be used.")
  parser.add_argument("--pages", default=None, help="Page numbers, e.g. 1,3,6 or 1-6.")
  parser.add_argument("--limit", type=int, default=None)
  parser.add_argument("--base-url", default=os.environ.get("OPENAI_VL_BASE_URL", "http://192.168.50.100:1234/v1"))
  parser.add_argument("--model", default=os.environ.get("OPENAI_VL_MODEL", "paddleocr-vl-1.6"))
  parser.add_argument("--api-key", default=os.environ.get("OPENAI_VL_API_KEY"))
  parser.add_argument("--max-tokens", type=int, default=4096)
  parser.add_argument("--temperature", type=float, default=0.0)
  parser.add_argument("--top-p", type=float, default=None)
  parser.add_argument(
    "--response-format",
    choices=["none", "json_object", "ocr_page_json", "ocr_regions_json"],
    default="none"
  )
  parser.add_argument("--timeout", type=int, default=180)
  parser.add_argument("--prompt", default=None)
  parser.add_argument("--prompt-file", default=None)
  parser.add_argument("--output-name", default="openaivl", help="OCR output folder name under data/projects/<project>/ocr/.")
  parser.add_argument("--force", action="store_true")
  args = parser.parse_args()

  prompt = args.prompt or default_prompt_for_response_format(args.response_format)
  if args.prompt_file:
    prompt = Path(args.prompt_file).read_text(encoding="utf-8")

  base_url = normalize_base_url(args.base_url)
  pages = find_project_pages(args.project_id, args.pages, args.limit)
  output_root = ROOT / "data" / "projects" / args.project_id / "ocr" / args.output_name
  output_root.mkdir(parents=True, exist_ok=True)

  manifest = {
    "provider": "openai-compatible-vl",
    "base_url": base_url,
    "model": args.model,
    "output_name": args.output_name,
    "response_format": args.response_format,
    "max_tokens": args.max_tokens,
    "temperature": args.temperature,
    "top_p": args.top_p,
    "started_at": now_iso(),
    "pages": []
  }

  for page_file in pages:
    pid = page_id(page_file)
    page_output_dir = output_root / pid
    if args.force and page_output_dir.exists():
      shutil.rmtree(page_output_dir)
    page_output_dir.mkdir(parents=True, exist_ok=True)

    result_path = page_output_dir / f"{pid}_res.json"
    text_path = page_output_dir / f"{pid}.txt"
    if not args.force and result_path.exists() and text_path.exists():
      print(f"skip {pid}: existing OpenAI-compatible VL result")
      manifest["pages"].append({
        "page_id": pid,
        "input": relative_path(page_file),
        "skipped": True,
        "outputs": saved_result_files(page_output_dir)
      })
      continue

    print(f"run {pid}: {relative_path(page_file)}")
    response = call_chat_completions(
      base_url=base_url,
      model=args.model,
      prompt=prompt,
      image_path=page_file,
      max_tokens=args.max_tokens,
      temperature=args.temperature,
      top_p=args.top_p,
      response_format=response_format_payload(args.response_format),
      timeout=args.timeout,
      api_key=args.api_key
    )
    content = extract_content(response)
    result = {
      "provider": "openai-compatible-vl",
      "base_url": base_url,
      "model": args.model,
      "input": relative_path(page_file),
      "prompt": prompt,
      "content": content,
      "response": response,
      "created_at": now_iso()
    }
    result_path.write_text(f"{json.dumps(result, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    text_path.write_text(f"{content.strip()}\n", encoding="utf-8")
    (page_output_dir / f"{pid}.md").write_text(f"{content.strip()}\n", encoding="utf-8")
    print(f"wrote {relative_path(result_path)} chars={len(content)}")
    manifest["pages"].append({
      "page_id": pid,
      "input": relative_path(page_file),
      "chars": len(content),
      "usage": response.get("usage"),
      "outputs": saved_result_files(page_output_dir)
    })

  manifest["finished_at"] = now_iso()
  manifest_path = output_root / "run-manifest.json"
  manifest_path.write_text(f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
  print(f"wrote {relative_path(manifest_path)}")


if __name__ == "__main__":
  main()
