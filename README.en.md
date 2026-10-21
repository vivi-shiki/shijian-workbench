# Shijian Workbench

## Introduction

Shijian Workbench is a local, AI-assisted OCR and proofreading workspace for classical Chinese books. It lets you compare OCR output with page images, correct transcriptions, and organize poetry and prose into reviewable structured text. Project data and page images stay local and are not committed with the source code.

## Getting started

Use Node.js 20.19+ or 22.12+. Python 3.10+ is also needed for OCR commands. From the repository root, run:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

To use AI-assisted structuring, set `SILICONFLOW_API_KEY` in `.env.local`. Open [http://127.0.0.1:5173](http://127.0.0.1:5173) after startup. For an existing local project, add `?project=<project-id>` to the URL. The repository does not include page images or project data; place your own project under `data/projects/<project-id>/`.
