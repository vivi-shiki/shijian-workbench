import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "../../oldbook-core/src/change-history.mjs";
import { EbookStore } from "../../oldbook-core/src/ebook-store.mjs";
import { ProjectStore, safeId } from "../../oldbook-core/src/project-store.mjs";
import { orderRegionsByVerticalColumns } from "../../oldbook-core/src/reading-order.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const projectsRoot = path.join(rootDir, "data", "projects");
const history = new HistoryStore(projectsRoot);
const store = new ProjectStore(projectsRoot, history);

function parseArgs(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (!rest[index].startsWith("--")) continue;
    options[rest[index].slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
}

async function projectExists(projectId) {
  try { await fs.access(path.join(projectsRoot, projectId, "project.json")); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function comparisonVariants(start, end, version = "") {
  const prefix = `yiyuji-p${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")}`;
  const suffix = version ? `-${safeId(version)}` : "";
  const titleSuffix = version ? ` · 新验证流程 ${version}` : "";
  return [
    { id: `${prefix}-single-ocr${suffix}`, title: `疑雨集注 P${start}–${end} · 单 OCR${titleSuffix}`, result_ids: ["paddleocr-vl"] },
    { id: `${prefix}-dual-ocr${suffix}`, title: `疑雨集注 P${start}–${end} · 双 OCR${titleSuffix}`, result_ids: ["paddleocr-vl", "pp-ocrv6"] },
    { id: `${prefix}-dual-ocr-pp-ltr${suffix}`, title: `疑雨集注 P${start}–${end} · 双 OCR · PP上下左至右${titleSuffix}`, result_ids: ["paddleocr-vl", "pp-ocrv6-ltr"] }
  ];
}

async function prepareComparison({ sourceProjectId, start, end, version, variantId = "" }) {
  const sourceProject = await store.index(sourceProjectId);
  const sourcePages = (sourceProject.source?.pages || []).filter((page) => page.page_number >= start && page.page_number <= end);
  if (sourcePages.length !== end - start + 1) throw new Error("Source project does not cover the requested display range");
  const loadedResults = new Map();
  for (const resultId of ["paddleocr-vl", "pp-ocrv6"]) {
    loadedResults.set(resultId, JSON.parse(await fs.readFile(path.join(projectsRoot, sourceProjectId, "results", `${resultId}.json`), "utf8")));
  }
  const ppLtr = structuredClone(loadedResults.get("pp-ocrv6"));
  ppLtr.id = "pp-ocrv6-ltr";
  ppLtr.label = "PP-OCRv6 · 上下左至右排序";
  ppLtr.derived_from_result_id = "pp-ocrv6";
  ppLtr.derived_at = new Date().toISOString();
  ppLtr.workflow = { ...(ppLtr.workflow || {}), reading_order: "vertical-columns-ltr-v1" };
  ppLtr.pages = ppLtr.pages.map((page) => ({
    ...page,
    regions: orderRegionsByVerticalColumns(page.regions || [], "ltr")
  }));

  const resultById = new Map([...loadedResults, [ppLtr.id, ppLtr]]);
  const availableVariants = comparisonVariants(start, end, version);
  const selectedVariants = variantId ? availableVariants.filter(variant => variant.id === variantId) : availableVariants;
  if (!selectedVariants.length) throw new Error(`Unknown --variant ${variantId}`);
  const variants = selectedVariants.map(variant => ({
    ...variant, results: variant.result_ids.map(resultId => resultById.get(resultId))
  }));

  for (const variant of variants) {
    safeId(variant.id);
    if (await projectExists(variant.id)) throw new Error(`Experiment project already exists: ${variant.id}`);
    const source = {
      ...structuredClone(sourceProject.source),
      pages: structuredClone(sourcePages),
      book_title: sourceProject.title,
      derived_from: {
        project_id: sourceProjectId,
        page_range: { start, end },
        experiment: "ocr-evidence-comparison",
        workflow_version: version || "v1",
        created_at: new Date().toISOString()
      }
    };
    for (const result of variant.results) {
      await store.importResult(variant.id, {
        title: variant.title,
        source,
        result: structuredClone(result)
      }, {
        actor: "system",
        source: "ocr-comparison",
        note: `从 ${sourceProjectId} 派生 ${start}-${end} 页 OCR 对照实验`
      });
    }
  }
  return variants.map((variant) => ({ id: variant.id, title: variant.title, result_ids: variant.results.map((result) => result.id) }));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const start = Number(required(options, "from"));
  const end = Number(required(options, "to"));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error("Invalid page range");
  if (command === "prepare-ocr-comparison") {
    const variants = await prepareComparison({ sourceProjectId: safeId(required(options, "source-project")), start, end,
      version: options.version || "", variantId: options.variant || "" });
    console.log(JSON.stringify({ variants }, null, 2));
    return;
  }
  if (command === "archive-ocr-comparison") {
    const allVariants = comparisonVariants(start, end, options.version || "");
    const variants = options.variant ? allVariants.filter(variant => variant.id === options.variant) : allVariants;
    if (!variants.length) throw new Error(`Unknown --variant ${options.variant}`);
    for (const variant of variants) {
      if (!await projectExists(variant.id)) continue;
      await store.setArchived(variant.id, true, {
        actor: "system", source: "ocr-comparison",
        note: "归档旧 OCR 对照基线，保留用于新旧流程比较"
      });
    }
    console.log(JSON.stringify({ archived: variants.map(variant => variant.id) }, null, 2));
    return;
  }
  if (command === "run-ocr-comparison") {
    for (const name of [".env.local", ".env"]) {
      try { process.loadEnvFile(path.join(rootDir, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const allVariants = comparisonVariants(start, end, options.version || "");
    const variants = options.variant ? allVariants.filter(variant => variant.id === options.variant) : allVariants;
    if (!variants.length) throw new Error(`Unknown --variant ${options.variant}`);
    const ebookStore = new EbookStore(projectsRoot, store, history);
    const outputs = [];
    for (const variant of variants) {
      try {
        const { document } = await ebookStore.run(variant.id, {
          result_ids: variant.result_ids,
          start_page: start,
          end_page: end,
          force: true,
          include_learning_context: false,
          chunk_size: options["chunk-size"] ? Number(options["chunk-size"]) : undefined,
          model: options.model || undefined,
          pipeline: options.pipeline || undefined,
          resume_candidate: options["resume-candidate"] !== "false",
          resume_through: options["resume-through"] ? Number(options["resume-through"]) : undefined
        });
        outputs.push({ project_id: variant.id, status: document.generation.status,
          entries: document.entries.length, issues: document.issues.length,
          chunks: document.generation.chunks.length, model: document.generation.model });
      } catch (error) {
        outputs.push({ project_id: variant.id, status: "failed", error: error.message });
      }
    }
    console.log(JSON.stringify({ outputs }, null, 2));
    if (outputs.some((output) => output.status !== "complete")) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: experiment.mjs prepare-ocr-comparison|archive-ocr-comparison|run-ocr-comparison --from <page> --to <page> [--source-project <id>] [--version <id>] [--variant <project-id>] [--chunk-size <pages>] [--model <model-id>] [--pipeline <pipeline-id>] [--resume-through <page>]");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
