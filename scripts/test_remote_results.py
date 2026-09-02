import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.error import URLError
from io import BytesIO

from build_project import convert_regions_remote_paddlevl
from run_remote_paddlevl import post_ocr
from run_volume_models import write_json


class RemoteResultTests(unittest.TestCase):
    def test_connection_failure_retries_before_failing_page(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "page.png"
            image.write_bytes(b"fixture")
            with patch("run_remote_paddlevl.urllib.request.urlopen", side_effect=[URLError("connection timeout"), BytesIO(b'{"regions":[]}')]) as request, \
                 patch("run_remote_paddlevl.time.sleep"):
                self.assertEqual(post_ocr("http://host", image, False, 20, "pp-ocrv6"), {"regions": []})
            self.assertEqual(request.call_count, 2)

    def test_progress_write_retries_temporary_windows_file_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "progress.json"
            original = Path.replace
            attempts = []

            def replace(source, destination):
                attempts.append(destination)
                if len(attempts) == 1:
                    raise PermissionError("temporary sharing violation")
                return original(source, destination)

            with patch.object(Path, "replace", replace), patch("run_volume_models.time.sleep") as sleep:
                write_json(target, {"completed": 364})
            self.assertEqual(json.loads(target.read_text()), {"completed": 364})
            self.assertEqual(len(attempts), 2)
            sleep.assert_called_once()

    def test_small_annotation_polygon_is_not_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "page-001"
            output.mkdir()
            raw = {"response": {"regions": [{"text": "注", "label": "footnote", "confidence": .9,
                "polygon": [[80, 30], [91, 30], [91, 49], [80, 49]], "box": [80, 30, 91, 49]}]}}
            (output / "page-001_res.json").write_text(json.dumps(raw), encoding="utf-8")
            regions = convert_regions_remote_paddlevl("page-001", 100, 200, root, {})
            self.assertEqual(len(regions), 1)
            self.assertEqual(regions[0]["bbox"], [80, 30, 11, 19])
            self.assertEqual(regions[0]["kind"], "note")

    def test_busy_retries_and_preserves_model_and_unwarp_query(self):
        busy = HTTPError("http://host/ocr", 503, "busy", {}, BytesIO(b"busy"))
        response = BytesIO(b'{"model":"PP-OCRv6_medium","regions":[]}')
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "page.png"
            image.write_bytes(b"fixture")
            with patch("run_remote_paddlevl.urllib.request.urlopen", side_effect=[busy, response]) as request, \
                 patch("run_remote_paddlevl.time.sleep") as sleep:
                result = post_ocr("http://host", image, False, 20, "pp-ocrv6")
            self.assertEqual(result["model"], "PP-OCRv6_medium")
            self.assertEqual(request.call_count, 2)
            self.assertIn("model=pp-ocrv6", request.call_args.args[0].full_url)
            self.assertIn("unwarp=false", request.call_args.args[0].full_url)
            sleep.assert_called_once_with(2)


if __name__ == "__main__":
    unittest.main()
