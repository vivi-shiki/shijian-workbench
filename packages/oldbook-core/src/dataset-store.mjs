import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeId } from "./project-store.mjs";

const DATASET_SCHEMA = 1;
const LINK_SCHEMA = 1;
const MATCH_PUNCTUATION = /[\p{P}\p{S}\s]/gu;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, json(value), "utf8");
}

export function normalizeForAlignment(value) {
  return String(value || "").normalize("NFKC").replace(MATCH_PUNCTUATION, "").toLowerCase();
}

function splitProse(value) {
  return String(value || "")
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [])
    .map((text) => text.trim())
    .filter(Boolean);
}

export function finalTextTargets(entries) {
  const targets = [];
  const add = (entry, field, text, index = null) => {
    if (!String(text || "").trim()) return;
    const suffix = index == null ? field : `${field}-${index}`;
    targets.push({
      id: `${entry.id}:${suffix}`,
      entry_id: entry.id,
      field,
      ...(index == null ? {} : { index }),
      text: String(text).trim(),
      normalized_text: normalizeForAlignment(text),
      source_pages: [...entry.source_pages]
    });
  };

  for (const entry of entries) {
    add(entry, "series", entry.series?.title);
    add(entry, "title", entry.title);
    add(entry, "subtitle", entry.subtitle);
    add(entry, "author", entry.author);
    (entry.lines || []).forEach((line, index) => add(entry, "line", line, index + 1));
    splitProse(entry.prose).forEach((segment, index) => add(entry, "prose", segment, index + 1));
    (entry.notes || []).forEach((note, index) => add(entry, "note", note?.text, index + 1));
  }
  return targets;
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function similarity(left, right) {
  const longest = Math.max(left.length, right.length);
  return longest ? 1 - levenshtein(left, right) / longest : 1;
}

function regionText(region) {
  return region.reading_text || region.edited_text || region.raw_text || "";
}

function sourceRef(result, page, region, matchMethod, score) {
  return {
    result_id: result.id,
    page_id: page.id,
    page_number: page.page_number,
    region_id: region.id,
    region_key: `${result.id}/${page.id}/${region.id}`,
    source_text: regionText(region),
    bbox: region.bbox,
    match_method: matchMethod,
    similarity: Number(score.toFixed(4))
  };
}

function exactStreamMatch(result, page, target) {
  const regions = [...page.regions].sort((a, b) => a.order - b.order);
  let stream = "";
  const spans = [];
  for (const region of regions) {
    const normalized = normalizeForAlignment(regionText(region));
    spans.push({ start: stream.length, end: stream.length + normalized.length, region });
    stream += normalized;
  }
  const start = stream.indexOf(target);
  if (start < 0) return [];
  const end = start + target.length;
  return spans
    .filter((span) => span.end > start && span.start < end)
    .map((span) => sourceRef(result, page, span.region, "exact-page-stream", 0.98));
}

function bestFuzzyRegion(result, page, target) {
  if (target.length < 3) return null;
  let best = null;
  for (const region of page.regions) {
    const source = normalizeForAlignment(regionText(region));
    if (!source) continue;
    const lengths = [...new Set([target.length - 2, target.length - 1, target.length, target.length + 1, target.length + 2])]
      .filter((length) => length > 0 && length <= source.length);
    if (!lengths.length) lengths.push(source.length);
    for (const length of lengths) {
      const limit = Math.max(0, source.length - length);
      for (let start = 0; start <= limit; start += 1) {
        const score = similarity(target, source.slice(start, start + length));
        if (!best || score > best.score) best = { score, region };
        if (score === 1) break;
      }
    }
  }
  const threshold = target.length === 3 ? 0.84 : 0.72;
  return best?.score >= threshold ? sourceRef(result, page, best.region, "fuzzy-region", best.score) : null;
}

function matchTargetToResult(target, result, pagesByNumber) {
  if (!target.normalized_text) return [];
  for (const pageNumber of target.source_pages) {
    const page = pagesByNumber.get(pageNumber);
    if (!page) continue;
    const exact = page.regions.find((region) => normalizeForAlignment(regionText(region)).includes(target.normalized_text));
    if (exact) return [sourceRef(result, page, exact, "exact-region", 1)];
    const stream = exactStreamMatch(result, page, target.normalized_text);
    if (stream.length) return stream;
  }
  let best = null;
  for (const pageNumber of target.source_pages) {
    const page = pagesByNumber.get(pageNumber);
    if (!page) continue;
    const match = bestFuzzyRegion(result, page, target.normalized_text);
    if (match && (!best || match.similarity > best.similarity)) best = match;
  }
  return best ? [best] : [];
}

export function buildAlignment(entries, results) {
  const targets = finalTextTargets(entries);
  const resultIndexes = new Map(results.map((result) => [
    result.id,
    new Map(result.pages.map((page) => [page.page_number, page]))
  ]));
  const byTarget = {};
  const byRegion = {};
  let linkedTargets = 0;
  let twoSourceTargets = 0;

  const links = targets.map((target) => {
    const sources = results.flatMap((result) => matchTargetToResult(target, result, resultIndexes.get(result.id)));
    if (sources.length) linkedTargets += 1;
    if (new Set(sources.map((source) => source.result_id)).size >= 2) twoSourceTargets += 1;
    byTarget[target.id] = sources;
    for (const source of sources) {
      if (!byRegion[source.region_key]) byRegion[source.region_key] = [];
      byRegion[source.region_key].push(target.id);
    }
    return {
      ...target,
      sources,
      status: sources.length ? "automatic" : "needs_review"
    };
  });

  return {
    schema_version: LINK_SCHEMA,
    generated_at: new Date().toISOString(),
    method: {
      name: "normalized-exact-then-fuzzy",
      normalization: "NFKC; remove punctuation, symbols, and whitespace; lowercase",
      fuzzy_threshold: { three_characters: 0.84, four_or_more: 0.72 },
      authority: "navigation aid only; source images and explicit human corrections remain authoritative"
    },
    summary: {
      targets: targets.length,
      linked_targets: linkedTargets,
      unlinked_targets: targets.length - linkedTargets,
      two_source_targets: twoSourceTargets,
      coverage: targets.length ? Number((linkedTargets / targets.length).toFixed(4)) : 0
    },
    links,
    by_target: byTarget,
    by_region: byRegion
  };
}

async function copyIfPresent(source, destination) {
  try {
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function walkFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

async function inventory(root, excluded = new Set()) {
  const files = (await walkFiles(root)).filter((filename) => !excluded.has(path.relative(root, filename).replaceAll("\\", "/")));
  const records = [];
  for (const filename of files.sort()) {
    const content = await fs.readFile(filename);
    records.push({
      path: path.relative(root, filename).replaceAll("\\", "/"),
      bytes: content.byteLength,
      sha256: crypto.createHash("sha256").update(content).digest("hex")
    });
  }
  return records;
}

function inRange(values, start, end) {
  return (values || []).some((value) => value >= start && value <= end);
}

function frozenDataPath(projectId, datasetId, ...parts) {
  return ["data", "projects", projectId, "datasets", datasetId, ...parts].join("/");
}

export class DatasetStore {
  constructor(projectsRoot, repositoryRoot = path.resolve(projectsRoot, "../..")) {
    this.projectsRoot = projectsRoot;
    this.repositoryRoot = repositoryRoot;
  }

  projectDirectory(projectId) {
    return path.join(this.projectsRoot, safeId(projectId));
  }

  datasetDirectory(projectId, datasetId) {
    return path.join(this.projectDirectory(projectId), "datasets", safeId(datasetId));
  }

  async list(projectId) {
    const root = path.join(this.projectDirectory(projectId), "datasets");
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const datasets = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try { datasets.push(await readJson(path.join(root, entry.name, "manifest.json"))); }
      catch { /* Ignore incomplete directories. */ }
    }
    return datasets.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async read(projectId, datasetId) {
    const root = this.datasetDirectory(projectId, datasetId);
    const [manifest, approval, links, ebook, project] = await Promise.all([
      readJson(path.join(root, "manifest.json")),
      readJson(path.join(root, "approval.json")),
      readJson(path.join(root, "links.json")),
      readJson(path.join(root, "ebook", "structured.json")),
      readJson(path.join(root, "project.json"))
    ]);
    const results = await Promise.all(manifest.result_ids.map((id) => readJson(path.join(root, "results", `${id}.json`))));
    return { manifest, approval, links, ebook, project, results };
  }

  async latest(projectId) {
    const datasets = await this.list(projectId);
    if (!datasets.length) throw Object.assign(new Error("Dataset not found"), { status: 404 });
    return this.read(projectId, datasets[0].id);
  }

  async verify(projectId, datasetId) {
    const root = this.datasetDirectory(projectId, datasetId);
    const [expected, manifest] = await Promise.all([
      readJson(path.join(root, "files.json")),
      readJson(path.join(root, "manifest.json"))
    ]);
    const actual = await inventory(root, new Set(["files.json", "manifest.json"]));
    const actualByPath = new Map(actual.map((file) => [file.path, file]));
    const mismatches = expected.files.filter((file) => {
      const found = actualByPath.get(file.path);
      return !found || found.bytes !== file.bytes || found.sha256 !== file.sha256;
    });
    const unexpected = actual.filter((file) => !expected.files.some((candidate) => candidate.path === file.path));
    const inventorySha256 = crypto.createHash("sha256").update(JSON.stringify(expected.files)).digest("hex");
    const manifestMatches = inventorySha256 === manifest.content_sha256;
    return {
      ok: !mismatches.length && !unexpected.length && manifestMatches,
      files: actual.length,
      manifest_matches: manifestMatches,
      mismatches,
      unexpected
    };
  }

  async freeze({ projectId, datasetId, pageStart, pageEnd, resultIds, approvalStatement, actor = "human" }) {
    safeId(projectId);
    safeId(datasetId);
    const start = Number(pageStart);
    const end = Number(pageEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("Invalid page range");
    }
    if (!Array.isArray(resultIds) || resultIds.length < 1) throw new Error("At least one result id is required");

    const projectRoot = this.projectDirectory(projectId);
    const datasetsRoot = path.join(projectRoot, "datasets");
    const destination = this.datasetDirectory(projectId, datasetId);
    const temp = path.join(datasetsRoot, `.${datasetId}.${process.pid}.tmp`);
    await fs.mkdir(datasetsRoot, { recursive: true });
    try {
      await fs.access(destination);
      throw Object.assign(new Error(`Dataset ${datasetId} already exists and is immutable`), { status: 409 });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { recursive: true });

    try {
      const project = await readJson(path.join(projectRoot, "project.json"));
      const sourcePages = (project.source?.pages || []).filter((page) => page.page_number >= start && page.page_number <= end);
      if (sourcePages.length !== end - start + 1) throw new Error("Project source pages do not cover the requested range");
      const frozenProject = {
        ...project,
        source: { ...project.source, pages: sourcePages.map((page) => ({
          ...page,
          image_path: frozenDataPath(projectId, datasetId, "pages", path.basename(page.image_path))
        })) }
      };
      await writeJson(path.join(temp, "project.json"), frozenProject);

      await fs.mkdir(path.join(temp, "pages"), { recursive: true });
      for (const page of sourcePages) {
        await fs.copyFile(path.resolve(this.repositoryRoot, page.image_path), path.join(temp, "pages", path.basename(page.image_path)));
      }

      const frozenResults = [];
      for (const resultId of resultIds) {
        safeId(resultId);
        const result = await readJson(path.join(projectRoot, "results", `${resultId}.json`));
        const pages = result.pages.filter((page) => page.page_number >= start && page.page_number <= end);
        if (pages.length !== end - start + 1) throw new Error(`${resultId} does not cover the requested range`);
        for (const page of pages) {
          await copyIfPresent(
            path.join(projectRoot, "ocr", resultId, page.id),
            path.join(temp, "ocr", resultId, page.id)
          );
        }
        const rewrittenPages = pages.map((page) => ({
          ...page,
          image_path: frozenDataPath(projectId, datasetId, "ocr", resultId, page.id, path.basename(page.image_path)),
          image_url: `/${frozenDataPath(projectId, datasetId, "ocr", resultId, page.id, path.basename(page.image_path))}`,
          source_image_path: frozenDataPath(projectId, datasetId, "pages", path.basename(page.source_image_path || `${page.id}.png`)),
          regions: page.regions.map((region) => ({
            ...region,
            source: region.source?.json ? {
              ...region.source,
              json: frozenDataPath(projectId, datasetId, "ocr", resultId, page.id, path.basename(region.source.json))
            } : region.source
          }))
        }));
        const frozenResult = { ...result, pages: rewrittenPages, page_count: rewrittenPages.length, completed_pages: rewrittenPages.length };
        frozenResults.push(frozenResult);
        await writeJson(path.join(temp, "results", `${resultId}.json`), frozenResult);
      }

      const ebook = await readJson(path.join(projectRoot, "ebook", "structured.json"));
      const entries = ebook.entries.filter((entry) => inRange(entry.source_pages, start, end));
      const entryIds = new Set(entries.map((entry) => entry.id));
      const issues = ebook.issues.filter((issue) => inRange(issue.source_pages, start, end) || entryIds.has(issue.entry_id));
      const frozenEbook = {
        ...ebook,
        source: { ...ebook.source, result_ids: [...resultIds], page_range: { start, end } },
        entries,
        issues
      };
      await writeJson(path.join(temp, "ebook", "structured.json"), frozenEbook);

      const links = buildAlignment(entries, frozenResults);
      await writeJson(path.join(temp, "links.json"), links);

      const createdAt = new Date().toISOString();
      const approval = {
        schema_version: 1,
        dataset_id: datasetId,
        decision: "accepted",
        scope: { kind: "reading_result", page_range: { start, end } },
        statement: approvalStatement,
        actor,
        recorded_by: "ai:codex",
        recorded_at: createdAt,
        limitations: [
          "This approval records satisfaction with the final reading result, not independent character-by-character verification against every page image.",
          "Unresolved issues remain explicit and are not silently converted into confirmed readings.",
          "Automatic OCR-to-final links are navigation evidence and require human review before use as exact supervision labels."
        ]
      };
      await writeJson(path.join(temp, "approval.json"), approval);
      await copyIfPresent(path.join(projectRoot, "history"), path.join(temp, "provenance", "history"));
      await copyIfPresent(path.join(projectRoot, "ai-memory"), path.join(temp, "provenance", "ai-memory"));
      await copyIfPresent(path.join(this.repositoryRoot, "docs", "ANNOTATION_SPEC.md"), path.join(temp, "specification", "ANNOTATION_SPEC.md"));
      await fs.writeFile(path.join(temp, "README.md"), `# ${datasetId}\n\nImmutable accepted snapshot for pages ${start}-${end}.\n\n- Approval: \`approval.json\`\n- OCR-to-final alignment: \`links.json\`\n- Integrity inventory: \`files.json\`\n- Original images: \`pages/\`\n- OCR evidence: \`ocr/\` and \`results/\`\n- Final structure: \`ebook/structured.json\`\n- Change evidence and AI memory at freeze time: \`provenance/\`\n`, "utf8");

      const files = await inventory(temp, new Set(["files.json", "manifest.json"]));
      const contentHash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
      await writeJson(path.join(temp, "files.json"), { schema_version: 1, algorithm: "sha256", files });
      const manifest = {
        schema_version: DATASET_SCHEMA,
        id: datasetId,
        project_id: projectId,
        title: `${project.title} P${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")}`,
        status: "frozen",
        created_at: createdAt,
        page_range: { start, end },
        page_count: end - start + 1,
        result_ids: [...resultIds],
        entry_count: entries.length,
        issue_count: issues.length,
        alignment: links.summary,
        content_sha256: contentHash
      };
      await writeJson(path.join(temp, "manifest.json"), manifest);
      await fs.rename(temp, destination);
      return manifest;
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
}
