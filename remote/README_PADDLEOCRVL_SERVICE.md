# PaddleOCR-VL Remote Service

This folder is a minimal native PaddleOCR-VL HTTP service compatible with the oldbook workbench client.

## Local reference environment

The current Windows machine runs:

```text
Python: 3.12.9
GPU: NVIDIA GeForce RTX 2060, 6144 MiB
NVIDIA driver: 560.94
CUDA reported by driver: 12.6
paddlepaddle-gpu: 3.2.1
paddleocr: 3.7.0
paddlex: 3.7.2
numpy: 2.3.5
opencv-contrib-python: 4.10.0.84
pillow: 12.1.0
```

The current project calls PaddleOCR-VL like this:

```python
from paddleocr import PaddleOCRVL

pipeline = PaddleOCRVL(
    pipeline_version="v1.6",
    device="gpu:0",
    use_doc_orientation_classify=True,
    use_doc_unwarping=True,
    use_layout_detection=True,
)

results = pipeline.predict("page-001.jpg")
```

## NVIDIA Windows setup

Run these commands on the remote machine:

```powershell
py -3.12 -m venv .venv_paddlevl
.\.venv_paddlevl\Scripts\python.exe -m pip install -U pip setuptools wheel
.\.venv_paddlevl\Scripts\python.exe -m pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
.\.venv_paddlevl\Scripts\python.exe -m pip install -U "paddleocr[doc-parser]>=3.6.0"
.\.venv_paddlevl\Scripts\python.exe -m pip install -r requirements-service.txt
```

Start the service:

```powershell
$env:PADDLEOCR_VL_DEVICE="gpu:0"
$env:PADDLEOCR_VL_PIPELINE_VERSION="v1.6"
.\.venv_paddlevl\Scripts\python.exe -m uvicorn paddlevl_service:app --host 0.0.0.0 --port 8000
```

Open:

```text
http://<remote-ip>:8000/docs
http://<remote-ip>:8000/health
```

## CPU fallback

If GPU install fails, use CPU mode:

```powershell
py -3.12 -m venv .venv_paddlevl
.\.venv_paddlevl\Scripts\python.exe -m pip install -U pip setuptools wheel
.\.venv_paddlevl\Scripts\python.exe -m pip install paddlepaddle==3.2.1
.\.venv_paddlevl\Scripts\python.exe -m pip install -U "paddleocr[doc-parser]>=3.6.0"
.\.venv_paddlevl\Scripts\python.exe -m pip install -r requirements-service.txt

$env:PADDLEOCR_VL_DEVICE="cpu"
.\.venv_paddlevl\Scripts\python.exe -m uvicorn paddlevl_service:app --host 0.0.0.0 --port 8000
```

## Workbench client commands

From the oldbook project on this machine:

```powershell
python scripts/run_remote_paddlevl.py --project-id yiyuji-photos --pages 1-6 --service-url http://<remote-ip>:8000 --output-name remote-paddlevl-vl --force
python scripts/build_project.py --project-id yiyuji-photos-remote-paddlevl-vl --pages-project-id yiyuji-photos --ocr-project-id yiyuji-photos --ocr-dir-name remote-paddlevl-vl --ocr-provider remotepaddlevl --title "疑雨集註 手机照片 远程PaddleOCR-VL" --source-path data/projects/yiyuji-photos/source-images.json --no-preserve-edits
python scripts/export_project.py --project-id yiyuji-photos-remote-paddlevl-vl --mode edited
```

PDF rendered pages:

```powershell
python scripts/run_remote_paddlevl.py --project-id yiyuji --pages 1-6 --service-url http://<remote-ip>:8000 --output-name remote-paddlevl-vl --no-unwarp --force
python scripts/build_project.py --project-id yiyuji-remote-paddlevl-vl --pages-project-id yiyuji --ocr-project-id yiyuji --ocr-dir-name remote-paddlevl-vl --ocr-provider remotepaddlevl --title "疑雨集註 PDF样本 远程PaddleOCR-VL" --source-path data/input/yiyuji-source.pdf --total-pages 110 --limit 6 --no-preserve-edits
python scripts/export_project.py --project-id yiyuji-remote-paddlevl-vl --mode edited
```

## API shape

`POST /ocr?unwarp=true` accepts multipart form field `file`.

The service returns:

```json
{
  "id": "uuid",
  "text": "...",
  "regions": [
    {
      "text": "...",
      "confidence": 0,
      "polygon": [[0, 0], [10, 0], [10, 10], [0, 10]],
      "box": [0, 0, 10, 10],
      "label": "vertical_text",
      "index": 0
    }
  ],
  "coordinate_space": "corrected_image",
  "original_size": [960, 1280],
  "corrected_size": [960, 1280],
  "document_orientation_degrees": 0,
  "unwarping_enabled": true,
  "corrected_image_url": "/images/<id>/corrected.jpg",
  "boxes_image_url": "/images/<id>/boxes.jpg",
  "elapsed_seconds": 1.23,
  "images_expire_at": 1780000000
}
```

The workbench overlays `regions[].box` on the downloaded `corrected.jpg`.
