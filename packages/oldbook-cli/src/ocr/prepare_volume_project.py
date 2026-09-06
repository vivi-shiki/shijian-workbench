from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools/pdf-render-deps"))


def main():
    parser = argparse.ArgumentParser(description="Render PDFs in supplied volume order, preserving source provenance.")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--pdf", action="append", required=True)
    parser.add_argument("--dpi", type=int, default=96)
    parser.add_argument("--renderer", choices=["mupdf", "poppler"], default="mupdf")
    args = parser.parse_args()
    project_dir = ROOT / "data/projects" / args.project_id
    pages_dir = project_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = project_dir / "source-images.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    volumes, pages = [], []
    for volume, name in enumerate(args.pdf, 1):
        source = Path(name).resolve()
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        count = len(PdfReader(source).pages)
        volumes.append({"volume": volume, "source_path": str(source), "sha256": digest, "pages": count,
                        "first_page": len(pages) + 1, "last_page": len(pages) + count})
        if old and old.get("volumes", [])[volume - 1] != volumes[-1]:
            raise RuntimeError("Source PDFs changed; use a new project id.")
        offset = len(pages)
        missing = [n for n in range(1, count + 1) if not (pages_dir / f"page-{offset + n:03d}.png").exists()]
        rendered_dir = project_dir / "rendered" / f"volume-{volume}"
        rendered_dir.mkdir(parents=True, exist_ok=True)
        document = None
        if args.renderer == "mupdf":
            import pymupdf
            document = pymupdf.open(source)
        if missing and args.renderer == "poppler":
            print(f"Rendering volume {volume}, pages {min(missing)}-{count}", flush=True)
            subprocess.run(["pdftoppm", "-png", "-r", str(args.dpi), "-f", str(min(missing)),
                            "-l", str(count), str(source), str(rendered_dir / "page")], check=True)
        rendered = {int(p.stem.split("-")[-1]): p for p in rendered_dir.glob("page-*.png")}
        for source_page in range(1, count + 1):
            number = len(pages) + 1
            pid = f"page-{number:03d}"
            dest = pages_dir / f"{pid}.png"
            if dest.exists():
                try:
                    with Image.open(dest) as image:
                        image.verify()
                except Exception:
                    dest.rename(dest.with_suffix(".incomplete"))
            if not dest.exists():
                if document is not None:
                    pixmap = document[source_page - 1].get_pixmap(matrix=pymupdf.Matrix(args.dpi / 72, args.dpi / 72))
                    pixmap.save(dest)
                else:
                    rendered[source_page].rename(dest)
            with Image.open(dest) as image:
                width, height = image.size
                image.verify()
            pages.append({"id": pid, "page_number": number, "volume": volume, "source_page": source_page,
                          "source_pdf": str(source), "image_path": dest.relative_to(ROOT).as_posix(),
                          "width": width, "height": height})
            print(f"rendered {pid}: volume={volume} page={source_page}/{count} size={width}x{height}", flush=True)
        if document is not None:
            document.close()
    manifest = {"dpi": args.dpi, "volumes": volumes, "pages": pages}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Ready: {len(pages)} pages", flush=True)


if __name__ == "__main__":
    main()
