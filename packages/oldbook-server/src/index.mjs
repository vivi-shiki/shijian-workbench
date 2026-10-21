import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";
import { EbookCandidates } from "../../oldbook-core/src/ebook-candidates.mjs";
import { EbookReview } from "../../oldbook-core/src/ebook-review.mjs";
import { ProjectStore } from "../../oldbook-core/src/project-store.mjs";
import { DatasetStore } from "../../oldbook-core/src/dataset-store.mjs";
import { planEntryRevision, assertSingleEntryCandidate } from "../../oldbook-core/src/desktop-work-units.mjs";
import { JobQueue, summarizeProject, estimateModelCost } from "../../oldbook-core/src/desktop-jobs.mjs";
import { previewSources, createImportedProject, createSampleProject, checkModelConnection,
  createSourceAdapters } from "../../oldbook-core/src/desktop-onboarding.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
for (const envFile of [".env.local", ".env"]) {
  try { process.loadEnvFile(path.join(rootDir, envFile)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const projectsRoot = path.resolve(process.env.OLDBOOK_PROJECTS_ROOT || path.join(rootDir, "data", "projects"));
const historyStore = new HistoryStore(projectsRoot);
const store = new ProjectStore(projectsRoot, historyStore);
const ebookStore = new EbookStore(projectsRoot, store, historyStore);
const ebookCandidates = new EbookCandidates(historyStore);
const ebookReview = new EbookReview(projectsRoot, historyStore, {
  skillPath: path.join(rootDir, "packages", "oldbook-skills", "oldbook-poetry-structuring", "SKILL.md")
});
const datasetStore = new DatasetStore(projectsRoot, rootDir);
const jobQueue = new JobQueue({ directory: path.join(projectsRoot, ".desktop-jobs"), runners: {
  structure: async ({ project_id: projectId, start_page: startPage, end_page: endPage,
    result_ids: resultIds, chunk_size: chunkSize, checkpoint, report, signal }) => {
    const first = Math.max(startPage, (checkpoint?.completed || startPage - 1) + 1);
    const runs = checkpoint?.runs || [];
    for (let page = first; page <= endPage; page += chunkSize) {
      if (signal.aborted) throw signal.reason;
      const end = Math.min(endPage, page + chunkSize - 1);
      const result = await ebookStore.run(projectId, { start_page: page, end_page: end,
        result_ids: resultIds, chunk_size: chunkSize });
      runs.push(result.candidate.run_id);
      await report({ completed: end, total: endPage, checkpoint: { completed: end, runs: [...runs] },
        last_run_id: result.candidate.run_id });
    }
  }
} });

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/data/projects", express.static(projectsRoot));
app.use("/data", express.static(path.join(rootDir, "data")));

function safeProjectId(projectId) {
  const id = projectId;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    const error = new Error("Invalid project id");
    error.status = 400;
    throw error;
  }
  return id;
}

function projectDirFor(projectId) {
  return path.join(projectsRoot, safeProjectId(projectId));
}

function exportDirFor(projectId) {
  return path.join(projectDirFor(projectId), "exports");
}

async function availableProjectIds() {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

async function resolveDefaultProjectId() {
  const configured = process.env.OLDBOOK_PROJECT_ID;
  const ids = await availableProjectIds();
  if (configured && ids.includes(configured)) return configured;
  for (const id of ids) {
    try {
      if (!(await store.index(id)).archived) return id;
    } catch {
      // Ignore incomplete project directories.
    }
  }
  return ids[0] || "";
}

function auditFromRequest(req, defaults = {}) {
  const requestedActor = String(req.get("x-oldbook-actor") || defaults.actor || "human");
  const actor = /^(human|system|external|ai:[a-z0-9-]+)$/i.test(requestedActor)
    ? requestedActor
    : defaults.actor || "human";
  const requestedSource = String(req.get("x-oldbook-source") || defaults.source || "api");
  const source = /^[a-z0-9][a-z0-9-]{0,79}$/i.test(requestedSource)
    ? requestedSource
    : defaults.source || "api";
  const channel = String(req.get("x-oldbook-channel") || defaults.channel || "api").slice(0, 40);
  const requestedBy = String(req.get("x-oldbook-requested-by") || defaults.requested_by || "").slice(0, 80);
  return { actor, source, channel, requested_by: requestedBy,
    note: String(req.get("x-oldbook-note") || "").slice(0, 500) };
}

async function readProject(projectId, resultId) {
  const id = projectId || await resolveDefaultProjectId();
  if (!id) throw Object.assign(new Error("No project.json files found"), { status: 404 });
  return store.view(safeProjectId(id), resultId);
}

function orderedPages(project) {
  return [...project.pages].sort((a, b) => a.page_number - b.page_number);
}

function orderedRegions(page) {
  return [...page.regions].sort((a, b) => a.order - b.order);
}

function regionText(region, mode = "edited") {
  if (mode === "raw") return region.raw_text || "";
  if (mode === "reading") {
    return region.reading_text || region.edited_text || region.raw_text || "";
  }
  return region.edited_text ?? region.raw_text ?? "";
}

function pageText(page, mode = "edited") {
  return orderedRegions(page)
    .map((region) => regionText(region, mode).trim())
    .filter(Boolean)
    .join("\n");
}

function buildText(project, mode = "edited") {
  return orderedPages(project)
    .map((page) => pageText(page, mode))
    .filter(Boolean)
    .join("\n\n");
}

function buildMarkdown(project, mode = "edited") {
  const lines = [`# ${project.title}`, ""];
  for (const page of orderedPages(project)) {
    const text = pageText(page, mode);
    if (!text) continue;
    lines.push(`## Page ${String(page.page_number).padStart(3, "0")}`, "", text, "");
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildHtml(project, mode = "edited") {
  const pageSections = orderedPages(project)
    .map((page) => {
      const text = escapeHtml(pageText(page, mode)).replaceAll("\n", "<br />\n");
      if (!text) return "";
      return `<section class="page"><h2>Page ${String(page.page_number).padStart(3, "0")}</h2><p>${text}</p></section>`;
    })
    .filter(Boolean)
    .join("\n");

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(project.title)}</title>
  <style>
    body { margin: 0; font-family: "Noto Serif CJK TC", "Source Han Serif TC", serif; color: #191714; background: #f6f0e6; }
    main { max-width: 860px; margin: 0 auto; padding: 48px 22px 72px; }
    h1 { font-size: 30px; line-height: 1.25; margin: 0 0 32px; }
    h2 { font-size: 16px; margin: 36px 0 12px; color: #6b6255; font-family: system-ui, sans-serif; }
    p { font-size: 22px; line-height: 2; margin: 0; white-space: normal; }
    .page { padding-block: 10px 28px; border-top: 1px solid #d8ccb8; }
  </style>
</head>
<body><main><h1>${escapeHtml(project.title)}</h1>${pageSections}</main></body>
</html>
`;
}

app.get("/api/project", async (_req, res) => {
  try {
    res.json(await readProject());
  } catch (error) {
    res.status(404).json({
      error: "project_not_found",
      message: `Run npm run project:build first. ${error.message}`
    });
  }
});

app.get("/api/projects", async (_req, res) => {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = await store.index(entry.name);
      const active = project.results.find(r => r.id === project.active_result_id);
      const sourcePages = project.source?.pages || [];
      projects.push({
        id: project.id,
        title: project.title,
        pages: sourcePages.length || active?.page_count || 0,
        page_range: sourcePages.length ? {
          start: Math.min(...sourcePages.map(page => page.page_number)),
          end: Math.max(...sourcePages.map(page => page.page_number))
        } : null,
        regions: active?.regions || 0,
        archived: Boolean(project.archived),
        results: project.results
      });
    } catch {
      // Skip incomplete project folders.
    }
  }
  projects.sort((a, b) => Number(a.archived) - Number(b.archived) || a.id.localeCompare(b.id));
  const configured = process.env.OLDBOOK_PROJECT_ID;
  const configuredProject = projects.find(project => project.id === configured);
  res.json({
    defaultProjectId: configuredProject?.id || projects.find(project => !project.archived)?.id || projects[0]?.id || null,
    projects
  });
});

app.post("/api/onboarding/preview", async (req, res) => {
  res.json(await previewSources(req.body?.sources));
});

app.post("/api/onboarding/create", async (req, res) => {
  const sources = req.body?.sources;
  const plan = await previewSources(sources);
  const id = req.body?.id || `book-${crypto.randomBytes(5).toString("hex")}`;
  const project = await createImportedProject({ root: projectsRoot, id,
    title: req.body?.title, plan, adapters: createSourceAdapters() });
  res.status(201).json({ id: project.id, title: project.title, pages: plan.page_count });
});

app.post("/api/onboarding/sample", async (_req, res) => {
  const filename = path.join(projectsRoot, "sample-poetry", "project.json");
  const existing = await fs.readFile(filename, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const project = existing || await createSampleProject(projectsRoot);
  res.status(existing ? 200 : 201).json({ id: project.id, title: project.title, pages: 1 });
});

app.post("/api/onboarding/model-check", async (req, res) => {
  res.json(await checkModelConnection({ baseUrl: req.body?.baseUrl, apiKey: req.body?.apiKey }));
});

app.get("/api/projects/:projectId/reader", async (req, res) => {
  try {
    const projectId = safeProjectId(req.params.projectId);
    const requestedFrom = Number(req.query.from);
    const requestedTo = Number(req.query.to);
    const from = Number.isInteger(requestedFrom) && requestedFrom > 0 ? requestedFrom : undefined;
    const to = Number.isInteger(requestedTo) && requestedTo >= from ? requestedTo : undefined;
    const [reader, ebookPayload] = await Promise.all([
      store.readerWindow(projectId, from, to),
      ebookStore.read(projectId)
    ]);
    res.json({
      manifest: null,
      approval: null,
      links: { summary: {}, links: [], by_target: {}, by_region: {} },
      ebook: ebookPayload.document,
      model_config: ebookPayload.config,
      ...reader
    });
  } catch (error) {
    res.status(error.status || 404).json({
      error: "reader_not_found",
      message: error.message
    });
  }
});

app.get("/api/projects/:projectId/overview", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  const [project, ebook, jobs] = await Promise.all([store.view(projectId), ebookStore.read(projectId), jobQueue.list(projectId)]);
  const regions = project.pages.flatMap(page => page.regions || []);
  res.json({ overview: summarizeProject({ pages: project.pages, regions,
    entries: ebook.document.entries, jobs }), jobs });
});

app.post("/api/projects/:projectId/jobs/estimate", async (req, res) => {
  const project = await store.index(safeProjectId(req.params.projectId));
  const start = Number(req.body?.start_page) || project.source?.pages?.[0]?.page_number || 1;
  const end = Number(req.body?.end_page) || project.source?.pages?.at(-1)?.page_number || start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start ||
      end > (project.source?.pages?.at(-1)?.page_number || 0)) {
    throw Object.assign(new Error("页码范围无效"), { status: 400 });
  }
  const price = Number(process.env.SILICONFLOW_PRICE_PER_MILLION_TOKENS);
  res.json({ estimate: estimateModelCost({ pages: end - start + 1, tokensPerPage: 2000,
    pricePerMillionTokens: price > 0 ? price : undefined,
    budget: req.body?.budget == null ? undefined : Number(req.body.budget) }),
  page_range: { start, end }, warning: "模型费用为估计值，实际消耗以服务商账单为准。" });
});

app.post("/api/projects/:projectId/jobs", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  if (req.body?.type !== "structure") throw Object.assign(new Error("仅支持结构化任务"), { status: 400 });
  if (req.body?.confirm_cost !== true) throw Object.assign(new Error("请先确认模型费用与处理时间"), { status: 400 });
  const project = await store.index(projectId);
  const start = Number(req.body.start_page) || project.source?.pages?.[0]?.page_number || 1;
  const end = Number(req.body.end_page) || project.source?.pages?.at(-1)?.page_number || start;
  const chunkSize = Number(req.body.chunk_size) || 5;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start ||
      end > (project.source?.pages?.at(-1)?.page_number || 0) ||
      !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) {
    throw Object.assign(new Error("页码或分批大小无效"), { status: 400 });
  }
  const resultIds = (req.body.result_ids || []).filter(id =>
    project.results.some(item => item.id === id && !item.archived)).slice(0, 2);
  if (!resultIds.length) throw Object.assign(new Error("请先选择 OCR 结果"), { status: 400 });
  const price = Number(process.env.SILICONFLOW_PRICE_PER_MILLION_TOKENS);
  const estimate = estimateModelCost({ pages: end - start + 1, tokensPerPage: 2000,
    pricePerMillionTokens: price > 0 ? price : undefined,
    budget: req.body.budget == null ? undefined : Number(req.body.budget) });
  if (estimate.over_budget) throw Object.assign(new Error("预计费用超过设定预算"), { status: 400 });
  res.status(202).json({ job: await jobQueue.enqueue({ type: "structure", project_id: projectId,
    start_page: start, end_page: end, result_ids: resultIds, chunk_size: chunkSize }), estimate });
});

app.post("/api/projects/:projectId/jobs/:jobId/:action", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  const job = await jobQueue.get(req.params.jobId);
  if (job.project_id !== projectId) throw Object.assign(new Error("任务不属于该项目"), { status: 404 });
  const action = req.params.action;
  if (!["pause", "resume", "cancel"].includes(action)) throw Object.assign(new Error("无效任务操作"), { status: 400 });
  res.json({ job: await jobQueue[action](job.id) });
});

app.get("/api/project/:projectId", async (req, res) => {
  try {
    const project = await readProject(req.params.projectId, req.query.result);
    const start = Number(req.query.from);
    const end = Number(req.query.to);
    res.json(Number.isInteger(start) && Number.isInteger(end) && end >= start
      ? { ...project, pages: project.pages.filter(page => page.page_number >= start && page.page_number <= end) }
      : project);
  } catch (error) {
    res.status(error.status || 404).json({
      error: "project_not_found",
      message: error.message
    });
  }
});

async function handleWriteProject(req, res) {
  const project = req.body;
  if (!project || !Array.isArray(project.pages)) {
    res.status(400).json({ error: "invalid_project" });
    return;
  }
  const projectId = safeProjectId(req.params.projectId || project.id);
  res.json(await store.save(projectId, project,
    auditFromRequest(req, { actor: "human", source: "ocr-workbench" })));
}

app.put("/api/project", handleWriteProject);
app.put("/api/project/:projectId", handleWriteProject);

app.post("/api/projects/:projectId/results", async (req, res) => {
  res.json(await store.importResult(safeProjectId(req.params.projectId), req.body,
    auditFromRequest(req, { actor: "ai:ocr", source: "ocr-import" })));
});

app.put("/api/projects/:projectId/results/:resultId/pages/:pageId", async (req, res) => {
  if (req.params.pageId !== req.body.id || !Array.isArray(req.body.regions)) {
    return res.status(400).json({ error: "invalid_page" });
  }
  res.json(await store.importPage(safeProjectId(req.params.projectId), req.params.resultId, req.body,
    auditFromRequest(req, { actor: "ai:ocr", source: "ocr-batch" })));
});

app.get("/api/projects/:projectId/ebook", async (req, res) => {
  res.json(await ebookStore.read(safeProjectId(req.params.projectId)));
});

app.get("/api/projects/:projectId/datasets", async (req, res) => {
  res.json({ datasets: await datasetStore.list(safeProjectId(req.params.projectId)) });
});

app.get("/api/projects/:projectId/datasets/latest", async (req, res) => {
  res.json(await datasetStore.latest(safeProjectId(req.params.projectId)));
});

app.get("/api/projects/:projectId/datasets/:datasetId", async (req, res) => {
  res.json(await datasetStore.read(safeProjectId(req.params.projectId), req.params.datasetId));
});

app.put("/api/projects/:projectId/ebook", async (req, res) => {
  res.json(await ebookStore.save(safeProjectId(req.params.projectId), req.body,
    auditFromRequest(req, { actor: "human", source: "ebook-json-editor" })));
});

app.post("/api/projects/:projectId/ebook/run", async (req, res) => {
  res.json(await ebookStore.run(safeProjectId(req.params.projectId), req.body));
});

app.post("/api/projects/:projectId/ebook/revise-page", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  const result = await ebookStore.revisePage(projectId, req.body);
  if (req.body?.apply_mode === "direct_overwrite") {
    const revision = result.revision;
    const saved = await ebookCandidates.approve(projectId, revision.run_id, {
      candidate_hash: revision.candidate_hash,
      note: "用户在修订弹窗选择直接覆盖并自动批准",
      channel: "web", requested_by: "human"
    }, ebookStore, auditFromRequest(req, { actor: "human", source: "web-page-revision",
      channel: "web", requested_by: "human" }));
    res.json({ ...result, approved: true, document: saved.document });
    return;
  }
  res.json(result);
});

app.post("/api/projects/:projectId/ebook/revise-entry", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  const manualPrompt = String(req.body?.manual_prompt || "").trim();
  if (!manualPrompt || manualPrompt.length > 6000) {
    throw Object.assign(new Error("请输入不超过 6000 字的作品修订要求"), { status: 400 });
  }
  const document = (await ebookStore.read(projectId)).document;
  const project = await store.index(projectId);
  const availableResults = (document.source?.result_ids || [])
    .filter(id => project.results.some(result => result.id === id && !result.archived));
  if (!availableResults.length) availableResults.push(...project.results.filter(result => !result.archived)
    .slice(0, 2).map(result => result.id));
  const plan = planEntryRevision(document, req.body?.entry_id, availableResults.slice(0, 2));
  const singleRevision = req.body?.revision_mode === "single_revision";
  const directOverwrite = req.body?.apply_mode === "direct_overwrite";
  const task = { schema_version: 1, id: `desktop-entry-${plan.entry_ids[0]}-${Date.now()}`,
    mode: "structure", scope: "local", category: "单首作品修订", entry_ids: plan.entry_ids,
    result_ids: plan.result_ids, rules: [
      "本次只修订目标作品，其他作品即使同页也只能作为上下文，不得增删、重排或修改。",
      `用户本次要求（最高优先级）：${manualPrompt}`
    ], ...(singleRevision ? { revision_mode: "single_revision" } : {}),
    ...(directOverwrite ? { apply_mode: "direct_overwrite" } : {}) };
  const revision = await ebookReview.generate(projectId, task);
  assertSingleEntryCandidate(document, revision.candidate, plan.entry_ids[0]);
  if (directOverwrite) {
    const saved = await ebookCandidates.approve(projectId, revision.run_id, {
      candidate_hash: revision.candidate_hash, note: "用户选择直接覆盖此作品修订",
      channel: "desktop", requested_by: "human"
    }, ebookStore, auditFromRequest(req, { actor: "human", source: "desktop-entry-revision" }));
    res.json({ revision, approved: true, document: saved.document, plan });
    return;
  }
  res.json({ revision, approved: false, plan });
});

app.post("/api/projects/:projectId/ebook/revise-page/:runId/apply", async (req, res) => {
  res.json(await ebookCandidates.approve(safeProjectId(req.params.projectId), req.params.runId, req.body, ebookStore,
    auditFromRequest(req, { actor: "human", source: "web-page-revision", channel: "web", requested_by: "human" })));
});

app.post("/api/projects/:projectId/ebook/candidates/:runId/apply", async (req, res) => {
  res.json(await ebookCandidates.approve(safeProjectId(req.params.projectId), req.params.runId, req.body, ebookStore,
    auditFromRequest(req, { actor: "human", source: "legacy-candidate-apply" })));
});

app.get("/api/projects/:projectId/ebook/candidates", async (req, res) => {
  res.json({ candidates: await ebookCandidates.list(safeProjectId(req.params.projectId), {
    state: req.query.state || null,
    limit: req.query.limit
  }) });
});

app.get("/api/projects/:projectId/ebook/candidates/:runId", async (req, res) => {
  res.json(await ebookCandidates.get(safeProjectId(req.params.projectId), req.params.runId));
});

app.post("/api/projects/:projectId/ebook/candidates/:runId/approve", async (req, res) => {
  res.json(await ebookCandidates.approve(safeProjectId(req.params.projectId), req.params.runId, req.body, ebookStore,
    auditFromRequest(req, { actor: "human", source: "candidate-api" })));
});

app.post("/api/projects/:projectId/ebook/candidates/:runId/abandon", async (req, res) => {
  res.json(await ebookCandidates.abandon(safeProjectId(req.params.projectId), req.params.runId, req.body,
    auditFromRequest(req, { actor: "human", source: "candidate-api" })));
});

app.get("/api/projects/:projectId/history", async (req, res) => {
  res.json(await historyStore.read(safeProjectId(req.params.projectId), req.query.limit));
});

app.get("/api/projects/:projectId/ai-memory", async (req, res) => {
  const projectId = safeProjectId(req.params.projectId);
  const history = await historyStore.read(projectId, 1);
  res.json({ overview: history.overview, context: await historyStore.aiContext(projectId) });
});

async function handleExport(req, res) {
  const projectId = safeProjectId(req.params.projectId);
  const mode = req.body?.mode || "edited";
  const project = await readProject(projectId, req.body?.result_id);
  const exportDir = exportDirFor(projectId);
  await fs.mkdir(exportDir, { recursive: true });

  const baseName = `${project.id}-${project.active_result_id}-${mode}`;
  const outputs = {
    txt: path.join(exportDir, `${baseName}.txt`),
    md: path.join(exportDir, `${baseName}.md`),
    html: path.join(exportDir, `${baseName}.html`),
    json: path.join(exportDir, `${baseName}.json`)
  };

  await Promise.all([
    fs.writeFile(outputs.txt, buildText(project, mode), "utf8"),
    fs.writeFile(outputs.md, buildMarkdown(project, mode), "utf8"),
    fs.writeFile(outputs.html, buildHtml(project, mode), "utf8"),
    fs.writeFile(outputs.json, `${JSON.stringify(project, null, 2)}\n`, "utf8")
  ]);

  res.json({
    ok: true,
    mode,
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, path.relative(rootDir, value).replaceAll("\\", "/")])
    )
  });
}

app.post("/api/export", handleExport);
app.post("/api/projects/:projectId/export", handleExport);

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.message });
});

await jobQueue.recoverInterrupted();
app.listen(3100, "127.0.0.1", () => {
  console.log("API listening on http://127.0.0.1:3100");
  historyStore.startMonitoring();
});
