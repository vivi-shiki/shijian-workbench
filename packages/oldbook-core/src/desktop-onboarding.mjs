import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { safeId } from "./project-store.mjs";
import { emptyEbook } from "./ebook-store.mjs";

function requireSource(source) {
  if (!source || !["pdf", "image"].includes(source.kind) || typeof source.path !== "string" || !source.path) {
    throw new Error("Choose PDF or image files before importing");
  }
  return source;
}

async function openPdf(filename) {
  const bytes = await fs.readFile(filename);
  const pdfPackage = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))), "../..");
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true,
    disableFontFace: true, useWasm: false,
    wasmUrl: pathToFileURL(path.join(pdfPackage, "wasm") + path.sep).href });
  return loadingTask.promise;
}

export function createSourceAdapters() {
  const documents = new Map();
  const pdf = async filename => {
    if (!documents.has(filename)) documents.set(filename, await openPdf(filename));
    return documents.get(filename);
  };
  return {
    inspectPdf: async filename => ({ pages: (await pdf(filename)).numPages, bytes: (await fs.stat(filename)).size }),
    inspectImage: async filename => {
      const image = await loadImage(await fs.readFile(filename));
      return { width: image.width, height: image.height, bytes: (await fs.stat(filename)).size };
    },
    renderPdfPage: async (filename, pageNumber) => {
      const page = await (await pdf(filename)).getPage(pageNumber);
      const viewport = page.getViewport({ scale: 96 / 72 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      return { bytes: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height };
    },
    readImage: async filename => {
      const bytes = await fs.readFile(filename);
      const image = await loadImage(bytes);
      return { bytes, width: image.width, height: image.height };
    },
    dispose: async () => {
      for (const document of documents.values()) await document.loadingTask.destroy();
      documents.clear();
    }
  };
}

export async function previewSources(sources, options = {}) {
  if (!Array.isArray(sources) || !sources.length) throw new Error("Choose at least one PDF or image");
  const adapters = options.inspectPdf ? options : createSourceAdapters();
  const volumes = [];
  let pageCount = 0;
  let inputBytes = 0;
  try {
    for (const source of sources) {
      requireSource(source);
      const details = source.kind === "pdf"
        ? await adapters.inspectPdf(source.path)
        : await adapters.inspectImage(source.path);
      const pages = source.kind === "pdf" ? details.pages : 1;
      if (!Number.isInteger(pages) || pages < 1) throw new Error(`Source has no readable pages: ${source.path}`);
      volumes.push({ kind: source.kind, path: source.path, pages,
        first_page: pageCount + 1, last_page: pageCount + pages,
        bytes: details.bytes, ...(source.kind === "image" ? { width: details.width, height: details.height } : {}) });
      pageCount += pages;
      inputBytes += Number(details.bytes) || 0;
    }
  } finally {
    if (!options.inspectPdf) await adapters.dispose();
  }
  const secondsPerPage = Number(options.secondsPerPage);
  return { volumes, page_count: pageCount, input_bytes: inputBytes,
    required_bytes: Math.max(inputBytes, pageCount * 1_500_000),
    estimated_seconds: Number.isFinite(secondsPerPage) && secondsPerPage > 0
      ? Math.ceil(pageCount * secondsPerPage) : null };
}

function verifyLocation(root, id) {
  const target = path.resolve(root, safeId(id));
  if (path.dirname(target) !== path.resolve(root)) throw new Error("Invalid project location");
  return target;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Import aborted");
}

async function publishStage(stage, target) {
  try { await fs.access(target); throw new Error(`Project already exists: ${path.basename(target)}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.rename(stage, target);
}

export async function createImportedProject({ root, id, title, plan, adapters = createSourceAdapters(), signal, onProgress }) {
  const target = verifyLocation(root, id);
  if (!title?.trim() || !plan?.volumes?.length) throw new Error("Project title and source plan are required");
  const stage = path.join(path.resolve(root), `.${id}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(stage, "pages"), { recursive: true });
  const pages = [];
  let count = 0;
  try {
    for (const volume of plan.volumes) {
      for (let sourcePage = 1; sourcePage <= volume.pages; sourcePage++) {
        abortIfNeeded(signal);
        const rendered = volume.kind === "pdf"
          ? await adapters.renderPdfPage(volume.path, sourcePage)
          : await adapters.readImage(volume.path);
        const number = ++count;
        const extension = volume.kind === "pdf" ? ".png" : path.extname(volume.path).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(extension)) {
          throw new Error(`Unsupported image extension: ${extension}`);
        }
        const filename = `page-${String(number).padStart(3, "0")}${extension}`;
        await fs.writeFile(path.join(stage, "pages", filename), rendered.bytes);
        pages.push({ id: `page-${String(number).padStart(3, "0")}`, page_number: number,
          volume: plan.volumes.indexOf(volume) + 1, source_page: sourcePage,
          source_pdf: volume.kind === "pdf" ? volume.path : null,
          image_path: `data/projects/${id}/pages/${filename}`,
          image_url: `/data/projects/${id}/pages/${filename}`,
          width: rendered.width, height: rendered.height });
        await onProgress?.({ completed: count, total: plan.page_count });
      }
    }
    abortIfNeeded(signal);
    const createdAt = new Date().toISOString();
    const project = { schema_version: 2, id, title: title.trim(),
      source: { volumes: plan.volumes, pages }, archived: false,
      active_result_id: "source", results: [{ id: "source", label: "原始页面", model: null,
        provider: "manual", archived: false, status: "pending", page_count: pages.length,
        completed_pages: 0, regions: 0 }], created_at: createdAt, updated_at: createdAt };
    const result = { id: "source", label: "原始页面", model: null, provider: "manual",
      archived: false, status: "pending", created_at: createdAt,
      pages: pages.map(page => ({ ...page, regions: [], status: "needs_review", ocr_status: "pending", revision: 0 })) };
    await fs.mkdir(path.join(stage, "results"));
    await fs.writeFile(path.join(stage, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    await fs.writeFile(path.join(stage, "results", "source.json"), `${JSON.stringify(result, null, 2)}\n`);
    await publishStage(stage, target);
    return project;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await adapters.dispose?.();
  }
}

export async function installSampleProject({ root, sampleDirectory, id }) {
  const target = verifyLocation(root, id);
  const stage = path.join(path.resolve(root), `.${id}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.cp(sampleDirectory, stage, { recursive: true, errorOnExist: true, force: false });
    const project = JSON.parse(await fs.readFile(path.join(stage, "project.json"), "utf8"));
    if (project.id !== id) throw new Error("Sample project id mismatch");
    await publishStage(stage, target);
    return project;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function createSampleProject(root) {
  const id = "sample-poetry";
  const canvas = createCanvas(850, 1200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6efdc";
  context.fillRect(0, 0, 850, 1200);
  context.fillStyle = "#30261c";
  context.font = "42px serif";
  context.fillText("诗笺示例", 300, 170);
  context.font = "34px serif";
  ["春日偶成", "云开见远山", "小径入花间", "静坐听风过", "清光照旧篇"].forEach((line, index) => {
    context.fillText(line, 270, 360 + index * 110);
  });
  const bytes = canvas.toBuffer("image/png");
  const project = await createImportedProject({ root, id, title: "诗笺示例", plan: {
    page_count: 1, volumes: [{ kind: "image", path: "sample.png", pages: 1, first_page: 1, last_page: 1, bytes: bytes.length }]
  }, adapters: { readImage: async () => ({ bytes, width: 850, height: 1200 }) } });
  const directory = path.join(root, id);
  const resultPath = path.join(directory, "results", "source.json");
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  result.status = "complete";
  result.pages[0].ocr_status = "complete";
  result.pages[0].regions = ["春日偶成", "云开见远山", "小径入花间", "静坐听风过", "清光照旧篇"]
    .map((line, index) => ({ id: `sample-${index + 1}`, order: index + 1, kind: index ? "main" : "title",
      bbox: [250, 320 + index * 110, 330, 60], raw_text: line, edited_text: line,
      status: "needs_review" }));
  project.results[0].status = "complete";
  project.results[0].completed_pages = 1;
  project.results[0].regions = result.pages[0].regions.length;
  const ebook = emptyEbook(project);
  ebook.source.result_ids = ["source"];
  ebook.entries = [{ id: "sample-poem", kind: "poem", title: "春日偶成", subtitle: "", author: "",
    form: "五绝", heading_level: null, series: null,
    lines: ["云开见远山", "小径入花间", "静坐听风过", "清光照旧篇"], prose: "", notes: [],
    source_pages: [1], evidence_refs: [], confidence: 1, review_status: "needs_review" }];
  await fs.mkdir(path.join(directory, "ebook"));
  await Promise.all([
    fs.writeFile(path.join(directory, "project.json"), `${JSON.stringify(project, null, 2)}\n`),
    fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`),
    fs.writeFile(path.join(directory, "ebook", "structured.json"), `${JSON.stringify(ebook, null, 2)}\n`)
  ]);
  return project;
}

export async function checkModelConnection({ baseUrl, apiKey, fetchImpl = fetch }) {
  if (!baseUrl || !apiKey) return { ok: false, reason: "missing_configuration" };
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: response.status === 401 || response.status === 403
      ? "invalid_credentials" : "service_error", status: response.status };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
