# 诗笺 · Shijian Workbench

[English](README.en.md) · [日本語](README.ja.md)

## 简介

诗笺是面向中国古籍的本地 AI 辅助 OCR 与校对工作台。它支持对照识别结果与书页图像、人工修正文稿，并将诗文整理成可审阅的结构化文本。项目数据和书页图像保存在本地，不随源代码提交。

## 启动方式

需要 Node.js 20.19+ 或 22.12+；运行 OCR 命令时还需要 Python 3.10+。在仓库根目录执行：

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

如需使用 AI 结构化功能，在 `.env.local` 中填写 `SILICONFLOW_API_KEY`。启动后打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)；已有本地项目可通过 `?project=<project-id>` 指定。仓库不包含书页图像和项目数据，请将自己的项目放在 `data/projects/<project-id>/`。
