# 诗笺 · Shijian Workbench

## 中文

### 简介

诗笺是面向中国古籍的本地 AI 辅助 OCR 与校对工作台。它支持对照识别结果与书页图像、人工修正文稿，并将诗文整理成可审阅的结构化文本。项目数据和书页图像保存在本地，不随源代码提交。

### 启动方式

需要 Node.js 20.19+ 或 22.12+；运行 OCR 命令时还需要 Python 3.10+。在仓库根目录执行：

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

如需使用 AI 结构化功能，在 `.env.local` 中填写 `SILICONFLOW_API_KEY`。启动后打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)；已有本地项目可通过 `?project=<project-id>` 指定。仓库不包含书页图像和项目数据，请将自己的项目放在 `data/projects/<project-id>/`。

## English

### Introduction

Shijian Workbench is a local, AI-assisted OCR and proofreading workspace for classical Chinese books. It lets you compare OCR output with page images, correct transcriptions, and organize poetry and prose into reviewable structured text. Project data and page images stay local and are not committed with the source code.

### Getting started

Use Node.js 20.19+ or 22.12+. Python 3.10+ is also needed for OCR commands. From the repository root, run:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

To use AI-assisted structuring, set `SILICONFLOW_API_KEY` in `.env.local`. Open [http://127.0.0.1:5173](http://127.0.0.1:5173) after startup. For an existing local project, add `?project=<project-id>` to the URL. The repository does not include page images or project data; place your own project under `data/projects/<project-id>/`.

## 日本語

### 概要

詩箋は、中国の古典籍を対象とするローカルの AI 支援 OCR・校正ワークベンチです。OCR 結果とページ画像を照合して翻刻を修正し、詩文を確認可能な構造化テキストに整理できます。プロジェクトデータとページ画像はローカルに保存され、ソースコードと一緒にはコミットされません。

### 起動方法

Node.js 20.19 以降または 22.12 以降が必要です。OCR コマンドの実行には Python 3.10 以降も必要です。リポジトリのルートで以下を実行してください。

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

AI による構造化を使う場合は、`.env.local` に `SILICONFLOW_API_KEY` を設定してください。起動後、[http://127.0.0.1:5173](http://127.0.0.1:5173) を開きます。既存のローカルプロジェクトを指定するには、URL に `?project=<project-id>` を追加してください。このリポジトリにページ画像やプロジェクトデータは含まれていません。自分のプロジェクトは `data/projects/<project-id>/` に配置してください。
