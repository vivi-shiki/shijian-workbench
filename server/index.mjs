import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EbookStore } from "./ebook-store.mjs";
import { ProjectStore } from "./project-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
for (const envFile of [".env.local", ".env"]) {
  try { process.loadEnvFile(path.join(rootDir, envFile)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const projectsRoot = path.join(rootDir, "data", "projects");
const store = new ProjectStore(projectsRoot);
const ebookStore = new EbookStore(projectsRoot, store);

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/data", express.static(path.join(rootDir, "data")));

function safeProjectId(projectId) {
  const id = projectId || defaultProjectId();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
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

function defaultProjectId() {
  return process.env.OLDBOOK_PROJECT_ID || "yiyuji-photos";
}

async function readProject(projectId = defaultProjectId(), resultId) {
  return store.view(safeProjectId(projectId), resultId);
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
    res.json(await readProject(defaultProjectId()));
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
      projects.push({
        id: project.id,
        title: project.title,
        pages: active?.page_count || 0,
        regions: active?.regions || 0,
        archived: Boolean(project.archived),
        results: project.results
      });
    } catch {
      // Skip incomplete project folders.
    }
  }
  projects.sort((a, b) => Number(a.archived) - Number(b.archived) || a.id.localeCompare(b.id));
  res.json({ defaultProjectId: projects.find(p => !p.archived)?.id || defaultProjectId(), projects });
});

app.get("/api/project/:projectId", async (req, res) => {
  try {
    res.json(await readProject(req.params.projectId, req.query.result));
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
  res.json(await store.save(projectId, project));
}

app.put("/api/project", handleWriteProject);
app.put("/api/project/:projectId", handleWriteProject);

app.post("/api/projects/:projectId/results", async (req, res) => {
  res.json(await store.importResult(safeProjectId(req.params.projectId), req.body));
});

app.put("/api/projects/:projectId/results/:resultId/pages/:pageId", async (req, res) => {
  if (req.params.pageId !== req.body.id || !Array.isArray(req.body.regions)) {
    return res.status(400).json({ error: "invalid_page" });
  }
  res.json(await store.importPage(safeProjectId(req.params.projectId), req.params.resultId, req.body));
});

app.get("/api/projects/:projectId/ebook", async (req, res) => {
  res.json(await ebookStore.read(safeProjectId(req.params.projectId)));
});

app.put("/api/projects/:projectId/ebook", async (req, res) => {
  res.json(await ebookStore.save(safeProjectId(req.params.projectId), req.body));
});

app.post("/api/projects/:projectId/ebook/run", async (req, res) => {
  res.json(await ebookStore.run(safeProjectId(req.params.projectId), req.body));
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

app.listen(3100, "127.0.0.1", () => {
  console.log("API listening on http://127.0.0.1:3100");
});
