import json
from pathlib import Path


def load_project(path: Path, result_id: str | None = None) -> dict:
    project = json.loads(path.read_text(encoding="utf-8"))
    if project.get("schema_version") == 2:
        selected = result_id or project["active_result_id"]
        if not any(result["id"] == selected for result in project["results"]):
            raise ValueError(f"Unknown model result: {selected}")
        result = json.loads((path.parent / "results" / f"{selected}.json").read_text(encoding="utf-8"))
        project.update(pages=result["pages"], active_result_id=selected, workflow=result.get("workflow", {}))
    return project
