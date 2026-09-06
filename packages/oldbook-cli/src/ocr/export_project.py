from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any
from project_data import load_project


ROOT = Path(__file__).resolve().parents[4]


def ordered_pages(project: dict[str, Any]) -> list[dict[str, Any]]:
  return sorted(project["pages"], key=lambda page: page["page_number"])


def ordered_regions(page: dict[str, Any]) -> list[dict[str, Any]]:
  return sorted(page["regions"], key=lambda region: region["order"])


def region_text(region: dict[str, Any], mode: str) -> str:
  if mode == "raw":
    return region.get("raw_text", "")
  if mode == "reading":
    return region.get("reading_text") or region.get("edited_text") or region.get("raw_text", "")
  return region.get("edited_text", region.get("raw_text", ""))


def page_text(page: dict[str, Any], mode: str) -> str:
  lines = [region_text(region, mode).strip() for region in ordered_regions(page)]
  return "\n".join(line for line in lines if line)


def export_text(project: dict[str, Any], mode: str) -> str:
  pages = [page_text(page, mode) for page in ordered_pages(project)]
  return "\n\n".join(page for page in pages if page)


def export_markdown(project: dict[str, Any], mode: str) -> str:
  parts = [f"# {project['title']}", ""]
  for page in ordered_pages(project):
    text = page_text(page, mode)
    if text:
      parts.extend([f"## Page {page['page_number']:03d}", "", text, ""])
  return "\n".join(parts)


def export_html(project: dict[str, Any], mode: str) -> str:
  pages = []
  for page in ordered_pages(project):
    text = page_text(page, mode)
    if not text:
      continue
    pages.append(
      f'<section class="page"><h2>Page {page["page_number"]:03d}</h2>'
      f"<p>{html.escape(text).replace(chr(10), '<br />')}</p></section>"
    )
  return f"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{html.escape(project["title"])}</title>
  <style>
    body {{ margin: 0; font-family: "Noto Serif CJK TC", "Source Han Serif TC", serif; color: #191714; background: #f6f0e6; }}
    main {{ max-width: 860px; margin: 0 auto; padding: 48px 22px 72px; }}
    h1 {{ font-size: 30px; line-height: 1.25; margin: 0 0 32px; }}
    h2 {{ font-size: 16px; margin: 36px 0 12px; color: #6b6255; font-family: system-ui, sans-serif; }}
    p {{ font-size: 22px; line-height: 2; margin: 0; }}
    .page {{ padding-block: 10px 28px; border-top: 1px solid #d8ccb8; }}
  </style>
</head>
<body><main><h1>{html.escape(project["title"])}</h1>{''.join(pages)}</main></body>
</html>
"""


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--project-id", required=True)
  parser.add_argument("--mode", choices=["raw", "edited", "reading"], default="edited")
  parser.add_argument("--result-id", default=None)
  args = parser.parse_args()

  project_dir = ROOT / "data" / "projects" / args.project_id
  project_path = project_dir / "project.json"
  export_dir = project_dir / "exports"
  project = load_project(project_path, args.result_id)
  export_dir.mkdir(parents=True, exist_ok=True)
  result_suffix = f"-{project['active_result_id']}" if project.get("active_result_id") else ""
  base = export_dir / f"{project['id']}{result_suffix}-{args.mode}"
  outputs = {
    "txt": base.with_suffix(".txt"),
    "md": base.with_suffix(".md"),
    "html": base.with_suffix(".html"),
    "json": base.with_suffix(".json")
  }

  outputs["txt"].write_text(export_text(project, args.mode), encoding="utf-8")
  outputs["md"].write_text(export_markdown(project, args.mode), encoding="utf-8")
  outputs["html"].write_text(export_html(project, args.mode), encoding="utf-8")
  outputs["json"].write_text(f"{json.dumps(project, ensure_ascii=False, indent=2)}\n", encoding="utf-8")

  for kind, output in outputs.items():
    print(f"{kind}: {output.relative_to(ROOT)}")


if __name__ == "__main__":
  main()
