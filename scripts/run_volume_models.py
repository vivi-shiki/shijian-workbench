from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from PIL import Image

from build_project import convert_regions_remote_paddlevl, now_iso
from run_remote_paddlevl import post_ocr, download_file

ROOT = Path(__file__).resolve().parents[1]
MODELS = {"paddleocr-vl": "PaddleOCR-VL v1.6", "pp-ocrv6": "PP-OCRv6 medium"}


def write_json(filename, value):
    temporary = filename.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Windows readers and antivirus scanners may briefly deny replacement.
    for attempt in range(10):
        try:
            temporary.replace(filename)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(min(1, 0.05 * 2 ** attempt))


def api(base, method, endpoint, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(base + endpoint, data=data,
        headers={"Content-Type": "application/json", "X-Oldbook-Actor": "ai:ocr",
                 "X-Oldbook-Source": "volume-ocr-batch"}, method=method)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def make_page(source):
    return {**source, "source_image_path": source["image_path"], "image_url": "/" + source["image_path"],
        "regions": [], "status": "needs_review", "ocr_status": "pending", "revision": 0}


def recognize(args, model, source):
    pid = source["id"]
    output = ROOT / "data/projects" / args.project_id / "ocr" / model / pid
    output.mkdir(parents=True, exist_ok=True)
    raw_path = output / f"{pid}_res.json"
    corrected = output / f"{pid}_corrected.jpg"
    start = time.monotonic()
    if raw_path.exists() and corrected.exists():
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        response = raw["response"]
    else:
        response = post_ocr(args.service_url, ROOT / source["image_path"], args.unwarp, args.timeout, model)
        download_file(args.service_url, response["corrected_image_url"], corrected, args.timeout)
        boxes = output / f"{pid}_boxes.jpg"
        download_file(args.service_url, response.get("boxes_image_url"), boxes, args.timeout)
        raw = {"provider": "remote-paddlevl", "model": response.get("model", model),
            "requested_model": model, "service_url": args.service_url, "input": source["image_path"],
            "corrected_image": corrected.relative_to(ROOT).as_posix(), "boxes_image": boxes.relative_to(ROOT).as_posix(),
            "response": response, "created_at": now_iso()}
        write_json(raw_path, raw)
        (output / f"{pid}.txt").write_text(response.get("text", ""), encoding="utf-8")
    with Image.open(corrected) as image:
        width, height = image.size
        image.verify()
    if list(response.get("corrected_size", [width, height])) != [width, height]:
        raise RuntimeError("Corrected image dimensions do not match coordinates")
    page = make_page(source)
    page.update({"image_path": corrected.relative_to(ROOT).as_posix(),
        "image_url": "/" + corrected.relative_to(ROOT).as_posix(), "width": width, "height": height,
        "coordinate_space": "corrected_image", "elapsed_seconds": response.get("elapsed_seconds"),
        "regions": convert_regions_remote_paddlevl(pid, width, height, output.parent, {})})
    for region in page["regions"]:
        region["source"].update({"provider": model, "model": response.get("model", model)})
    return page, time.monotonic() - start


def main():
    parser = argparse.ArgumentParser(description="Run models sequentially over ordered PDF volumes; resume safely.")
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--title", help="Project title; defaults to an existing project title or the project id.")
    parser.add_argument("--service-url", default="http://192.168.50.100:20000")
    parser.add_argument("--api-url", default="http://127.0.0.1:3100")
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--unwarp", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    directory = ROOT / "data/projects" / args.project_id
    source = json.loads((directory / "source-images.json").read_text(encoding="utf-8"))
    project_path = directory / "project.json"
    existing_project = json.loads(project_path.read_text(encoding="utf-8")) if project_path.exists() else {}
    title = args.title or existing_project.get("title") or args.project_id
    pages = source["pages"][:args.limit] if args.limit else source["pages"]
    health = json.load(urllib.request.urlopen(args.service_url + "/health", timeout=15))
    write_json(directory / "remote-health.json", health)
    for model, label in MODELS.items():
        result = {"id": model, "label": label, "model": health["models"][model]["model"],
            "provider": model, "archived": False, "status": "pending", "completed_pages": 0,
            "page_count": len(pages), "created_at": now_iso(), "unwarp": args.unwarp,
            "service_url": args.service_url, "workflow": {"ocr_provider": model, "reading_order": "model"},
            "pages": [make_page(page) for page in pages]}
        api(args.api_url, "POST", f"/api/projects/{args.project_id}/results",
            {"title": title, "source": source, "result": result})
    progress = {"started_at": now_iso(), "total": len(pages) * len(MODELS), "completed": 0, "errors": [], "models": {}}
    for model in MODELS:
        timings = []
        for number, page_source in enumerate(pages, 1):
            print(f"{model} {number}/{len(pages)} {page_source['id']} volume={page_source['volume']}", flush=True)
            progress.update({"current_model": model, "current_page": page_source["id"]})
            write_json(directory / "batch-progress.json", progress)
            try:
                page, elapsed = recognize(args, model, page_source)
                api(args.api_url, "PUT", f"/api/projects/{args.project_id}/results/{model}/pages/{page['id']}", page)
                timings.append(page["elapsed_seconds"] or elapsed)
                progress["completed"] += 1
                print(f"done {model} {page['id']} regions={len(page['regions'])} inference={page['elapsed_seconds']}s", flush=True)
            except Exception as error:
                progress["errors"].append({"model": model, "page": page_source["id"], "error": str(error)})
                print(f"ERROR {model} {page_source['id']}: {error}", flush=True)
            progress["models"][model] = {"completed": len(timings), "inference_seconds": round(sum(timings), 3)}
            write_json(directory / "batch-progress.json", progress)
        print(f"finished {model}: {len(timings)}/{len(pages)}", flush=True)
    progress["finished_at"] = now_iso()
    write_json(directory / "batch-progress.json", progress)
    if progress["errors"]:
        raise SystemExit(f"{len(progress['errors'])} failed pages; rerun to resume")


if __name__ == "__main__":
    main()
