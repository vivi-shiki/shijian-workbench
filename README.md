# 诗歌类古籍 OCR 与结构化工作台

这个项目面向以诗歌为主要内容的中国古籍，包括诗集、词集、曲集、诗文合集，以及带笺注、评点的选本。《疑雨集注》仅是当前验证样本，不是产品内置书目或固定模板。

工作台提供一个可替换模型、可校订中间结果的最小闭环：

1. PDF 前 20 页渲染为 PNG，或把手机照片旋正为页面图。
2. 使用 `ndlkotenocr-lite` 生成行级 OCR JSON/TXT/XML。
3. 可选使用 PaddleOCR-VL 1.6 生成版面解析 JSON/Markdown。
4. 可选调用 OpenAI-compatible 远程视觉 OCR 服务生成页级转录文本。
5. 转换为项目自己的 `Document/Page/Region` 中间格式。
6. 在浏览器工作台里看图、选框、改字、调顺序、标记校对。
7. 使用大语言模型识别目录层级、诗作、组诗、词曲、序跋、传记与注文关系。
8. 导出 TXT、Markdown、HTML 和完整 JSON。

## 本地运行

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/?project=<project-id>`。如果省略 `project`，程序优先选择 `OLDBOOK_PROJECT_ID` 指定的项目，其次选择第一个未归档项目。

## 诗歌古籍结构化（第二步）

脚本已按 OCR、维护和样本分组。反馈修订统一使用 `scripts/ebook.mjs` 的
`generate → evaluate → apply` 候选流程，详见 [脚本使用说明](scripts/README.md)。
此流程不直接覆盖正文；下述首页首次生成流程仍按批保存，两者暂未合并。

首页顶部的工作流 Tab 分为“1 双 OCR 与校对”和“2 诗歌古籍结构化”。第二步读取第一步已经修改并保存的
`edited_text`，可选择最多两套 OCR 结果互校。任务每 5 个核心页调用一次模型，同时携带前后各 1 页作为跨页上下文；完成一组就写入
`data/projects/<project-id>/ebook/structured.json`；中途失败后再次运行会从已完成页继续。

复制 `.env.example` 为 `.env.local`，只需填写硅基流动 API Key：

```dotenv
SILICONFLOW_API_KEY=sk-your-key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V3.2
SILICONFLOW_MAX_TOKENS=8192
```

重启 `npm run dev` 后进入“诗歌古籍结构化”，默认运行 1–30 页。右侧 JSON 编辑器仅在结构合法时更新中间的
电子排版预览，并在 800ms 后自动保存；`Ctrl+S` 可立即保存。JSON 的核心条目类型包括 `heading`、
`book_text`、`biography`、`poem`、`preface`、`note`、`colophon` 和 `other`。`poem` 同时承载诗、词、曲等韵文，具体体裁记录在 `form`；疑难字统一进入顶层 `issues`，不让模型静默猜字。

相关 API：

```text
GET  /api/projects/:projectId/ebook
PUT  /api/projects/:projectId/ebook
POST /api/projects/:projectId/ebook/run
POST /api/projects/:projectId/ebook/candidates/:runId/apply
GET  /api/projects/:projectId/history
GET  /api/projects/:projectId/ai-memory
```

## 修改记录与 AI 经验

工作台把人工校对、Codex 直接修改和硅基流动模型运行统一记录在项目目录中：

```text
data/projects/<project-id>/
  history/events.jsonl                 # 逐字段 before/after 事件流水，带 SHA-256 哈希链
  history/ledger.json                  # 事件链末端与数量
  history/state/*.json                 # 外部修改检测基线，仅用于比较
  history/runs/<run-id>/manifest.json  # AI 运行模型、参数、状态和输入输出哈希
  history/runs/<run-id>/steps/*.json   # 每批实际提示词、模型原始响应和 usage
  history/runs/<run-id>/input.json
  history/runs/<run-id>/output.json
  ai-memory/overview.json              # 从事件流水自动汇总的统计、模式和短案例
  ai-memory/AI_CONTEXT.md              # 给 Codex 和目标模型读取的紧凑上下文
```

浏览器保存会自动标为 `human`；DeepSeek 结构化、注文标点和散文句读会标为
`ai:siliconflow`，并保留完整 run 档案。API 服务每 3 秒检查受管 JSON，绕过接口的改动也会补记；没有主动声明身份时只标为 `external`，不猜测是谁修改。

Codex 直接改项目 JSON 时按仓库根目录 `AGENTS.md` 执行：

```powershell
node scripts/history.mjs begin --project yiyuji-four-volumes --actor ai:codex --source codex-direct-edit --note "本次修改目的"
# 修改 JSON
node scripts/history.mjs commit --project yiyuji-four-volumes
```

已有旧备份可一次性重建目前能确认的历史。无法从文件证据可靠判断的时间段会明确标为
`legacy-current-gap`，不会冒充人工或 AI 记录：

```powershell
npm run history:bootstrap -- --project yiyuji-four-volumes
npm run history:show -- --project yiyuji-four-volumes --limit 10
```

经验摘要不是自动纠错表。DeepSeek 提示词会读取它，但仍以当前页原图和明确人工校订为最高证据；AI 自己产生的历史修改保留来源标签，不能当成人工定论。`data/projects/` 仍属于本地项目数据并被 Git 忽略，备份时应连同整个项目目录保存。

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
`node scripts/maintenance/migrate_projects.mjs --archive-existing` 会归档运行时的全部项目，不要在日常启动中重复执行。

多卷 PDF 导入（按实际卷次顺序重复传入 `--pdf`）：

```powershell
python -m pip install --target tools/pdf-render-deps pymupdf
npm run volume:prepare -- --project-id <project-id> --pdf "卷一.pdf" --pdf "卷二.pdf"
npm run volume:ocr -- --project-id <project-id> --title "书名"
npm run volume:validate -- --project-id <project-id>
```

扫描 PDF 默认关闭 unwarp，两模型使用相同输入；照片可加 `--unwarp`。默认先跑完 PaddleOCR-VL，再跑 PP-OCRv6。
端口为 `192.168.50.100:20000`，识别串行执行，503 有限退避重试。原始结果逐页缓存，重复执行可续跑；已可编辑的页面不会被导入覆盖。
进度写入 `batch-progress.json`，失败页明确记录，重跑会复用已完成结果。界面点“重新载入”可看到新完成页。
输入页全部按原 PDF 保留，包括封面和空白页；全局页码与卷内页码同时写入 `source-images.json`。

导出只针对当前选择的模型，文件名包含结果 ID，不会覆盖另一模型的导出。
JSON 导出是当前结果的页面快照；完整备份应保留整个项目目录及被引用的源图目录。
命令行可指定 `--result-id paddleocr-vl` 或 `--result-id pp-ocrv6`。
重建已迁移项目时，`build_project.py` 必须用新的 `--result-id`，通过已运行的本地 API 追加结果，保护已校对内容。

```powershell
node --test server/project-store.test.mjs
npm run build
python scripts/ocr/export_project.py --project-id <project-id> --result-id pp-ocrv6 --mode edited
```

## 常用命令

重新渲染 PDF 页面：

```powershell
.\scripts\ocr\render_pdf_pages.ps1 -InputPdf "sample.pdf" -OutputDir "data/projects/sample/pages" -FirstPage 1 -LastPage 20 -Dpi 144
```

重建中间 JSON：

```powershell
npm run project:build -- --project-id <project-id> --title "书名" --source-path "sample.pdf"
```

命令行导出：

```powershell
npm run project:export -- --project-id <project-id> --mode edited
```

## 《疑雨集注》样本项目

以下章节记录当前《疑雨集注》照片与PDF样本的复现实验，属于样本配置，不是通用流程的默认值。照片项目位于 `data/projects/yiyuji-photos/`：

- `originals/`: 原始 6 张 Telegram 照片。
- `pages/`: 旋正后的测试页面，`page-001.jpg` 到 `page-006.jpg`。
- `orientation-preview.jpg`: 旋正预览图。
- `ocr/ndlkoten/`: NDL OCR 原始输出。
- `project.json`: 工作台读取和保存的中间格式。
- `exports/`: TXT、Markdown、HTML、JSON 导出。

重新生成旋正图片：

```powershell
python scripts/samples/prepare_yiyuji_photos.py
```

重新生成照片项目中间 JSON：

```powershell
npm run project:build -- --project-id yiyuji-photos --title "疑雨集註 手机照片测试" --source-path data/projects/yiyuji-photos/source-images.json
```

导出照片项目：

```powershell
npm run project:export -- --project-id yiyuji-photos --mode edited
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
npm run ocr:paddlevl -- --project-id yiyuji-photos --pages 1-6 --device gpu:0
npm run project:build -- --project-id yiyuji-photos-paddlevl --pages-project-id yiyuji-photos --ocr-project-id yiyuji-photos --ocr-provider paddlevl --title "疑雨集註 手机照片 PaddleOCR-VL" --source-path data/projects/yiyuji-photos/source-images.json --no-preserve-edits
npm run project:export -- --project-id yiyuji-photos-paddlevl --mode edited
```

跑 PDF 渲染图 1-6 页：

```powershell
npm run ocr:paddlevl -- --project-id yiyuji --pages 1-6 --device gpu:0 --no-unwarping
npm run project:build -- --project-id yiyuji-paddlevl --pages-project-id yiyuji --ocr-project-id yiyuji --ocr-provider paddlevl --title "疑雨集註 PDF样本 PaddleOCR-VL" --source-path data/input/yiyuji-source.pdf --total-pages 110 --limit 6 --no-preserve-edits
npm run project:export -- --project-id yiyuji-paddlevl --mode edited
```

PaddleOCR-VL 项目不会覆盖 NDL 项目，而是生成新的对照项目：

- `yiyuji-photos-paddlevl`
- `yiyuji-paddlevl`

## 远程 OpenAI-compatible PaddleOCR-VL

如果另一台机器已经把 PaddleOCR-VL 暴露成 OpenAI-compatible API，可以直接调用远程服务：

```powershell
npm run ocr:openai-vl -- --project-id yiyuji-photos --pages 1-6 --base-url http://192.168.50.100:1234/v1 --model paddleocr-vl-1.6 --force
npm run project:build -- --project-id yiyuji-photos-openaivl --pages-project-id yiyuji-photos --ocr-project-id yiyuji-photos --ocr-provider openaivl --title "疑雨集註 手机照片 远程PaddleOCR-VL" --source-path data/projects/yiyuji-photos/source-images.json --no-preserve-edits
npm run project:export -- --project-id yiyuji-photos-openaivl --mode edited
```

PDF 渲染图 1-6 页：

```powershell
npm run ocr:openai-vl -- --project-id yiyuji --pages 1-6 --base-url http://192.168.50.100:1234/v1 --model paddleocr-vl-1.6 --force
npm run project:build -- --project-id yiyuji-openaivl --pages-project-id yiyuji --ocr-project-id yiyuji --ocr-provider openaivl --title "疑雨集註 PDF样本 远程PaddleOCR-VL" --source-path data/input/yiyuji-source.pdf --total-pages 110 --limit 6 --no-preserve-edits
npm run project:export -- --project-id yiyuji-openaivl --mode edited
```

以下是当前样本使用的地址和模型，通用命令必须显式传入：

```text
http://192.168.50.100:1234/v1
paddleocr-vl-1.6
```

也可以直接运行脚本并覆盖参数：

```powershell
python scripts/ocr/run_openai_vl.py --project-id yiyuji-photos --pages 1-6 --base-url http://192.168.50.100:1234/v1 --model paddleocr-vl-1.6 --force
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
npm run ocr:remote-paddlevl -- --project-id yiyuji-photos --pages 1-6 --service-url http://192.168.50.100:8000 --force
npm run project:build -- --project-id yiyuji-photos-remote-paddlevl --pages-project-id yiyuji-photos --ocr-project-id yiyuji-photos --ocr-provider remotepaddlevl --title "疑雨集註 手机照片 远程PaddleOCR-VL原生" --source-path data/projects/yiyuji-photos/source-images.json --no-preserve-edits
npm run project:export -- --project-id yiyuji-photos-remote-paddlevl --mode edited
```

PDF 渲染图 1-6 页默认关闭展平：

```powershell
npm run ocr:remote-paddlevl -- --project-id yiyuji --pages 1-6 --service-url http://192.168.50.100:8000 --no-unwarp --force
npm run project:build -- --project-id yiyuji-remote-paddlevl --pages-project-id yiyuji --ocr-project-id yiyuji --ocr-provider remotepaddlevl --title "疑雨集註 PDF样本 远程PaddleOCR-VL原生" --source-path data/input/yiyuji-source.pdf --total-pages 110 --limit 6 --no-preserve-edits
npm run project:export -- --project-id yiyuji-remote-paddlevl --mode edited
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
