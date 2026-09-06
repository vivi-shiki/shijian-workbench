import argparse
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[4]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--allow-pending", action="store_true")
    args = parser.parse_args()
    directory = ROOT / "data/projects" / args.project_id
    project = json.loads((directory / "project.json").read_text(encoding="utf-8"))
    sources = json.loads((directory / "source-images.json").read_text(encoding="utf-8"))
    expected_ids = [page["id"] for page in sources["pages"]]
    assert len(expected_ids) == len(set(expected_ids))
    assert [page["page_number"] for page in sources["pages"]] == list(range(1, len(expected_ids) + 1))
    report = {"project_id": project["id"], "pages": len(expected_ids), "volumes": sources["volumes"], "results": []}
    for metadata in project["results"]:
        result = json.loads((directory / "results" / f"{metadata['id']}.json").read_text(encoding="utf-8"))
        assert [page["id"] for page in result["pages"]] == expected_ids
        completed, count, chars, timings, blank_pages, edited_pages = 0, 0, 0, [], [], []
        for page, source in zip(result["pages"], sources["pages"]):
            assert (page["volume"], page["source_page"]) == (source["volume"], source["source_page"])
            if page["ocr_status"] == "pending":
                assert args.allow_pending, f"Pending {metadata['id']} {page['id']}"
                continue
            completed += 1
            with Image.open(ROOT / page["image_path"]) as image:
                assert list(image.size) == [page["width"], page["height"]]
                image.verify()
            raw_file = directory / "ocr" / metadata["id"] / page["id"] / f"{page['id']}_res.json"
            raw = json.loads(raw_file.read_text(encoding="utf-8"))["response"]
            assert raw["model"] == result["model"]
            assert raw["unwarping_enabled"] == result["unwarp"]
            assert raw["coordinate_space"] == "corrected_image"
            assert raw["corrected_size"] == [page["width"], page["height"]]
            if page.get("revision", 0) > 1:
                edited_pages.append(page["page_number"])
            else:
                assert [r["raw_text"] for r in page["regions"]] == [r["text"].strip() for r in raw["regions"] if r["text"].strip()]
            assert len({r["id"] for r in page["regions"]}) == len(page["regions"])
            for region in page["regions"]:
                x, y, width, height = region["bbox"]
                assert x >= 0 and y >= 0 and width > 0 and height > 0
                assert x + width <= page["width"] and y + height <= page["height"]
            count += len(page["regions"])
            chars += sum(len(r["raw_text"]) for r in page["regions"])
            timings.append(raw["elapsed_seconds"])
            if not page["regions"]:
                blank_pages.append(page["page_number"])
        report["results"].append({"id": metadata["id"], "model": result["model"], "completed_pages": completed,
            "regions": count, "characters": chars, "empty_result_pages": blank_pages, "saved_edit_pages": edited_pages,
            "inference_seconds": round(sum(timings), 3),
            "mean_inference_seconds": round(sum(timings) / len(timings), 3) if timings else None})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not args.allow_pending:
        (directory / "validation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
