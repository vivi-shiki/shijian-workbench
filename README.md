# 古籍 OCR 校对工作台 MVP

这个仓库把《疑雨集註》PDF 样本和手机照片样本跑成一个最小闭环：

1. PDF 前 20 页渲染为 PNG，或把手机照片旋正为页面图。
2. 使用 `ndlkotenocr-lite` 生成行级 OCR JSON/TXT/XML。
3. 可选使用 PaddleOCR-VL 1.6 生成版面解析 JSON/Markdown。
4. 可选调用 OpenAI-compatible 远程视觉 OCR 服务生成页级转录文本。
5. 转换为项目自己的 `Document/Page/Region` 中间格式。
6. 在浏览器工作台里看图、选框、改字、调顺序、标记校对。
7. 导出 TXT、Markdown、HTML 和完整 JSON。

## 本地运行

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/?project=yiyuji-four-volumes`。如果端口不同，以 `npm run dev` 输出为准。

## 诗词结构化（第二步）

首页顶部的工作流 Tab 分为“1 双 OCR 与校对”和“2 诗词结构化”。第二步读取第一步已经修改并保存的
`edited_text`，默认以 PaddleOCR-VL 和 PP-OCRv6 两套结果互校。任务每 5 页调用一次模型，完成一组就写入
`data/projects/<project-id>/ebook/structured.json`；中途失败后再次运行会从已完成页继续。

复制 `.env.example` 为 `.env.local`，只需填写硅基流动 API Key：

```dotenv
SILICONFLOW_API_KEY=sk-your-key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V3.2
SILICONFLOW_MAX_TOKENS=8192
```

重启 `npm run dev` 后进入“诗词结构化”，默认运行 1–30 页。右侧 JSON 编辑器仅在结构合法时更新中间的
电子排版预览，并在 800ms 后自动保存；`Ctrl+S` 可立即保存。JSON 的核心条目类型包括 `heading`、
`poem`、`preface`、`note`、`colophon` 和 `other`，疑难字统一进入顶层 `issues`，不让模型静默猜字。

相关 API：

```text
GET  /api/projects/:projectId/ebook
PUT  /api/projects/:projectId/ebook
POST /api/projects/:projectId/ebook/run
```

## 项目归档与多模型结果

项目选择器支持“当前 / Archive / 全部”，在“全部”中可用“分类”开关控制分组。
旁边的归档图标可加入或移出 Archive。归档只改变分类，不移动原图路径。
编辑器左上角选择模型结果，切换模型或项目前自动保存修改。保存失败时不切换。
每套结果拥有独立的图像、框坐标、顺序、原文、校正文和校对状态；校正图必须与模型坐标配对。

V2 数据结构：

```text
data/projects/<project-id>/
  project.json                 # 项目元数据、archived、active_result_id、results 索引
  results/<result-id>.json      # 此次识别的完整 pages / regions / workflow
  pages/page-001.png            # 输入页面，共享原图
  ocr/<result-id>/page-001/      # 原始接口响应、校正图、框图
  backups/project-v1.json       # 迁移前备份（旧项目）
  source-images.json           # 卷号、卷内页码、全局页码、源 PDF SHA-256
```

旧格式由 API 自动迁移。显式模型名称会保留，只有接口/provider 名称而无法确认模型的历史结果标为 Archive（模型未知）。
本次已把原有 13 个项目归档。迁移不重做 OCR，也不改动原有 pages 内的任何字段。
`node scripts/migrate_projects.mjs --archive-existing` 会归档运行时的全部项目，不要在日常启动中重复执行。

四卷导入（按卷一、二、三、四传参）：

```powershell
python -m pip install --target tools/pdf-render-deps pymupdf
python scripts/prepare_volume_project.py --project-id yiyuji-four-volumes --pdf "C:/Users/about/Downloads/疑雨集注卷一.pdf" --pdf "C:/Users/about/Downloads/疑雨集注卷二.pdf" --pdf "C:/Users/about/Downloads/疑雨季注卷三.pdf" --pdf "C:/Users/about/Downloads/疑雨集注卷四.pdf"
python -u scripts/run_volume_models.py --project-id yiyuji-four-volumes
```

扫描 PDF 默认关闭 unwarp，两模型使用相同输入；照片可加 `--unwarp`。默认先跑完 PaddleOCR-VL，再跑 PP-OCRv6。
端口为 `192.168.50.100:20000`，识别串行执行，503 有限退避重试。原始结果逐页缓存，重复执行可续跑；已可编辑的页面不会被导入覆盖。
进度写入 `batch-progress.json`，失败页明确记录，重跑会复用已完成结果。界面点“重新载入”可看到新完成页。
四卷共 422 页，全部按原 PDF 保留（包括封面、空白页）；页码范围为 1-110、111-200、201-316、317-422。

导出只针对当前选择的模型，文件名包含结果 ID，不会覆盖另一模型的导出。
JSON 导出是当前结果的页面快照；完整备份应保留整个项目目录及被引用的源图目录。
命令行可指定 `--result-id paddleocr-vl` 或 `--result-id pp-ocrv6`。
重建已迁移项目时，`build_project.py` 必须用新的 `--result-id`，通过已运行的本地 API 追加结果，保护已校对内容。

```powershell
node --test server/project-store.test.mjs
npm run build
python scripts/export_project.py --project-id yiyuji-four-volumes --result-id pp-ocrv6 --mode edited
```

## 常用命令

重新渲染 PDF 页面：

```powershell
.\scripts\render_pdf_pages.ps1 -FirstPage 1 -LastPage 20 -Dpi 144
```

重建中间 JSON：

```powershell
npm run project:build
```

命令行导出：

```powershell
npm run project:export -- --project-id yiyuji-photos --mode edited
```

## 手机照片测试项目

照片项目位于 `data/projects/yiyuji-photos/`：

- `originals/`: 原始 6 张 Telegram 照片。
- `pages/`: 旋正后的测试页面，`page-001.jpg` 到 `page-006.jpg`。
- `orientation-preview.jpg`: 旋正预览图。
- `ocr/ndlkoten/`: NDL OCR 原始输出。
- `project.json`: 工作台读取和保存的中间格式。
- `exports/`: TXT、Markdown、HTML、JSON 导出。

重新生成旋正图片：

```powershell
npm run photos:prepare
```

重新生成照片项目中间 JSON：

```powershell
npm run photos:build
```

导出照片项目：

```powershell
npm run photos:export
```

## PaddleOCR-VL 1.6

PaddleOCR-VL 使用独立环境，避免和 NDL OCR 的依赖互相影响：

```powershell
py -3.12 -m venv .venv_paddlevl
.\.venv_paddlevl\Scripts\python.exe -m pip install -U pip setuptools wheel
.\.venv_paddlevl\Scripts\python.exe -m pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
.\.venv_paddlevl\Scripts\python.exe -m pip install -U "paddleocr[doc-parser]>=3.6.0"
```

跑手机照片 1-6 页：

```powershell
npm run paddlevl:run:photos
npm run paddlevl:build:photos
npm run paddlevl:export:photos
```

跑 PDF 渲染图 1-6 页：

```powershell
npm run paddlevl:run:yiyuji
npm run paddlevl:build:yiyuji
npm run paddlevl:export:yiyuji
```

PaddleOCR-VL 项目不会覆盖 NDL 项目，而是生成新的对照项目：

- `yiyuji-photos-paddlevl`
- `yiyuji-paddlevl`

## 远程 OpenAI-compatible PaddleOCR-VL

如果另一台机器已经把 PaddleOCR-VL 暴露成 OpenAI-compatible API，可以直接调用远程服务：

```powershell
npm run openaivl:run:photos
npm run openaivl:build:photos
npm run openaivl:export:photos
```

PDF 渲染图 1-6 页：

```powershell
npm run openaivl:run:yiyuji
npm run openaivl:build:yiyuji
npm run openaivl:export:yiyuji
```

默认地址和模型来自 `package.json`：

```text
http://192.168.50.100:1234/v1
paddleocr-vl-1.6
```

也可以直接运行脚本并覆盖参数：

```powershell
python scripts/run_openai_vl.py --project-id yiyuji-photos --pages 1-6 --base-url http://192.168.50.100:1234/v1 --model paddleocr-vl-1.6 --force
```

当前远程接口返回的是页级文本，不返回稳定 bbox。因此构建出的远程项目默认是一页一个可编辑文本块；如果服务端以后返回 `regions` 和 `bbox`，构建脚本会自动转换为分块区域。

生成的对照项目：

- `yiyuji-photos-openaivl`
- `yiyuji-openaivl`

## 远程 PaddleOCR-VL 原生服务

如果强机器提供 FastAPI 形式的 PaddleOCR 原生服务，例如：

```text
http://192.168.50.100:8000/docs
```

服务端 `POST /ocr` 返回 `regions[].box`、`regions[].polygon`、`corrected_image_url` 和 `boxes_image_url`，可以直接生成带框工作台项目：

```powershell
npm run remote-paddlevl:run:photos
npm run remote-paddlevl:build:photos
npm run remote-paddlevl:export:photos
```

PDF 渲染图 1-6 页默认关闭展平：

```powershell
npm run remote-paddlevl:run:yiyuji
npm run remote-paddlevl:build:yiyuji
npm run remote-paddlevl:export:yiyuji
```

生成的对照项目：

- `yiyuji-photos-remote-paddlevl`
- `yiyuji-remote-paddlevl`

## 中间数据

主文件是各项目目录里的 `project.json`。核心对象是 `Region`：

```json
{
  "id": "page-010-r001",
  "order": 1,
  "kind": "main",
  "direction": "vertical",
  "bbox": [1808, 382, 133, 2574],
  "raw_text": "OCR原文",
  "edited_text": "人工校正文本",
  "reading_text": "",
  "confidence": 0.839,
  "status": "needs_review"
}
```

`raw_text` 保留模型输出，`edited_text` 是人工忠实校对层，`reading_text` 可用于后续加标点、断句或现代电子阅读整理。
